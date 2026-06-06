use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tauri::Emitter;

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

#[derive(Deserialize, Default)]
struct FabricModJson {
    id: String,
    #[serde(default)]
    depends: HashMap<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct ModrinthVersion {
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

fn read_fabric_mod_json(jar_path: &std::path::Path) -> Option<FabricModJson> {
    use std::io::Read;
    let bytes = std::fs::read(jar_path).ok()?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).ok()?;
    let mut entry = archive.by_name("fabric.mod.json").ok()?;
    let mut content = String::new();
    entry.read_to_string(&mut content).ok()?;
    serde_json::from_str(&content).ok()
}

async fn scan_installed_ids(mods_dir: &PathBuf) -> HashSet<String> {
    let mut ids = HashSet::new();
    // Fabric API est gérée séparément — considérée toujours présente
    ids.insert("fabric-api".to_string());

    if let Ok(mut entries) = tokio::fs::read_dir(mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if !name.ends_with(".jar") {
                continue;
            }
            if let Some(meta) = read_fabric_mod_json(&path) {
                ids.insert(meta.id);
            }
        }
    }

    ids
}

async fn collect_missing_deps(
    mods_dir: &PathBuf,
    installed: &HashSet<String>,
    already_tried: &HashSet<String>,
) -> Vec<String> {
    let mut missing: Vec<String> = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(mods_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            if !name.ends_with(".jar") {
                continue;
            }
            let Some(meta) = read_fabric_mod_json(&path) else { continue };
            for dep_id in meta.depends.keys() {
                if BUILTIN_IDS.contains(&dep_id.as_str()) {
                    continue;
                }
                if installed.contains(dep_id) || already_tried.contains(dep_id) {
                    continue;
                }
                if !missing.contains(dep_id) {
                    missing.push(dep_id.clone());
                }
            }
        }
    }

    missing
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
    dep_id: &str,
    mc_version: &str,
    loader: &str,
    mods_dir: &PathBuf,
) -> Result<String> {
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

    let version = versions
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("Aucune version compatible pour «{}» (MC {}, {})", dep_id, mc_version, loader))?;

    let file = version
        .files
        .into_iter()
        .find(|f| f.primary)
        .ok_or_else(|| anyhow!("Pas de fichier principal pour «{}»", dep_id))?;

    let bytes = client.get(&file.url).send().await?.bytes().await?;
    tokio::fs::write(mods_dir.join(&file.filename), &bytes).await?;

    Ok(file.filename)
}

/// Résout et installe les dépendances manquantes pour tous les mods Fabric du dossier.
/// Itère jusqu'à ce qu'il n'y ait plus rien à installer (max 10 passes).
pub async fn resolve_and_install_deps(
    mc_version: &str,
    loader: &str,
    mods_dir: &PathBuf,
    app: &tauri::AppHandle,
) -> Result<()> {
    if !mods_dir.exists() {
        return Ok(());
    }

    let client = reqwest::Client::builder()
        .user_agent("YuyuFrame/1.0")
        .build()?;

    let mut already_tried: HashSet<String> = HashSet::new();

    for _ in 0..10 {
        let installed = scan_installed_ids(mods_dir).await;
        let missing = collect_missing_deps(mods_dir, &installed, &already_tried).await;

        if missing.is_empty() {
            break;
        }

        for dep_id in missing {
            already_tried.insert(dep_id.clone());

            let _ = app.emit(
                "download_progress",
                serde_json::json!({
                    "current": 0,
                    "total": 100,
                    "message": format!("Dépendance : installation de {}…", dep_id)
                }),
            );

            match install_dep(&client, &dep_id, mc_version, loader, mods_dir).await {
                Ok(filename) => tracing::info!("Dépendance installée : {}", filename),
                Err(e) => tracing::warn!("Impossible d'installer «{}» : {}", dep_id, e),
            }
        }
    }

    Ok(())
}
