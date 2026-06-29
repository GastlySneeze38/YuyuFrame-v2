use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use tauri::Emitter;

use crate::state::SharedState;
use super::instances::instance_dir;
use super::mods::sha1_cached;

fn api_base() -> String {
    std::env::var("YUYU_API_URL").unwrap_or_else(|_| "http://localhost:3000".into())
}

// ── Types exposés au frontend ──────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct SyncInstance {
    pub id: i64,
    pub instance_name: String,
    pub mc_version: String,
    pub loader: String,
    pub ram_mb: u32,
    pub save_count: u32,
    pub save_names: Vec<String>,
    pub has_data: bool,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
pub struct SaveInfo {
    pub name: String,
    pub updated_at: i64,
    pub size_bytes: u64,
}

#[derive(Serialize, Clone)]
pub struct SyncProgressEvent {
    pub phase: String, // "resolving_mods"|"compressing"|"uploading"|"downloading"|"installing_mods"|"done"
    pub percent: u8,
    pub label: String,
}

// ── Manifest de mods ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct ModrinthRef {
    pub project_id: String,
    pub version_id: String,
    pub download_url: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ModManifestEntry {
    /// Nom propre du fichier (sans le suffixe .disabled)
    pub filename: String,
    pub sha1: String,
    pub enabled: bool,
    /// None = mod non trouvé sur Modrinth (inclus dans le ZIP)
    pub modrinth: Option<ModrinthRef>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ModpackRef {
    pub project_id: String,
    pub version_id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ModManifest {
    pub format_version: u32,
    pub mc_version: String,
    pub loader: String,
    pub modpack: Option<ModpackRef>,
    pub mods: Vec<ModManifestEntry>,
}

// ── Auth helpers ───────────────────────────────────────────────────────────────

fn get_token(state: &crate::state::AppState) -> Result<String, String> {
    state
        .yuyu_session
        .as_ref()
        .map(|s| s.token.clone())
        .ok_or_else(|| "Non connecté à YuyuFrame".into())
}

fn require_premium(state: &crate::state::AppState) -> Result<(), String> {
    let session = state
        .yuyu_session
        .as_ref()
        .ok_or_else(|| String::from("Non connecté à YuyuFrame"))?;
    if !session.is_premium() {
        return Err(String::from("Abonnement Premium requis pour la synchronisation"));
    }
    Ok(())
}

#[allow(dead_code)]
fn require_ultimate(state: &crate::state::AppState) -> Result<(), String> {
    let session = state
        .yuyu_session
        .as_ref()
        .ok_or_else(|| String::from("Non connecté à YuyuFrame"))?;
    if !session.is_ultimate() {
        return Err(String::from("Abonnement Ultimate requis pour cette fonctionnalité"));
    }
    Ok(())
}

// ── Save listing ───────────────────────────────────────────────────────────────

fn dir_size(path: &PathBuf) -> u64 {
    let mut size = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                size += std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            } else if p.is_dir() {
                size += dir_size(&p);
            }
        }
    }
    size
}

#[tauri::command]
pub async fn sync_list_saves(instance_id: String) -> Result<Vec<SaveInfo>, String> {
    let saves_dir = instance_dir(&instance_id).join("saves");
    if !saves_dir.is_dir() {
        return Ok(vec![]);
    }

    let mut saves: Vec<SaveInfo> = std::fs::read_dir(&saves_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            let meta = std::fs::metadata(&path).ok()?;
            let updated_at = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let size_bytes = dir_size(&path);
            Some(SaveInfo { name, updated_at, size_bytes })
        })
        .collect();

    saves.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(saves)
}

// ── Mod manifest helpers ───────────────────────────────────────────────────────

/// Lit le modpack.json de l'instance pour récupérer les infos Modrinth du pack.
fn read_modpack_ref(inst_dir: &PathBuf) -> Option<ModpackRef> {
    let json = std::fs::read_to_string(inst_dir.join("modpack.json")).ok()?;
    #[derive(Deserialize)]
    struct PackMeta { project_id: String, version_id: String, name: String }
    let m: PackMeta = serde_json::from_str(&json).ok()?;
    Some(ModpackRef { project_id: m.project_id, version_id: m.version_id, name: m.name })
}

/// Liste tous les mods d'une instance.
/// Retourne (nom_propre_sans_disabled, sha1, enabled).
fn list_mods_raw(mods_dir: &PathBuf) -> Vec<(String, String, bool)> {
    let Ok(entries) = std::fs::read_dir(mods_dir) else { return vec![] };
    entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let raw = path.file_name()?.to_str()?.to_string();
            let enabled = raw.ends_with(".jar");
            let disabled = raw.ends_with(".jar.disabled");
            if !enabled && !disabled { return None; }
            let clean = if disabled {
                raw.trim_end_matches(".disabled").to_string()
            } else {
                raw.clone()
            };
            let sha1 = sha1_cached(&path);
            Some((clean, sha1, enabled))
        })
        .collect()
}

/// Batch lookup Modrinth par SHA1.
/// Retourne un map sha1 → (project_id, version_id, download_url).
async fn modrinth_lookup_batch(
    client: &reqwest::Client,
    sha1s: &[String],
) -> HashMap<String, (String, String, String)> {
    if sha1s.is_empty() {
        return HashMap::new();
    }
    let resp = client
        .post("https://api.modrinth.com/v2/version_files")
        .header("User-Agent", "YuyuFrame/1.0")
        .json(&serde_json::json!({ "hashes": sha1s, "algorithm": "sha1" }))
        .send()
        .await;

    let Ok(resp) = resp else { return HashMap::new() };
    if !resp.status().is_success() { return HashMap::new(); }
    let Ok(json) = resp.json::<serde_json::Value>().await else { return HashMap::new() };
    let Some(obj) = json.as_object() else { return HashMap::new() };

    let mut result = HashMap::new();
    for (hash, version) in obj {
        let Some(project_id) = version["project_id"].as_str() else { continue };
        let Some(version_id) = version["id"].as_str() else { continue };
        let files = version["files"].as_array();
        let download_url = files
            .and_then(|f| f.iter().find(|file| file["primary"].as_bool().unwrap_or(false)))
            .or_else(|| files.and_then(|f| f.first()))
            .and_then(|f| f["url"].as_str());
        let Some(url) = download_url else { continue };
        // Sécurité : on n'accepte que les URLs Modrinth CDN
        if !url.starts_with("https://cdn.modrinth.com/") { continue; }
        result.insert(
            hash.clone(),
            (project_id.to_string(), version_id.to_string(), url.to_string()),
        );
    }
    result
}

// ── ZIP helpers ────────────────────────────────────────────────────────────────

fn collect_files(
    dir: &PathBuf,
    base: &PathBuf,
    prefix: &str,
    out: &mut Vec<(PathBuf, String)>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let relative = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let zip_path = format!("{}/{}", prefix, relative);

        if path.is_dir() {
            out.push((path.clone(), format!("{}/", zip_path)));
            collect_files(&path, base, prefix, out)?;
        } else {
            out.push((path, zip_path));
        }
    }
    Ok(())
}

fn build_instance_zip_with_progress(
    inst_dir: PathBuf,
    save_names: Vec<String>,
    manifest: ModManifest,
    tx: tokio::sync::mpsc::Sender<SyncProgressEvent>,
) -> Result<Vec<u8>, String> {
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    // Mods non-Modrinth (à inclure dans le ZIP tel quel)
    let manual_filenames: std::collections::HashSet<String> = manifest.mods.iter()
        .filter(|m| m.modrinth.is_none())
        .map(|m| m.filename.clone())
        .collect();

    let mut files: Vec<(PathBuf, String)> = Vec::new();

    // Inclure les mods manuels (avec leur suffixe .disabled si nécessaire)
    let mods_dir = inst_dir.join("mods");
    if mods_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&mods_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let raw = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let clean = raw.trim_end_matches(".disabled").to_string();
                if manual_filenames.contains(&clean) {
                    files.push((path, format!("mods/{}", raw)));
                }
            }
        }
    }

    // config/
    let config_dir = inst_dir.join("config");
    if config_dir.is_dir() {
        collect_files(&config_dir, &config_dir, "config", &mut files)?;
    }

    // saves sélectionnées
    for save_name in save_names.iter().take(3) {
        let save_dir = inst_dir.join("saves").join(save_name);
        if save_dir.is_dir() {
            let prefix = format!("saves/{}", save_name);
            collect_files(&save_dir, &save_dir, &prefix, &mut files)?;
        }
    }

    let total = files.len() + 1; // +1 pour mods.json
    let _ = tx.blocking_send(SyncProgressEvent {
        phase: "compressing".into(),
        percent: 0,
        label: "Compression...".into(),
    });

    let cursor = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // mods.json en premier
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    zip.start_file("mods.json", options).map_err(|e| e.to_string())?;
    zip.write_all(manifest_json.as_bytes()).map_err(|e| e.to_string())?;

    for (i, (file_path, zip_path)) in files.iter().enumerate() {
        if file_path.is_dir() {
            zip.add_directory(zip_path, options).map_err(|e| e.to_string())?;
        } else {
            zip.start_file(zip_path, options).map_err(|e| e.to_string())?;
            let data = std::fs::read(file_path).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        }
        let percent = ((i + 2) * 50 / total) as u8;
        let _ = tx.blocking_send(SyncProgressEvent {
            phase: "compressing".into(),
            percent: percent.min(50),
            label: format!("Compression... {}/{} fichiers", i + 2, total),
        });
    }

    let cursor = zip.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

fn extract_zip_to_instance(zip_bytes: Vec<u8>, inst_dir: PathBuf) -> Result<(), String> {
    use std::io::{Cursor, Read};
    let cursor = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let file_name = file.name().to_string();

        if file_name.contains("..") {
            continue;
        }

        let out_path = inst_dir.join(&file_name);

        if file_name.ends_with('/') {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut buf = Vec::new();
            file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            std::fs::write(&out_path, &buf).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sync_list_instances(
    state: tauri::State<'_, SharedState>,
) -> Result<Vec<SyncInstance>, String> {
    let token = {
        let s = state.read().await;
        require_premium(&s)?;
        get_token(&s)?
    };

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{}/sync/instances", api_base()))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Serveur inaccessible : {e}"))?;

    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }

    resp.json::<Vec<SyncInstance>>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_push_instance(
    state: tauri::State<'_, SharedState>,
    app: tauri::AppHandle,
    instance_id: String,
    save_names: Vec<String>,
) -> Result<SyncInstance, String> {
    use crate::db;

    let (token, instance) = {
        let s = state.read().await;
        require_premium(&s)?;
        let token = get_token(&s)?;
        let user_id = s.current_yuyu_user_id().unwrap_or(0);
        let conn = s.db.lock().await;
        let row = db::instance_get(&conn, &instance_id, user_id)
            .map_err(|e| e.to_string())?
            .ok_or("Instance introuvable")?;
        (token, row)
    };

    let client = reqwest::Client::builder()
        .user_agent("YuyuFrame/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    // ── Étape 1 : Construire le manifest des mods ─────────────────────────────
    app.emit("sync_progress", SyncProgressEvent {
        phase: "resolving_mods".into(),
        percent: 0,
        label: "Analyse des mods...".into(),
    }).ok();

    let inst_dir = instance_dir(&instance_id);
    let mods_dir = inst_dir.join("mods");

    let mods_raw = tokio::task::spawn_blocking({
        let mods_dir = mods_dir.clone();
        move || list_mods_raw(&mods_dir)
    }).await.unwrap_or_default();

    app.emit("sync_progress", SyncProgressEvent {
        phase: "resolving_mods".into(),
        percent: 5,
        label: format!("Recherche de {} mods sur Modrinth...", mods_raw.len()),
    }).ok();

    let sha1s: Vec<String> = mods_raw.iter().map(|(_, sha1, _)| sha1.clone()).collect();
    let modrinth_map = modrinth_lookup_batch(&client, &sha1s).await;

    let modpack = read_modpack_ref(&inst_dir);

    let manifest_entries: Vec<ModManifestEntry> = mods_raw.iter().map(|(clean_name, sha1, enabled)| {
        let modrinth = modrinth_map.get(sha1).map(|(pid, vid, url)| ModrinthRef {
            project_id: pid.clone(),
            version_id: vid.clone(),
            download_url: url.clone(),
        });
        ModManifestEntry {
            filename: clean_name.clone(),
            sha1: sha1.clone(),
            enabled: *enabled,
            modrinth,
        }
    }).collect();

    let modrinth_count = manifest_entries.iter().filter(|m| m.modrinth.is_some()).count();
    let manual_count = manifest_entries.len() - modrinth_count;

    app.emit("sync_progress", SyncProgressEvent {
        phase: "resolving_mods".into(),
        percent: 10,
        label: format!("{} mods Modrinth · {} inclus dans le ZIP", modrinth_count, manual_count),
    }).ok();

    let manifest = ModManifest {
        format_version: 1,
        mc_version: instance.mc_version.clone(),
        loader: instance.loader.clone(),
        modpack,
        mods: manifest_entries,
    };

    // ── Étape 2 : Enregistrer les métadonnées sur le serveur ──────────────────
    let meta_resp = client
        .post(format!("{}/sync/instances", api_base()))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "instance_name": instance.name,
            "mc_version":    instance.mc_version,
            "loader":        instance.loader,
            "ram_mb":        instance.ram_mb,
            "save_count":    save_names.len() as u32,
            "save_names":    save_names,
        }))
        .send()
        .await
        .map_err(|e| format!("Serveur inaccessible : {e}"))?;

    if !meta_resp.status().is_success() {
        return Err(meta_resp.text().await.unwrap_or_default());
    }

    let sync_inst: SyncInstance = meta_resp.json().await.map_err(|e| e.to_string())?;
    let sync_id = sync_inst.id;

    // ── Étape 3 : Compression avec progression ────────────────────────────────
    let (tx, mut rx) = tokio::sync::mpsc::channel::<SyncProgressEvent>(128);
    let dir = inst_dir.clone();
    let save_names_clone = save_names.clone();
    let manifest_clone = manifest.clone();

    let zip_task = tokio::task::spawn_blocking(move || {
        build_instance_zip_with_progress(dir, save_names_clone, manifest_clone, tx)
    });

    let app_progress = app.clone();
    let forward = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            app_progress.emit("sync_progress", ev).ok();
        }
    });

    let zip_bytes = zip_task.await.map_err(|e| e.to_string())??;
    forward.await.ok();

    // ── Étape 4 : Upload ──────────────────────────────────────────────────────
    app.emit("sync_progress", SyncProgressEvent {
        phase: "uploading".into(),
        percent: 55,
        label: "Envoi vers le cloud...".into(),
    }).ok();

    let data_resp = client
        .post(format!("{}/sync/instances/{}/data", api_base(), sync_id))
        .bearer_auth(&token)
        .header("Content-Type", "application/octet-stream")
        .body(zip_bytes)
        .send()
        .await
        .map_err(|e| format!("Serveur inaccessible : {e}"))?;

    if !data_resp.status().is_success() {
        return Err(data_resp.text().await.unwrap_or_default());
    }

    app.emit("sync_progress", SyncProgressEvent {
        phase: "done".into(),
        percent: 100,
        label: "Synchronisé !".into(),
    }).ok();

    data_resp.json::<SyncInstance>().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_pull_instance(
    state: tauri::State<'_, SharedState>,
    app: tauri::AppHandle,
    sync_id: i64,
    instance_id: String,
) -> Result<(), String> {
    let token = {
        let s = state.read().await;
        require_premium(&s)?;
        get_token(&s)?
    };

    // ── Étape 1 : Télécharger le ZIP ─────────────────────────────────────────
    app.emit("sync_progress", SyncProgressEvent {
        phase: "downloading".into(),
        percent: 5,
        label: "Téléchargement depuis le cloud...".into(),
    }).ok();

    let client = reqwest::Client::builder()
        .user_agent("YuyuFrame/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(format!("{}/sync/instances/{}/data", api_base(), sync_id))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Serveur inaccessible : {e}"))?;

    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }

    let zip_bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();

    // ── Étape 2 : Extraction ──────────────────────────────────────────────────
    app.emit("sync_progress", SyncProgressEvent {
        phase: "downloading".into(),
        percent: 35,
        label: "Extraction des fichiers...".into(),
    }).ok();

    let dir = instance_dir(&instance_id);
    let dir_clone = dir.clone();

    tokio::task::spawn_blocking(move || extract_zip_to_instance(zip_bytes, dir_clone))
        .await
        .map_err(|e| e.to_string())??;

    // ── Étape 3 : Installer les mods depuis le manifest ───────────────────────
    let manifest_path = dir.join("mods.json");
    if manifest_path.exists() {
        let manifest_json = tokio::fs::read_to_string(&manifest_path)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::remove_file(&manifest_path).await.ok();

        let manifest: ModManifest = serde_json::from_str(&manifest_json)
            .map_err(|e| format!("Manifest invalide : {e}"))?;

        let modrinth_mods: Vec<&ModManifestEntry> = manifest.mods.iter()
            .filter(|m| m.modrinth.is_some())
            .collect();

        let total = modrinth_mods.len();
        if total > 0 {
            let mods_dir = dir.join("mods");
            tokio::fs::create_dir_all(&mods_dir).await.ok();

            for (i, entry) in modrinth_mods.iter().enumerate() {
                let modrinth = entry.modrinth.as_ref().unwrap();
                let percent = 45u8.saturating_add((i * 50 / total.max(1)) as u8);

                app.emit("sync_progress", SyncProgressEvent {
                    phase: "installing_mods".into(),
                    percent,
                    label: format!("Mods {}/{} — {}", i + 1, total, entry.filename),
                }).ok();

                // Validation URL (CDN Modrinth uniquement)
                if !modrinth.download_url.starts_with("https://cdn.modrinth.com/") {
                    continue;
                }

                let Ok(dl_resp) = client.get(&modrinth.download_url).send().await else { continue };
                if !dl_resp.status().is_success() { continue; }
                let Ok(bytes) = dl_resp.bytes().await else { continue };

                let dest_name = if entry.enabled {
                    entry.filename.clone()
                } else {
                    format!("{}.disabled", entry.filename)
                };
                tokio::fs::write(mods_dir.join(&dest_name), &bytes).await.ok();
            }
        }
    }

    app.emit("sync_progress", SyncProgressEvent {
        phase: "done".into(),
        percent: 100,
        label: "Restauré !".into(),
    }).ok();

    Ok(())
}

#[tauri::command]
pub async fn sync_delete_instance(
    state: tauri::State<'_, SharedState>,
    sync_id: i64,
) -> Result<(), String> {
    let token = {
        let s = state.read().await;
        require_premium(&s)?;
        get_token(&s)?
    };

    let client = reqwest::Client::new();
    let resp = client
        .delete(format!("{}/sync/instances/{}", api_base(), sync_id))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Serveur inaccessible : {e}"))?;

    if !resp.status().is_success() {
        return Err(resp.text().await.unwrap_or_default());
    }

    Ok(())
}
