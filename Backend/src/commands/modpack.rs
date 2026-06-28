use serde::{Deserialize, Serialize};
use std::io::Read;

use crate::commands::instances::instance_dir;
use crate::minecraft::version_pred::read_fabric_mod_json;

/// Indexe les mods déjà présents par leur id `fabric.mod.json` — sert à détecter
/// les doublons (ex: "Fabric API" déjà installé en extra + ré-installé par le pack).
/// Best-effort : un mod sans `fabric.mod.json` (Forge, plugin...) n'est pas dédupliqué.
fn collect_mod_ids(mods_dir: &std::path::Path) -> std::collections::HashMap<String, std::path::PathBuf> {
    let mut map = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir(mods_dir) else { return map };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !name.ends_with(".jar") && !name.ends_with(".jar.disabled") {
            continue;
        }
        if let Some(meta) = read_fabric_mod_json(&path) {
            map.insert(meta.id, path);
        }
    }
    map
}

/// Dossier caché (ignoré par `mods_list`, qui ne liste que les `.jar`) où sont
/// déplacés — au lieu d'être supprimés — les mods "extra" en conflit avec le pack.
fn backup_dir(mods_dir: &std::path::Path) -> std::path::PathBuf {
    mods_dir.join(".pack_backup")
}

#[derive(Serialize, Deserialize, Default)]
struct ModpackBackup {
    files: Vec<String>,
}

fn backup_json_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("modpack_backup.json")
}

/// Remet en place les mods "extra" déplacés lors d'une précédente installation
/// de pack (conflits d'id), puis efface la trace de sauvegarde. Best-effort.
fn restore_backup(dir: &std::path::Path) {
    let backup_path = backup_json_path(dir);
    let Ok(json) = std::fs::read_to_string(&backup_path) else { return };
    let Ok(backup) = serde_json::from_str::<ModpackBackup>(&json) else { return };
    let mods_dir = dir.join("mods");
    let bdir = backup_dir(&mods_dir);
    for file in &backup.files {
        let src = bdir.join(file);
        if !src.exists() {
            continue;
        }
        let dst = mods_dir.join(file);
        let _ = std::fs::remove_file(&dst);
        let _ = std::fs::rename(&src, &dst);
    }
    let _ = std::fs::remove_file(&backup_path);
    let _ = std::fs::remove_dir(&bdir);
}

/// Métadonnées persistées dans `modpack.json` à la racine d'une instance créée
/// depuis un modpack Modrinth (.mrpack). Pilote la bannière + la séparation
/// "contenu du modpack" / "contenu supplémentaire" côté UI.
#[derive(Serialize, Deserialize, Clone)]
pub struct ModpackMeta {
    pub project_id: String,
    pub version_id: String,
    pub name: String,
    pub author: String,
    pub summary: String,
    pub icon_url: Option<String>,
    pub version_number: String,
    pub downloads: u64,
    pub date_modified: Option<String>,
    pub categories: Vec<String>,
    /// Noms de fichiers (basename) installés par le modpack — sert à distinguer
    /// le contenu du pack du contenu ajouté manuellement par l'utilisateur.
    pub mod_files: Vec<String>,
}

#[derive(Deserialize)]
struct IndexFile {
    path: String,
    downloads: Vec<String>,
}

#[derive(Deserialize)]
struct ModrinthIndex {
    files: Vec<IndexFile>,
    #[serde(default)]
    dependencies: std::collections::HashMap<String, String>,
}

#[derive(Serialize)]
pub struct ModpackIndexInfo {
    pub mc_version: Option<String>,
    pub loader: String,
}

fn loader_from_dependencies(deps: &std::collections::HashMap<String, String>) -> String {
    if deps.contains_key("fabric-loader") || deps.contains_key("quilt-loader") {
        "fabric".to_string()
    } else if deps.contains_key("forge") || deps.contains_key("neoforge") {
        "forge".to_string()
    } else {
        "vanilla".to_string()
    }
}

fn check_modrinth_url(url: &str) -> Result<(), String> {
    if !url.starts_with("https://cdn.modrinth.com/") {
        return Err("URL non autorisée".into());
    }
    Ok(())
}

async fn download_mrpack(url: &str) -> Result<Vec<u8>, String> {
    check_modrinth_url(url)?;
    let client = reqwest::Client::builder()
        .user_agent("YuyuFrame/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Téléchargement échoué: {}", resp.status()));
    }
    Ok(resp.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

fn read_index(bytes: &[u8]) -> Result<ModrinthIndex, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let mut entry = archive
        .by_name("modrinth.index.json")
        .map_err(|_| "modrinth.index.json introuvable dans le .mrpack".to_string())?;
    let mut content = String::new();
    entry.read_to_string(&mut content).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn modpack_fetch_index(file_url: String) -> Result<ModpackIndexInfo, String> {
    let bytes = download_mrpack(&file_url).await?;
    let index = tokio::task::spawn_blocking(move || read_index(&bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok(ModpackIndexInfo {
        mc_version: index.dependencies.get("minecraft").cloned(),
        loader: loader_from_dependencies(&index.dependencies),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackInstallInput {
    pub instance_id: String,
    pub file_url: String,
    pub project_id: String,
    pub version_id: String,
    pub name: String,
    pub author: String,
    pub summary: String,
    pub icon_url: Option<String>,
    pub version_number: String,
    pub downloads: u64,
    pub date_modified: Option<String>,
    pub categories: Vec<String>,
}

fn extract_into_instance(bytes: &[u8], dir: &std::path::Path) -> Result<Vec<String>, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    // overrides/ d'abord, client-overrides/ ensuite pour qu'il ait la priorité.
    for prefix in ["overrides/", "client-overrides/"] {
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            let Some(rel) = name.strip_prefix(prefix) else { continue };
            if rel.is_empty() || name.ends_with('/') {
                continue;
            }
            let dest = rel.split('/').fold(dir.to_path_buf(), |acc, c| acc.join(c));
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }

    let index = read_index(bytes)?;
    Ok(index
        .files
        .iter()
        .filter(|f| f.path.starts_with("mods/"))
        .filter_map(|f| f.path.rsplit('/').next().map(|s| s.to_string()))
        .collect())
}

#[tauri::command]
pub async fn modpack_install(input: ModpackInstallInput) -> Result<ModpackMeta, String> {
    let bytes = download_mrpack(&input.file_url).await?;

    let dir = instance_dir(&input.instance_id);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    // Remplacement d'un pack précédent : on restaure d'abord les extras qu'il
    // avait éventuellement mis de côté, avant de recalculer les conflits avec
    // le nouveau pack (sinon ils restent piégés dans le dossier de backup).
    {
        let dir_clone = dir.clone();
        tokio::task::spawn_blocking(move || restore_backup(&dir_clone))
            .await
            .map_err(|e| e.to_string())?;
    }

    let index = {
        let bytes = bytes.clone();
        tokio::task::spawn_blocking(move || read_index(&bytes))
            .await
            .map_err(|e| e.to_string())??
    };

    // Snapshot des mods déjà présents (extras + ancien pack le cas échéant) pour
    // détecter les doublons avec ce que le pack va installer (ex: 2x Fabric API).
    let mods_dir = dir.join("mods");
    let existing_ids = collect_mod_ids(&mods_dir);

    // Téléchargement des fichiers référencés (mods, resourcepacks, shaderpacks...).
    let client = reqwest::Client::builder()
        .user_agent("YuyuFrame/1.0")
        .build()
        .map_err(|e| e.to_string())?;
    let mut backed_up: Vec<String> = Vec::new();
    for file in &index.files {
        let Some(url) = file.downloads.first() else { continue };
        if check_modrinth_url(url).is_err() {
            continue;
        }
        let dest = file.path.split('/').fold(dir.clone(), |acc, c| acc.join(c));
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            continue;
        }
        let data = resp.bytes().await.map_err(|e| e.to_string())?;
        tokio::fs::write(&dest, &data).await.map_err(|e| e.to_string())?;

        if file.path.starts_with("mods/") {
            if let Some(new_meta) = read_fabric_mod_json(&dest) {
                if let Some(existing_path) = existing_ids.get(&new_meta.id) {
                    if existing_path != &dest {
                        // Conflit (ex: 2x Fabric API) : on déplace l'extra en
                        // backup plutôt que de le supprimer, pour pouvoir le
                        // réinstaller au retrait/remplacement du pack.
                        if let Some(filename) = existing_path.file_name().map(|f| f.to_string_lossy().to_string()) {
                            let bdir = backup_dir(&mods_dir);
                            if std::fs::create_dir_all(&bdir).is_ok() {
                                let bdest = bdir.join(&filename);
                                let _ = std::fs::remove_file(&bdest);
                                if std::fs::rename(existing_path, &bdest).is_ok() {
                                    backed_up.push(filename);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if !backed_up.is_empty() {
        let json = serde_json::to_string_pretty(&ModpackBackup { files: backed_up }).map_err(|e| e.to_string())?;
        tokio::fs::write(backup_json_path(&dir), json).await.map_err(|e| e.to_string())?;
    }

    let dir_clone = dir.clone();
    let bytes_clone = bytes.clone();
    let mod_files = tokio::task::spawn_blocking(move || extract_into_instance(&bytes_clone, &dir_clone))
        .await
        .map_err(|e| e.to_string())??;

    let meta = ModpackMeta {
        project_id: input.project_id,
        version_id: input.version_id,
        name: input.name,
        author: input.author,
        summary: input.summary,
        icon_url: input.icon_url,
        version_number: input.version_number,
        downloads: input.downloads,
        date_modified: input.date_modified,
        categories: input.categories,
        mod_files,
    };

    let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    tokio::fs::write(dir.join("modpack.json"), json)
        .await
        .map_err(|e| e.to_string())?;

    Ok(meta)
}

/// Retire le modpack de l'instance : désinstalle les mods listés dans
/// `modpack.json` (et leur variante `.disabled`), restaure les extras mis de
/// côté lors d'un conflit, puis supprime les fichiers de métadonnées.
/// Le contenu supplémentaire jamais entré en conflit n'est pas touché.
#[tauri::command]
pub async fn modpack_remove(instance_id: String) -> Result<(), String> {
    let dir = instance_dir(&instance_id);
    let path = dir.join("modpack.json");
    if path.exists() {
        if let Ok(json) = tokio::fs::read_to_string(&path).await {
            if let Ok(meta) = serde_json::from_str::<ModpackMeta>(&json) {
                let mods_dir = dir.join("mods");
                for file in &meta.mod_files {
                    let _ = tokio::fs::remove_file(mods_dir.join(file)).await;
                    let _ = tokio::fs::remove_file(mods_dir.join(format!("{}.disabled", file))).await;
                }
            }
        }
        tokio::fs::remove_file(&path).await.map_err(|e| e.to_string())?;
    }

    let dir_clone = dir.clone();
    tokio::task::spawn_blocking(move || restore_backup(&dir_clone))
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Met à jour la référence d'un fichier dans `modpack.json` quand un mod du
/// pack est mis à jour (le nouveau fichier peut avoir un nom différent).
/// No-op si `old_name` n'appartenait pas au pack.
#[tauri::command]
pub async fn modpack_rename_file(
    instance_id: String,
    old_name: String,
    new_name: String,
) -> Result<Option<ModpackMeta>, String> {
    let path = instance_dir(&instance_id).join("modpack.json");
    if !path.exists() {
        return Ok(None);
    }
    let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    let mut meta: ModpackMeta = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    let Some(pos) = meta.mod_files.iter().position(|f| f == &old_name) else {
        return Ok(Some(meta));
    };
    if old_name != new_name {
        meta.mod_files[pos] = new_name;
        let json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
        tokio::fs::write(&path, json).await.map_err(|e| e.to_string())?;
    }
    Ok(Some(meta))
}

#[tauri::command]
pub async fn modpack_get_meta(instance_id: String) -> Result<Option<ModpackMeta>, String> {
    let path = instance_dir(&instance_id).join("modpack.json");
    if !path.exists() {
        return Ok(None);
    }
    let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    serde_json::from_str(&json).map(Some).map_err(|e| e.to_string())
}
