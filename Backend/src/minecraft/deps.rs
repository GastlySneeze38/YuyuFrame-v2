use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::Emitter;

use super::version_pred::{
    normalize_version, parse_predicate_groups, read_fabric_mod_json, version_allowed,
};

const MODRINTH_API: &str = "https://api.modrinth.com/v2";

// IDs gérés par le loader ou intégrés à Minecraft — on ne tente pas de les télécharger
const BUILTIN_IDS: &[&str] = &[
    "minecraft",
    "fabricloader",
    "fabric-loader",
    "java",
    "forge",
    "neoforge",
    "quilt_loader",
    "quilt-loader",
];

#[derive(Deserialize)]
struct ModrinthVersion {
    version_number: String,
    files: Vec<ModrinthFile>,
}

#[derive(Deserialize)]
struct ModrinthFile {
    url: String,
    filename: String,
    primary: bool,
}

#[derive(Deserialize)]
struct ModrinthSearchResult {
    hits: Vec<ModrinthHit>,
}

#[derive(Deserialize)]
struct ModrinthHit {
    project_id: String,
}

/// Mod installé localement, avec sa version déclarée et son fichier jar.
struct InstalledMod {
    version: String,
    path: PathBuf,
}

async fn scan_installed(mods_dir: &PathBuf) -> HashMap<String, InstalledMod> {
    let mut installed = HashMap::new();
    // Fabric API est gérée séparément — considérée toujours présente et compatible
    installed.insert(
        "fabric-api".to_string(),
        InstalledMod { version: String::new(), path: PathBuf::new() },
    );

    if let Ok(mut entries) = tokio::fs::read_dir(mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if !name.ends_with(".jar") {
                continue;
            }
            if let Some(meta) = read_fabric_mod_json(&path) {
                installed.insert(meta.id, InstalledMod { version: meta.version, path });
            }
        }
    }

    installed
}

struct MissingDep {
    id: String,
    /// Plages requises (`depends`) — au moins un groupe OR doit être satisfait.
    depends_groups: Vec<Vec<String>>,
    /// Versions explicitement cassées (`breaks`) — aucun groupe ne doit matcher.
    breaks_groups: Vec<Vec<String>>,
    /// Jar existant mais incompatible, à supprimer avant réinstallation.
    replace_path: Option<PathBuf>,
}

async fn collect_missing_deps(
    mods_dir: &PathBuf,
    installed: &HashMap<String, InstalledMod>,
    already_tried: &HashSet<String>,
    mc_version: &str,
    loader: &str,
) -> Vec<MissingDep> {
    let mut missing: Vec<MissingDep> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();

    if let Ok(mut entries) = tokio::fs::read_dir(mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if !name.ends_with(".jar") {
                continue;
            }
            let Some(meta) = read_fabric_mod_json(&path) else { continue };
            for (dep_id, predicate_value) in &meta.depends {
                if BUILTIN_IDS.contains(&dep_id.as_str()) {
                    continue;
                }
                if already_tried.contains(dep_id) || seen_ids.contains(dep_id) {
                    continue;
                }

                let depends_groups = parse_predicate_groups(predicate_value);
                let breaks_groups = meta
                    .breaks
                    .get(dep_id)
                    .map(parse_predicate_groups)
                    .unwrap_or_default();

                match installed.get(dep_id) {
                    Some(found) if found.version.is_empty() => {
                        // fabric-api : pas de version suivie, on suppose compatible
                        continue;
                    }
                    Some(found) if version_allowed(
                        &normalize_version(&found.version, mc_version, loader),
                        &depends_groups,
                        &breaks_groups,
                    ) => {
                        continue;
                    }
                    Some(found) => {
                        // Présent mais version incompatible : à remplacer
                        seen_ids.insert(dep_id.clone());
                        missing.push(MissingDep {
                            id: dep_id.clone(),
                            depends_groups,
                            breaks_groups,
                            replace_path: Some(found.path.clone()),
                        });
                    }
                    None => {
                        seen_ids.insert(dep_id.clone());
                        missing.push(MissingDep {
                            id: dep_id.clone(),
                            depends_groups,
                            breaks_groups,
                            replace_path: None,
                        });
                    }
                }
            }
        }
    }

    missing
}

/// Détecte une version pré-release (beta/alpha/rc/pre/snapshot) par ses
/// segments dot/dash/plus-séparés — évite les faux positifs sur des mots qui
/// contiennent juste ces lettres ailleurs dans la chaîne.
fn is_beta_version(version: &str) -> bool {
    version.split(['.', '-', '+']).any(|seg| {
        let l = seg.to_ascii_lowercase();
        ["alpha", "beta", "rc", "pre", "snapshot"]
            .iter()
            .any(|kw| l.starts_with(kw))
    })
}

async fn fetch_versions_for_slug(
    client: &reqwest::Client,
    slug: &str,
    mc_version: &str,
    loader: &str,
) -> Option<Vec<ModrinthVersion>> {
    let url = format!(
        "{}/project/{}/version?game_versions=[\"{}\"]&loaders=[\"{}\"]",
        MODRINTH_API, slug, mc_version, loader
    );
    let resp = client.get(&url).send().await.ok()?;
    if resp.status().is_success() {
        resp.json::<Vec<ModrinthVersion>>().await.ok()
    } else {
        None
    }
}

async fn install_dep(
    client: &reqwest::Client,
    dep: &MissingDep,
    mc_version: &str,
    loader: &str,
    mods_dir: &PathBuf,
    avoid_beta: bool,
) -> Result<String> {
    let dep_id = &dep.id;

    // Tentative directe par slug Modrinth (correspond souvent au mod ID Fabric)
    let versions = if let Some(v) = fetch_versions_for_slug(client, dep_id, mc_version, loader).await {
        v
    } else {
        // Fallback : recherche textuelle
        let search_url = format!(
            "{}/search?query={}&facets=[[\"project_type:mod\"],[\"versions:{}\"],[\"categories:{}\"]]\
&limit=3",
            MODRINTH_API, dep_id, mc_version, loader
        );
        let results: ModrinthSearchResult = client
            .get(&search_url)
            .send()
            .await?
            .json()
            .await
            .map_err(|_| anyhow!("Aucun résultat de recherche pour «{}»", dep_id))?;

        let hit = results
            .hits
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("Mod «{}» introuvable sur Modrinth", dep_id))?;

        fetch_versions_for_slug(client, &hit.project_id, mc_version, loader)
            .await
            .unwrap_or_default()
    };

    // Modrinth renvoie les versions du plus récent au plus ancien : on prend la
    // première qui satisfait réellement la contrainte déclarée par le mod
    // dépendant (`depends`) sans tomber dans une version explicitement cassée
    // (`breaks`), plutôt que de prendre la plus récente sans vérification.
    let compatible: Vec<ModrinthVersion> = versions
        .into_iter()
        .filter(|v| {
            let normalized = normalize_version(&v.version_number, mc_version, loader);
            version_allowed(&normalized, &dep.depends_groups, &dep.breaks_groups)
        })
        .collect();

    // « Éviter les dépendances beta » (réglage launcher) : une version beta
    // n'est souvent pas encore supportée par les autres mods qui en dépendent
    // (cas Sodium 0.8.13-beta + Voxy) — on ne l'installe jamais automatiquement,
    // même si elle matche la plage de versions déclarée.
    let version = if avoid_beta {
        compatible.into_iter().find(|v| {
            !is_beta_version(&normalize_version(&v.version_number, mc_version, loader))
        })
    } else {
        compatible.into_iter().next()
    }
    .ok_or_else(|| {
        anyhow!(
            "Aucune version {}compatible pour «{}» (MC {}, {}, depends {:?}, breaks {:?})",
            if avoid_beta { "stable " } else { "" },
            dep_id, mc_version, loader, dep.depends_groups, dep.breaks_groups
        )
    })?;

    let file = version
        .files
        .into_iter()
        .find(|f| f.primary)
        .ok_or_else(|| anyhow!("Pas de fichier principal pour «{}»", dep_id))?;

    if let Some(old_path) = &dep.replace_path {
        let _ = tokio::fs::remove_file(old_path).await;
    }

    let bytes = client.get(&file.url).send().await?.bytes().await?;
    tokio::fs::write(mods_dir.join(&file.filename), &bytes).await?;

    Ok(file.filename)
}

/// Résout et installe les dépendances manquantes ou incompatibles pour tous les
/// mods Fabric du dossier, en respectant les contraintes de version qu'ils
/// déclarent. Itère jusqu'à ce qu'il n'y ait plus rien à installer (max 10 passes).
pub async fn resolve_and_install_deps(
    mc_version: &str,
    loader: &str,
    mods_dir: &PathBuf,
    app: &tauri::AppHandle,
    avoid_beta: bool,
) -> Result<()> {
    if !mods_dir.exists() {
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .user_agent("YuyuFrame/1.0")
        .build()?;

    let mut already_tried: HashSet<String> = HashSet::new();

    for _ in 0..10 {
        let installed = scan_installed(mods_dir).await;
        let missing = collect_missing_deps(mods_dir, &installed, &already_tried, mc_version, loader).await;

        if missing.is_empty() {
            break;
        }

        for dep in missing {
            already_tried.insert(dep.id.clone());

            let _ = app.emit(
                "download_progress",
                serde_json::json!({
                    "current": 0,
                    "total": 100,
                    "message": format!("Dépendance : installation de {}…", dep.id)
                }),
            );

            match install_dep(&client, &dep, mc_version, loader, mods_dir, avoid_beta).await {
                Ok(filename) => tracing::info!("Dépendance installée : {}", filename),
                Err(e) => tracing::warn!("Impossible d'installer «{}» : {}", dep.id, e),
            }
        }
    }

    Ok(())
}
