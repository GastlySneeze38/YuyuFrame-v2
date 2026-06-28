use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, LazyLock};

use crate::commands::instances::instance_mods_dir;
use crate::minecraft::version_pred::{normalize_version, parse_predicate_groups, read_fabric_mod_json, version_allowed};

#[derive(Serialize, Clone)]
pub struct ModInfo {
    pub name: String,
    pub size: u64,
    pub enabled: bool,
    pub sha1: String,
}

// Cache SHA1 : chemin → (taille, mtime_secs, sha1)
// Invalidé automatiquement si le fichier est modifié ou remplacé.
static SHA1_CACHE: LazyLock<Mutex<HashMap<PathBuf, (u64, u64, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn compute_sha1(path: &std::path::Path) -> String {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else { return String::new() };
    let mut hasher = Sha1::new();
    let mut buf = [0u8; 65536];
    loop {
        match file.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => hasher.update(&buf[..n]),
        }
    }
    format!("{:x}", hasher.finalize())
}

fn sha1_cached(path: &std::path::Path) -> String {
    let Ok(meta) = std::fs::metadata(path) else { return String::new() };
    let size = meta.len();
    let mtime = meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let key = path.to_path_buf();
    if let Ok(cache) = SHA1_CACHE.lock() {
        if let Some((cs, cm, sha1)) = cache.get(&key) {
            if *cs == size && *cm == mtime {
                return sha1.clone();
            }
        }
    }

    let sha1 = compute_sha1(path);
    if let Ok(mut cache) = SHA1_CACHE.lock() {
        cache.insert(key, (size, mtime, sha1.clone()));
    }
    sha1
}

#[tauri::command]
pub async fn mods_list(instance_id: String) -> Result<Vec<ModInfo>, String> {
    let dir = instance_mods_dir(&instance_id);
    let mut mods = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            let enabled = name.ends_with(".jar") && !name.ends_with(".jar.disabled");
            let disabled = name.ends_with(".jar.disabled");
            if !enabled && !disabled {
                continue;
            }
            let size = entry.metadata().await.map(|m| m.len()).unwrap_or(0);
            let path_clone = path.clone();
            let sha1 = tokio::task::spawn_blocking(move || sha1_cached(&path_clone))
                .await
                .unwrap_or_default();
            mods.push(ModInfo { name, size, enabled, sha1 });
        }
    }

    mods.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(mods)
}

#[tauri::command]
pub async fn mods_toggle(instance_id: String, name: String) -> Result<ModInfo, String> {
    let dir = instance_mods_dir(&instance_id);
    let from = dir.join(&name);

    if !from.exists() {
        return Err(format!("Mod '{}' introuvable", name));
    }

    let (to_name, enabled) = if name.ends_with(".jar.disabled") {
        (name.trim_end_matches(".disabled").to_string(), true)
    } else if name.ends_with(".jar") {
        (format!("{}.disabled", name), false)
    } else {
        return Err("Nom de mod invalide".into());
    };

    let to = dir.join(&to_name);
    tokio::fs::rename(&from, &to).await.map_err(|e| e.to_string())?;

    let size = tokio::fs::metadata(&to).await.map(|m| m.len()).unwrap_or(0);
    let sha1 = tokio::task::spawn_blocking(move || sha1_cached(&to))
        .await
        .unwrap_or_default();
    Ok(ModInfo { name: to_name, size, enabled, sha1 })
}

#[tauri::command]
pub async fn mods_delete(instance_id: String, name: String) -> Result<(), String> {
    let dir = instance_mods_dir(&instance_id);
    let path = dir.join(&name);

    if !path.exists() {
        return Err(format!("Mod '{}' introuvable", name));
    }

    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let canonical_dir = dir.canonicalize().unwrap_or(dir);
    if !canonical.starts_with(&canonical_dir) {
        return Err("Accès refusé".into());
    }

    tokio::fs::remove_file(&canonical).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mods_install(
    instance_id: String,
    url: String,
    filename: String,
) -> Result<ModInfo, String> {
    if !url.starts_with("https://cdn.modrinth.com/") {
        return Err("URL non autorisée".into());
    }

    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "mod.jar".to_string());

    if !safe_name.ends_with(".jar") {
        return Err("Seuls les fichiers .jar sont acceptés".into());
    }

    let dir = instance_mods_dir(&instance_id);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent("YuyuFrame/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Téléchargement échoué: {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let dest = dir.join(&safe_name);
    tokio::fs::write(&dest, &bytes).await.map_err(|e| e.to_string())?;
    let sha1 = tokio::task::spawn_blocking(move || sha1_cached(&dest))
        .await
        .unwrap_or_default();

    Ok(ModInfo { name: safe_name, size: bytes.len() as u64, enabled: true, sha1 })
}

/// Extrait l'icône d'un mod directement depuis son JAR et la retourne en data URL base64.
/// Lit le champ `icon` de fabric.mod.json, avec repli sur pack.png.
#[tauri::command]
pub async fn mod_icon(instance_id: String, name: String) -> Result<String, String> {
    let dir = instance_mods_dir(&instance_id);
    let path = dir.join(&name);
    if !path.exists() {
        return Err("Mod introuvable".into());
    }

    tokio::task::spawn_blocking(move || mod_icon_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn mod_icon_blocking(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;

    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;

    // Lire fabric.mod.json pour trouver le chemin de l'icône
    let icon_path: Option<String> = {
        let cursor = std::io::Cursor::new(&bytes);
        if let Ok(mut archive) = zip::ZipArchive::new(cursor) {
            if let Ok(mut entry) = archive.by_name("fabric.mod.json") {
                let mut content = String::new();
                let _ = entry.read_to_string(&mut content);
                serde_json::from_str::<serde_json::Value>(&content)
                    .ok()
                    .and_then(|v| v.get("icon").and_then(|i| i.as_str()).map(|s| s.to_string()))
            } else {
                None
            }
        } else {
            None
        }
    };

    let cursor = std::io::Cursor::new(&bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;

    let candidates: Vec<&str> = if let Some(ref p) = icon_path {
        vec![p.as_str(), "pack.png"]
    } else {
        vec!["pack.png"]
    };

    for candidate in candidates {
        if let Ok(mut entry) = archive.by_name(candidate) {
            let mut icon_bytes = Vec::new();
            if entry.read_to_end(&mut icon_bytes).is_ok() && !icon_bytes.is_empty() {
                let mime = if icon_bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
                    "image/png"
                } else if icon_bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
                    "image/jpeg"
                } else {
                    "image/png"
                };
                let b64 = base64::engine::general_purpose::STANDARD.encode(&icon_bytes);
                return Ok(format!("data:{};base64,{}", mime, b64));
            }
        }
    }

    Err("Pas d'icône dans ce JAR".into())
}

#[tauri::command]
pub async fn mods_upload(
    instance_id: String,
    filename: String,
    data: Vec<u8>,
) -> Result<ModInfo, String> {
    let safe_name = std::path::Path::new(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "mod.jar".to_string());

    if !safe_name.ends_with(".jar") {
        return Err("Seuls les fichiers .jar sont acceptés".into());
    }

    let dir = instance_mods_dir(&instance_id);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;

    let dest = dir.join(&safe_name);
    let size = data.len() as u64;
    tokio::fs::write(&dest, &data).await.map_err(|e| e.to_string())?;
    let sha1 = tokio::task::spawn_blocking(move || sha1_cached(&dest))
        .await
        .unwrap_or_default();

    Ok(ModInfo { name: safe_name, size, enabled: true, sha1 })
}

/// Cherche le jar OptiFine le plus récent dans le dossier Téléchargements de
/// l'utilisateur et le copie dans les mods de l'instance.
///
/// OptiFine n'autorise aucune redistribution sans permission écrite de son
/// auteur (cf. https://optifine.net/copyright) — on ne télécharge donc
/// jamais le jar nous-mêmes. L'utilisateur passe par le vrai site officiel
/// (bouton "Ouvrir OptiFine" côté Frontend), et cette commande se contente de
/// déplacer le fichier qu'il vient de télécharger lui-même vers le bon
/// dossier — aucun contenu OptiFine ne transite par nos serveurs.
#[tauri::command]
pub async fn mods_import_optifine(instance_id: String) -> Result<ModInfo, String> {
    let downloads = dirs::download_dir().ok_or("Dossier Téléchargements introuvable")?;

    let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut entries = tokio::fs::read_dir(&downloads).await.map_err(|e| e.to_string())?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        if name.starts_with("optifine") && name.ends_with(".jar") {
            if let Ok(meta) = entry.metadata().await {
                if let Ok(modified) = meta.modified() {
                    candidates.push((modified, path));
                }
            }
        }
    }

    candidates.sort_by_key(|(t, _)| *t);
    let (_, source) = candidates
        .pop()
        .ok_or("Aucun fichier OptiFine_*.jar trouvé dans Téléchargements — télécharge-le d'abord depuis le site officiel")?;

    let safe_name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "OptiFine.jar".to_string());

    let dir = instance_mods_dir(&instance_id);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let dest = dir.join(&safe_name);

    tokio::fs::copy(&source, &dest).await.map_err(|e| e.to_string())?;
    let size = tokio::fs::metadata(&dest).await.map(|m| m.len()).unwrap_or(0);
    let sha1 = tokio::task::spawn_blocking(move || sha1_cached(&dest))
        .await
        .unwrap_or_default();

    Ok(ModInfo { name: safe_name, size, enabled: true, sha1 })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCandidate {
    /// Nom de fichier actuel du mod dans le dossier de l'instance.
    pub name: String,
    pub new_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSafety {
    pub name: String,
    pub safe: bool,
    /// Mods dont la dépendance déclarée bloquerait cette mise à jour.
    pub blocked_by: Vec<String>,
}

/// Vérifie, pour chaque mise à jour candidate, si la nouvelle version respecte
/// les contraintes de version (`depends`) déclarées par les *autres* mods
/// installés dans l'instance — pour ne pas proposer une mise à jour qui
/// casserait un mod dépendant (ex: Voxy exige Sodium &lt;0.8.13).
#[tauri::command]
pub async fn mods_check_update_safety(
    instance_id: String,
    mc_version: String,
    loader: String,
    candidates: Vec<UpdateCandidate>,
) -> Result<Vec<UpdateSafety>, String> {
    let dir = instance_mods_dir(&instance_id);

    tokio::task::spawn_blocking(move || {
        // id fabric -> nom de fichier, pour retrouver le candidat par son id
        let mut id_by_name: HashMap<String, String> = HashMap::new();
        // mods déclarant des contraintes : (nom du mod déclarant, id visé, depends, breaks)
        let mut constraints: Vec<(String, String, Vec<Vec<String>>, Vec<Vec<String>>)> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                if !name.ends_with(".jar") {
                    continue;
                }
                let Some(meta) = read_fabric_mod_json(&path) else { continue };
                id_by_name.insert(name.clone(), meta.id.clone());
                for (dep_id, predicate_value) in &meta.depends {
                    let depends_groups = parse_predicate_groups(predicate_value);
                    let breaks_groups = meta
                        .breaks
                        .get(dep_id)
                        .map(parse_predicate_groups)
                        .unwrap_or_default();
                    if !depends_groups.is_empty() || !breaks_groups.is_empty() {
                        constraints.push((name.clone(), dep_id.clone(), depends_groups, breaks_groups));
                    }
                }
            }
        }

        candidates
            .into_iter()
            .map(|c| {
                let target_id = id_by_name.get(&c.name).cloned();
                let normalized_new_version = normalize_version(&c.new_version, &mc_version, &loader);
                let blocked_by: Vec<String> = match &target_id {
                    Some(id) => constraints
                        .iter()
                        .filter(|(declaring_mod, dep_id, _, _)| {
                            dep_id == id && declaring_mod != &c.name
                        })
                        .filter(|(_, _, depends_groups, breaks_groups)| {
                            !version_allowed(&normalized_new_version, depends_groups, breaks_groups)
                        })
                        .map(|(declaring_mod, _, _, _)| declaring_mod.clone())
                        .collect(),
                    None => Vec::new(),
                };
                UpdateSafety { safe: blocked_by.is_empty(), name: c.name, blocked_by }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}
