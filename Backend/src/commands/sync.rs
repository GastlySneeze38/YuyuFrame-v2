use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use tauri::Emitter;

use crate::state::SharedState;
use super::instances::instance_dir;

fn api_base() -> String {
    std::env::var("YUYU_API_URL").unwrap_or_else(|_| "http://localhost:3000".into())
}

// ── Types ──────────────────────────────────────────────────────────────────────

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
    pub phase: String,   // "compressing" | "uploading" | "done"
    pub percent: u8,
    pub label: String,
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
    tx: tokio::sync::mpsc::Sender<SyncProgressEvent>,
) -> Result<Vec<u8>, String> {
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    // Collecte des fichiers à compresser
    let mut files: Vec<(PathBuf, String)> = Vec::new();

    let mods_dir = inst_dir.join("mods");
    if mods_dir.is_dir() {
        collect_files(&mods_dir, &mods_dir, "mods", &mut files)?;
    }

    let config_dir = inst_dir.join("config");
    if config_dir.is_dir() {
        collect_files(&config_dir, &config_dir, "config", &mut files)?;
    }

    for save_name in save_names.iter().take(3) {
        let save_dir = inst_dir.join("saves").join(save_name);
        if save_dir.is_dir() {
            let prefix = format!("saves/{}", save_name);
            collect_files(&save_dir, &save_dir, &prefix, &mut files)?;
        }
    }

    let total = files.len().max(1);
    let _ = tx.blocking_send(SyncProgressEvent {
        phase: "compressing".into(),
        percent: 0,
        label: "Compression...".into(),
    });

    let cursor = Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for (i, (file_path, zip_path)) in files.iter().enumerate() {
        if file_path.is_dir() {
            zip.add_directory(zip_path, options).map_err(|e| e.to_string())?;
        } else {
            zip.start_file(zip_path, options).map_err(|e| e.to_string())?;
            let data = std::fs::read(file_path).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        }
        let percent = ((i + 1) * 50 / total) as u8;
        let _ = tx.blocking_send(SyncProgressEvent {
            phase: "compressing".into(),
            percent,
            label: format!("Compression... {}/{} fichiers", i + 1, total),
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

    let client = reqwest::Client::new();

    // Enregistre / met à jour les métadonnées
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

    // Compression avec progression
    let (tx, mut rx) = tokio::sync::mpsc::channel::<SyncProgressEvent>(128);
    let dir = instance_dir(&instance_id);

    let zip_task = tokio::task::spawn_blocking(move || {
        build_instance_zip_with_progress(dir, save_names, tx)
    });

    let app_progress = app.clone();
    let forward = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            app_progress.emit("sync_progress", ev).ok();
        }
    });

    let zip_bytes = zip_task.await.map_err(|e| e.to_string())??;
    forward.await.ok();

    // Upload
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
    sync_id: i64,
    instance_id: String,
) -> Result<(), String> {
    let token = {
        let s = state.read().await;
        require_premium(&s)?;
        get_token(&s)?
    };

    let client = reqwest::Client::new();
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
    let dir = instance_dir(&instance_id);

    tokio::task::spawn_blocking(move || extract_zip_to_instance(zip_bytes, dir))
        .await
        .map_err(|e| e.to_string())?
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
