use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::db;
use crate::minecraft::launcher::minecraft_dir;
use crate::state::SharedState;

#[derive(Serialize, Deserialize, Clone)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub mc_version: String,
    pub loader: String,
    pub ram_mb: u32,
    pub favorite: bool,
    pub description: String,
}

#[derive(Serialize, Deserialize)]
struct InstanceMeta {
    id: String,
    name: String,
    mc_version: String,
    loader: String,
    ram_mb: u32,
    #[serde(default)]
    description: String,
}

fn write_meta(id: &str, name: &str, mc_version: &str, loader: &str, ram_mb: u32, description: &str) {
    let meta = InstanceMeta {
        id: id.to_string(),
        name: name.to_string(),
        mc_version: mc_version.to_string(),
        loader: loader.to_string(),
        ram_mb,
        description: description.to_string(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&meta) {
        let _ = std::fs::write(instance_dir(id).join("meta.json"), json);
    }
}

pub fn instance_dir(id: &str) -> PathBuf {
    minecraft_dir().join("instances").join(id)
}

pub fn instance_mods_dir(id: &str) -> PathBuf {
    instance_dir(id).join("mods")
}

fn gen_id() -> String {
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(rand::distributions::Alphanumeric)
        .take(12)
        .map(char::from)
        .collect::<String>()
        .to_lowercase()
}

fn row_to_instance(r: db::InstanceRow) -> Instance {
    Instance { id: r.id, name: r.name, mc_version: r.mc_version, loader: r.loader, ram_mb: r.ram_mb, favorite: r.favorite, description: r.description }
}

fn user_id(s: &crate::state::AppState) -> i64 {
    s.yuyu_session.as_ref().map(|y| y.user_id).unwrap_or(0)
}

#[tauri::command]
pub async fn instance_list(state: tauri::State<'_, SharedState>) -> Result<Vec<Instance>, String> {
    let s = state.read().await;
    let uid = user_id(&s);
    let db = s.db.lock().await;
    db::instance_list(&db, uid)
        .map(|rows| rows.into_iter().map(row_to_instance).collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn instance_create(
    state: tauri::State<'_, SharedState>,
    name: String,
    mc_version: String,
    loader: String,
    ram_mb: u32,
    description: Option<String>,
) -> Result<Instance, String> {
    if name.trim().is_empty() {
        return Err("Le nom de l'instance est requis".into());
    }
    let description = description.unwrap_or_default().trim().to_string();
    let id = gen_id();
    tokio::fs::create_dir_all(instance_dir(&id))
        .await
        .map_err(|e| e.to_string())?;
    let name = name.trim().to_string();
    write_meta(&id, &name, &mc_version, &loader, ram_mb, &description);
    let s = state.read().await;
    let uid = user_id(&s);
    let db = s.db.lock().await;
    db::instance_insert(&db, &id, uid, &name, &mc_version, &loader, ram_mb, &description)
        .map_err(|e| e.to_string())?;
    Ok(Instance { id, name, mc_version, loader, ram_mb, favorite: false, description })
}

#[tauri::command]
pub async fn instance_delete(
    state: tauri::State<'_, SharedState>,
    id: String,
) -> Result<(), String> {
    {
        let s = state.read().await;
        let uid = user_id(&s);
        let db = s.db.lock().await;
        db::instance_delete(&db, &id, uid).map_err(|e| e.to_string())?;
    }
    let dir = instance_dir(&id);
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn instance_toggle_favorite(
    state: tauri::State<'_, SharedState>,
    id: String,
) -> Result<Instance, String> {
    let s = state.read().await;
    let uid = user_id(&s);
    let db = s.db.lock().await;
    let row = db::instance_get(&db, &id, uid)
        .map_err(|e| e.to_string())?
        .ok_or("Instance introuvable")?;
    db::instance_set_favorite(&db, &id, uid, !row.favorite).map_err(|e| e.to_string())?;
    let updated = db::instance_get(&db, &id, uid)
        .map_err(|e| e.to_string())?
        .ok_or("Instance introuvable")?;
    Ok(row_to_instance(updated))
}

#[tauri::command]
pub async fn instance_update(
    state: tauri::State<'_, SharedState>,
    id: String,
    name: String,
    mc_version: String,
    loader: String,
    ram_mb: u32,
    description: Option<String>,
) -> Result<Instance, String> {
    let name = name.trim().to_string();
    let description = description.unwrap_or_default().trim().to_string();
    let s = state.read().await;
    let uid = user_id(&s);
    let db = s.db.lock().await;
    db::instance_update(&db, &id, uid, &name, &mc_version, &loader, ram_mb, &description)
        .map_err(|e| e.to_string())?;
    write_meta(&id, &name, &mc_version, &loader, ram_mb, &description);
    let row = db::instance_get(&db, &id, uid)
        .map_err(|e| e.to_string())?
        .ok_or("Instance introuvable")?;
    Ok(row_to_instance(row))
}

#[tauri::command]
pub async fn instance_duplicate(
    state: tauri::State<'_, SharedState>,
    source_id: String,
    name: String,
    mc_version: String,
    ram_mb: u32,
) -> Result<Instance, String> {
    if name.trim().is_empty() {
        return Err("Le nom de l'instance est requis".into());
    }
    let name = name.trim().to_string();

    let loader = {
        let s = state.read().await;
        let uid = user_id(&s);
        let db = s.db.lock().await;
        db::instance_get(&db, &source_id, uid)
            .map_err(|e| e.to_string())?
            .ok_or("Instance source introuvable")?
            .loader
    };

    let new_id = gen_id();
    tokio::fs::create_dir_all(instance_dir(&new_id)).await.map_err(|e| e.to_string())?;

    let src_mods = instance_mods_dir(&source_id);
    if src_mods.exists() {
        let dst_mods = instance_mods_dir(&new_id);
        tokio::fs::create_dir_all(&dst_mods).await.map_err(|e| e.to_string())?;
        let mut dir = tokio::fs::read_dir(&src_mods).await.map_err(|e| e.to_string())?;
        while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
            let src_path = entry.path();
            if src_path.is_file() {
                if let Some(filename) = src_path.file_name() {
                    tokio::fs::copy(&src_path, dst_mods.join(filename)).await.map_err(|e| e.to_string())?;
                }
            }
        }
    }

    write_meta(&new_id, &name, &mc_version, &loader, ram_mb, "");

    let s = state.read().await;
    let uid = user_id(&s);
    let db = s.db.lock().await;
    db::instance_insert(&db, &new_id, uid, &name, &mc_version, &loader, ram_mb, "")
        .map_err(|e| e.to_string())?;

    Ok(Instance { id: new_id, name, mc_version, loader, ram_mb, favorite: false, description: String::new() })
}

/// Synchronise la DB avec les dossiers réels au démarrage.
/// mode = "db_wins"   → supprime les dossiers orphelins sur le disque
/// mode = "disk_wins" → importe en DB les dossiers qui ont un meta.json
#[tauri::command]
pub async fn instance_startup_sync(
    state: tauri::State<'_, SharedState>,
    mode: String,
) -> Result<(), String> {
    use std::collections::HashSet;

    let s = state.read().await;
    let uid = user_id(&s);
    let db = s.db.lock().await;

    let db_rows = db::instance_list(&db, uid).map_err(|e| e.to_string())?;
    let db_ids: HashSet<String> = db_rows.iter().map(|r| r.id.clone()).collect();

    let instances_root = minecraft_dir().join("instances");
    if !instances_root.is_dir() {
        let _ = std::fs::create_dir_all(&instances_root);
        return Ok(());
    }

    let disk_ids: HashSet<String> = std::fs::read_dir(&instances_root)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();

    // DB entry existe mais le dossier a disparu → retirer de la DB
    for id in db_ids.difference(&disk_ids) {
        db::instance_delete(&db, id, uid).ok();
    }

    // Dossier présent mais pas en DB
    let orphan_ids: Vec<String> = disk_ids.difference(&db_ids).cloned().collect();
    match mode.as_str() {
        "db_wins" => {
            for id in orphan_ids {
                let _ = std::fs::remove_dir_all(instances_root.join(&id));
            }
        }
        "disk_wins" => {
            for id in orphan_ids {
                let meta_path = instances_root.join(&id).join("meta.json");
                if let Ok(json) = std::fs::read_to_string(&meta_path) {
                    if let Ok(meta) = serde_json::from_str::<InstanceMeta>(&json) {
                        db::instance_insert(&db, &meta.id, uid, &meta.name, &meta.mc_version, &meta.loader, meta.ram_mb, &meta.description).ok();
                    }
                }
                // Pas de meta.json → on laisse le dossier, impossible d'importer
            }
        }
        _ => {}
    }

    Ok(())
}
