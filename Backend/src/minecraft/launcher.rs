use anyhow::{anyhow, Result};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use tauri::Manager;
use crate::state::{DownloadProgress, MinecraftSession, SharedState};
use super::deps;
use super::fabric;
use super::forge;
use super::p2p;
use super::versions::{
    fetch_asset_index, fetch_version_details, fetch_version_list, Artifact, Library, VersionDetails,
};

pub fn minecraft_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("YuyuFrame")
        .join(".minecraft")
}

fn set_progress(app: &tauri::AppHandle, current: u64, total: u64, message: &str) {
    let _ = app.emit("download_progress", DownloadProgress {
        current,
        total,
        message: message.to_string(),
    });
}

/// Émet un game_log vers la fenêtre console dédiée à cette instance.
/// Fallback sur broadcast global si la fenêtre n'existe plus.
fn log_to_console(app: &tauri::AppHandle, console_label: &str, line: &str, level: &str) {
    let short_id = console_label.strip_prefix("mc-console-").unwrap_or(console_label);
    let payload = serde_json::json!({ "line": line, "level": level, "instance_id": short_id });
    if let Some(win) = app.get_webview_window(console_label) {
        let _ = win.emit("game_log", &payload);
    } else {
        let _ = app.emit("game_log", &payload);
    }
}

/// `loader` — "vanilla" | "fabric" | "forge" (None treated as vanilla)
/// `game_dir` — instance directory (saves, mods, configs); shared assets stay in minecraft_dir()
/// `console_label` — label de la fenêtre console à cibler pour les game_log
pub async fn download_and_launch(
    version_id: &str,
    loader: Option<&str>,
    session: &MinecraftSession,
    ram_mb: u32,
    game_dir: &std::path::Path,
    app: tauri::AppHandle,
    state: SharedState,
    p2p: bool,
    console_label: &str,
) -> Result<()> {
    let mc_dir = minecraft_dir();
    tokio::fs::create_dir_all(game_dir).await?;
    let versions_dir = mc_dir.join("versions").join(version_id);
    let libraries_dir = mc_dir.join("libraries");
    let assets_dir = mc_dir.join("assets");
    let natives_dir = versions_dir.join("natives");

    for dir in [&versions_dir, &libraries_dir, &assets_dir, &natives_dir] {
        tokio::fs::create_dir_all(dir).await?;
    }

    // ── Vanilla download ──────────────────────────────────────────────────────

    set_progress(&app, 0, 100, "Récupération du manifest...");
    let versions = fetch_version_list().await?;
    let version_info = versions
        .iter()
        .find(|v| v.id == version_id)
        .ok_or_else(|| anyhow!("Version {} introuvable", version_id))?;

    set_progress(&app, 5, 100, "Récupération des détails...");
    let details = fetch_version_details(&version_info.url).await?;

    // Client HTTP partagé — pool de connexions réutilisées pour tous les téléchargements
    let client = Arc::new(reqwest::Client::builder()
        .pool_max_idle_per_host(32)
        .build()?);

    // ── Assets en tâche de fond — démarre immédiatement, indépendant des libs ──
    // Les assets et les libs sont totalement indépendants : on les télécharge en parallèle.
    let assets_task = {
        let client = client.clone();
        let app = app.clone();
        let assets_dir = assets_dir.clone();
        let asset_index = details.asset_index.clone();
        tokio::spawn(async move {
            let asset_index_path = assets_dir
                .join("indexes")
                .join(format!("{}.json", asset_index.id));
            tokio::fs::create_dir_all(asset_index_path.parent().unwrap()).await?;
            if !asset_index_path.exists() {
                download_file(&client, &asset_index.url, &asset_index_path).await?;
            }
            let index_file = fetch_asset_index(&asset_index.url).await?;
            let objects_dir = assets_dir.join("objects");
            let total_assets = index_file.objects.len() as u64;

            let sem = Arc::new(Semaphore::new(32));
            let mut tasks: JoinSet<Result<()>> = JoinSet::new();

            for obj in index_file.objects.into_values() {
                let sem = sem.clone();
                let client = client.clone();
                let objects_dir = objects_dir.clone();
                tasks.spawn(async move {
                    let prefix = &obj.hash[..2];
                    let obj_dir = objects_dir.join(prefix);
                    let obj_path = obj_dir.join(&obj.hash);
                    if !obj_path.exists() {
                        let _permit = sem.acquire().await.unwrap();
                        tokio::fs::create_dir_all(&obj_dir).await?;
                        let url = format!(
                            "https://resources.download.minecraft.net/{}/{}",
                            prefix, obj.hash
                        );
                        download_file(&client, &url, &obj_path).await.ok();
                    }
                    Ok::<(), anyhow::Error>(())
                });
            }

            let mut done = 0u64;
            while let Some(r) = tasks.join_next().await {
                r??;
                done += 1;
                if done % 200 == 0 || done == total_assets {
                    set_progress(
                        &app,
                        50 + done * 40 / total_assets.max(1),
                        100,
                        &format!("Assets {}/{}", done, total_assets),
                    );
                }
            }
            anyhow::Ok(())
        })
    };

    let client_jar = versions_dir.join(format!("{}.jar", version_id));
    if !client_jar.exists() {
        set_progress(&app, 10, 100, "Téléchargement du client Minecraft...");
        download_file(&client, &details.downloads.client.url, &client_jar).await?;
    }

    set_progress(&app, 20, 100, "Téléchargement des bibliothèques...");
    let total_libs = details.libraries.len() as u64;

    // 16 téléchargements simultanés — équilibre bande passante / charge serveur Mojang
    let lib_sem = Arc::new(Semaphore::new(16));
    let mut lib_tasks: JoinSet<Result<(Option<String>, Vec<PathBuf>)>> = JoinSet::new();

    for lib in details.libraries.iter() {
        if !should_download_library(lib) {
            continue;
        }
        let Some(ref dl) = lib.downloads else { continue };

        let lib_name = lib.name.clone();
        let artifact = dl.artifact.clone();
        let classifiers = dl.classifiers.clone();
        let natives_map = lib.natives.clone();
        let sem = lib_sem.clone();
        let client = client.clone();
        let libraries_dir = libraries_dir.clone();

        lib_tasks.spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            let mut cp_entry = None;
            let mut native_paths = Vec::new();

            if let Some(art) = artifact {
                let lib_path = artifact_path(&libraries_dir, &art, &lib_name);
                if let Some(parent) = lib_path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                if !lib_path.exists() {
                    download_file(&client, &art.url, &lib_path).await?;
                }
                // Les JARs natifs (":natives-xxx") sont extraits vers natives_dir
                // ET ajoutés au classpath : LWJGL 3.x utilise le classpath comme fallback
                // si l'extraction échoue ou si java.library.path n'est pas trouvé.
                cp_entry = Some(lib_path.to_string_lossy().to_string());
                if lib_name.contains(":natives-") {
                    native_paths.push(lib_path);
                }
            }

            if let (Some(natives_map), Some(classifiers)) = (natives_map, classifiers) {
                let os_key = if cfg!(target_os = "windows") { "windows" }
                    else if cfg!(target_os = "macos") { "osx" }
                    else { "linux" };
                if let Some(classifier_key) = natives_map.get(os_key) {
                    let key = classifier_key.replace(
                        "${arch}",
                        if cfg!(target_pointer_width = "64") { "64" } else { "32" },
                    );
                    if let Some(native_art) = classifiers.get(&key) {
                        let native_path = artifact_path(
                            &libraries_dir,
                            native_art,
                            &format!("{}:{}", lib_name, key),
                        );
                        if let Some(parent) = native_path.parent() {
                            tokio::fs::create_dir_all(parent).await?;
                        }
                        if !native_path.exists() {
                            download_file(&client, &native_art.url, &native_path).await?;
                        }
                        native_paths.push(native_path);
                    }
                }
            }

            Ok((cp_entry, native_paths))
        });
    }

    let mut classpath = Vec::new();
    let mut natives_to_extract = Vec::new();
    let mut libs_done = 0u64;
    while let Some(result) = lib_tasks.join_next().await {
        let (cp_entry, native_paths) = result??;
        if let Some(cp) = cp_entry { classpath.push(cp); }
        natives_to_extract.extend(native_paths);
        libs_done += 1;
        if libs_done % 10 == 0 || libs_done == total_libs {
            set_progress(&app, 20 + libs_done * 30 / total_libs.max(1), 100,
                &format!("Bibliothèques {}/{}", libs_done, total_libs));
        }
    }

    for np in natives_to_extract {
        if let Err(e) = extract_natives(&np, &natives_dir).await {
            tracing::warn!("Extraction natives échouée pour {} : {}", np.display(), e);
        }
    }

    // ── Loader-specific setup ────────────────────────────────────────────────
    // Les assets continuent de se télécharger en arrière-plan pendant ce temps.

    // Pas de javaVersion dans le manifest = ancienne version MC → Java 8 requis (LaunchWrapper)
    let required_java = details.java_version.as_ref().map(|j| j.major_version).unwrap_or(8);
    let java_component = details.java_version.as_ref()
        .map(|j| j.component.as_str())
        .unwrap_or("jre-legacy"); // composant Mojang pour Java 8
    let java = ensure_java(java_component, required_java, &mc_dir, &client, &app).await?;
    let java_major = detect_java_major_version(&java).await.unwrap_or(17);
    let console_label = console_label.to_string();
    log_to_console(&app, &console_label, &format!("MC {} requiert Java {} — utilise : {}", version_id, required_java, java), "out");

    let (main_class, extra_classpath, extra_game_args, extra_jvm_args) =
        match loader.unwrap_or("vanilla") {
            "fabric" => setup_fabric(version_id, &libraries_dir, &game_dir.join("mods"), &app).await?,
            "forge" => setup_forge(version_id, &mc_dir, &libraries_dir, &java, &app).await?,
            _ => (details.main_class.clone(), vec![], vec![], vec![]),
        };

    // ── P2P setup ────────────────────────────────────────────────────────────
    // Démarre le signaling, télécharge les mappings Mojang et prépare les javaagents.
    // Le JAR original Minecraft est utilisé directement — le remapping est assuré à
    // l'exécution par MappingsRegistry (IRemapper Mixin) et les appels de réflexion.
    let (effective_client_jar, p2p_jvm_args, p2p_extra_cp) = if p2p {
        p2p::start_signaling(app.clone());

        // Copier rust_core.dll dans natives_dir pour que -Djava.library.path le trouve
        let dll_name = if cfg!(target_os = "windows") { "rust_core.dll" } else { "librust_core.so" };
        let dll_src = p2p::p2p_dir().join(dll_name);
        if dll_src.exists() {
            tokio::fs::copy(&dll_src, natives_dir.join(dll_name)).await.ok();
        } else {
            tracing::warn!("[P2P] {} manquant dans {} — JNI désactivé", dll_name, p2p::p2p_dir().display());
        }

        // Télécharger les mappings Mojang (quelques Ko, rapide)
        let mappings_path = p2p::ensure_mappings(version_id, &client, &app).await?;

        let mixin_jar     = p2p::p2p_dir().join("mixin.jar");
        let agent_jar     = p2p::p2p_dir().join("p2p-agent.jar");
        let asm_jar       = p2p::p2p_dir().join("asm-9.5.jar");
        let asm_tree_jar  = p2p::p2p_dir().join("asm-tree-9.5.jar");

        if !mixin_jar.exists() {
            return Err(anyhow!(
                "mixin.jar manquant dans {}\n  Copier P2P-Server/p2p-agent/lib/mixin.jar vers ce dossier",
                p2p::p2p_dir().display()
            ));
        }
        if !agent_jar.exists() {
            return Err(anyhow!(
                "p2p-agent.jar manquant dans {}\n  Compiler P2P-Server/p2p-agent/ et copier le JAR vers ce dossier",
                p2p::p2p_dir().display()
            ));
        }

        // MixinAgent (dans mixin.jar) déclare registerTargetClass(String, ClassNode).
        // Le JVM résout toutes les signatures déclarées au chargement de la classe, donc
        // org.objectweb.asm.tree.ClassNode doit être sur le classpath AVANT que mixin.jar
        // soit traité comme javaagent. On ajoute asm-9.5.jar et asm-tree-9.5.jar au -cp.
        let mut extra_cp: Vec<String> = Vec::new();
        for jar in [&asm_jar, &asm_tree_jar] {
            if jar.exists() {
                extra_cp.push(jar.to_string_lossy().to_string());
            } else {
                tracing::warn!("[P2P] {} manquant — peut causer NoClassDefFoundError au démarrage", jar.display());
            }
        }

        // Le peerId = PeerId libp2p base58 : c'est le code que l'hôte partage en jeu.
        let peer_id = p2p::start_libp2p().await.unwrap_or_else(|e| {
            tracing::warn!("[P2P] libp2p non démarré: {} — fallback UUID", e);
            uuid::Uuid::new_v4().to_string()
        });
        log_to_console(&app, &console_label, &format!("[P2P] Code de session : {}", peer_id), "out");
        // mixin.jar DOIT être listé AVANT p2p-agent.jar : MixinAgent.premain() capture
        // l'Instrumentation que MixinBootstrap.init() utilisera ensuite.
        let mixin_arg = format!("-javaagent:{}", mixin_jar.display());
        let agent_arg = format!(
            "-javaagent:{}=peerId={},name={},server=ws://127.0.0.1:{},mappings={}",
            agent_jar.display(), peer_id, session.username, p2p::SIGNALING_PORT,
            mappings_path.display(),
        );

        log_to_console(&app, &console_label, &format!("[P2P] Mixin    : {}", mixin_arg), "out");
        log_to_console(&app, &console_label, &format!("[P2P] Agent    : {}", agent_arg), "out");
        log_to_console(&app, &console_label, &format!("[P2P] Mappings : {}", mappings_path.display()), "out");
        (client_jar.clone(), vec![mixin_arg, agent_arg], extra_cp)
    } else {
        (client_jar.clone(), vec![], vec![])
    };

    // ── Attente des assets ────────────────────────────────────────────────────
    // Libs + loader terminés, on attend que les assets finissent avant de lancer.
    assets_task.await.map_err(|e| anyhow!("Tâche assets : {}", e))??;

    let mc_game_dir: PathBuf = game_dir.to_path_buf();

    // ── Launch ───────────────────────────────────────────────────────────────

    set_progress(&app, 95, 100, "Lancement de Minecraft...");

    let classpath_sep = if cfg!(target_os = "windows") { ";" } else { ":" };

    let mut full_classpath: Vec<String> = extra_classpath;
    full_classpath.extend(p2p_extra_cp); // asm-9.5.jar + asm-tree-9.5.jar avant tout le reste
    full_classpath.extend(classpath);
    full_classpath.push(effective_client_jar.to_string_lossy().to_string());
    let classpath_str = dedup_classpath(full_classpath).join(classpath_sep);

    let mut args = build_jvm_args(ram_mb, &natives_dir, java_major);
    let gc_msg = if java_major >= 21 {
        format!("Java {} détecté — ZGC Generational activé", java_major)
    } else {
        format!("Java {} détecté — G1GC client activé", java_major)
    };
    log_to_console(&app, &console_label, &gc_msg, "out");
    args.extend(extra_jvm_args);
    args.extend(p2p_jvm_args);
    args.extend(["-cp".to_string(), classpath_str, main_class]);
    args.extend(build_game_args(&details, session, &mc_game_dir, &assets_dir, version_id));
    args.extend(extra_game_args);
    // Laisser à la fenêtre console le temps d'enregistrer ses listeners JS
    // avant de spawner Java — évite de perdre les premières lignes de log
    // quand tout est en cache et que le lancement est quasi-instantané.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    // Passe le timer Windows à 1ms (défaut : 15ms) pour réduire le jitter de scheduling
    #[cfg(target_os = "windows")]
    unsafe { timeBeginPeriod(1); }

    let log_path = mc_game_dir.join("logs").join("latest.log");
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_tailer = stop_flag.clone();
    let app_log = app.clone();
    let label_log = console_label.clone();

    let mut child = tokio::process::Command::new(&java)
        .args(&args)
        .current_dir(&mc_game_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()?;

    let stdout = child.stdout.take().map(BufReader::new);
    let stderr = child.stderr.take().map(BufReader::new);

    let app_out = app.clone();
    let label_out = console_label.clone();
    let app_err = app.clone();
    let label_err = console_label.clone();

    if let Some(mut reader) = stdout {
        tokio::spawn(async move {
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                let trimmed = line.trim_end().to_string();
                log_to_console(&app_out, &label_out, &trimmed, "out");
                line.clear();
            }
        });
    }

    if let Some(mut reader) = stderr {
        tokio::spawn(async move {
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                let trimmed = line.trim_end().to_string();
                log_to_console(&app_err, &label_err, &trimmed, "err");
                line.clear();
            }
        });
    }

    // Tailer logs/latest.log — Minecraft route ses logs via log4j2 vers ce fichier
    // plutôt que vers stdout, donc on lit le fichier directement.
    let log_tailer = tokio::spawn(async move {
        // Démarrer à la fin du fichier existant pour ignorer les logs des sessions précédentes.
        // Quand Minecraft recrée le fichier (taille < last_len), on repart de 0.
        let current_end = tokio::fs::metadata(&log_path).await.map(|m| m.len()).unwrap_or(0);
        let mut pos: u64 = current_end;
        let mut last_len: u64 = current_end;

        loop {
            if let Ok(metadata) = tokio::fs::metadata(&log_path).await {
                let len = metadata.len();
                if len < last_len {
                    // Fichier recréé au démarrage — recommencer depuis le début
                    pos = 0;
                }
                last_len = len;

                if len > pos {
                    if let Ok(mut file) = tokio::fs::File::open(&log_path).await {
                        if file.seek(std::io::SeekFrom::Start(pos)).await.is_ok() {
                            let mut reader = BufReader::new(file);
                            let mut line = String::new();
                            loop {
                                line.clear();
                                match reader.read_line(&mut line).await {
                                    Ok(0) => break,
                                    Ok(n) => {
                                        pos += n as u64;
                                        let trimmed = line.trim_end().to_string();
                                        if !trimmed.is_empty() {
                                            log_to_console(&app_log, &label_log, &trimmed, "out");
                                        }
                                    }
                                    Err(_) => break,
                                }
                            }
                        }
                    }
                }
            }

            if stop_flag_tailer.load(Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    });

    // Clear progress — game is now running
    state.write().await.download_progress = None;
    let status = child.wait().await?;
    tracing::info!("Minecraft terminé — code de sortie : {}", status);

    // Arrêter le tailer et attendre qu'il finisse de vider les dernières lignes
    stop_flag.store(true, Ordering::Relaxed);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), log_tailer).await;

    // Restaure la résolution du timer Windows
    #[cfg(target_os = "windows")]
    unsafe { timeEndPeriod(1); }

    Ok(())
}

// ── Loader setup helpers ──────────────────────────────────────────────────────

async fn setup_fabric(
    mc_version: &str,
    libraries_dir: &PathBuf,
    mods_dir: &PathBuf,
    app: &tauri::AppHandle,
) -> Result<(String, Vec<String>, Vec<String>, Vec<String>)> {
    set_progress(app, 72, 100, "Téléchargement Fabric Loader...");

    let profile = fabric::get_latest_profile(mc_version).await?;

    if let Err(e) = fabric::ensure_fabric_api(mc_version, mods_dir).await {
        tracing::warn!("Fabric API auto-install échoué: {}", e);
    }

    set_progress(app, 74, 100, "Résolution des dépendances des mods...");
    if let Err(e) = deps::resolve_and_install_deps(mc_version, "fabric", mods_dir, app).await {
        tracing::warn!("Résolution des dépendances échouée: {}", e);
    }

    let mut fabric_cp = Vec::new();
    let total = profile.libraries.len();
    for (i, lib) in profile.libraries.iter().enumerate() {
        if let Some(path) = fabric::download_library(lib, libraries_dir).await {
            fabric_cp.push(path.to_string_lossy().to_string());
        }
        if i % 5 == 0 {
            set_progress(app, 72 + i as u64 * 20 / total.max(1) as u64, 100, &format!("Fabric libs {}/{}", i + 1, total));
        }
    }

    let extra_jvm: Vec<String> = profile
        .arguments
        .as_ref()
        .and_then(|a| a.jvm.as_ref())
        .map(|jvm| jvm.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    Ok((profile.main_class, fabric_cp, vec![], extra_jvm))
}

async fn setup_forge(
    mc_version: &str,
    mc_dir: &PathBuf,
    libraries_dir: &PathBuf,
    java: &str,
    app: &tauri::AppHandle,
) -> Result<(String, Vec<String>, Vec<String>, Vec<String>)> {
    set_progress(app, 70, 100, "Recherche de la version Forge...");

    let forge_ver = forge::fetch_latest_version(mc_version).await?;
    tracing::info!("Forge {} pour MC {}", forge_ver, mc_version);

    if !forge::is_installed(mc_version, &forge_ver, mc_dir) {
        set_progress(app, 72, 100, "Téléchargement de l'installeur Forge...");
        forge::install(mc_version, &forge_ver, mc_dir, java).await?;
    }

    let forge_json = forge::read_version_json(mc_version, &forge_ver, mc_dir)?;
    let mut forge_cp = Vec::new();

    if let Some(libs) = &forge_json.libraries {
        let total = libs.len();
        for (i, lib) in libs.iter().enumerate() {
            if let Some(path) = forge::download_library(lib, libraries_dir).await {
                forge_cp.push(path.to_string_lossy().to_string());
            }
            if i % 5 == 0 {
                set_progress(app, 80 + i as u64 * 12 / total.max(1) as u64, 100, &format!("Forge libs {}/{}", i + 1, total));
            }
        }
    }

    let extra_game: Vec<String> = forge_json
        .arguments.as_ref().and_then(|a| a.game.as_ref())
        .map(|g| g.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let extra_jvm: Vec<String> = forge_json
        .arguments.as_ref().and_then(|a| a.jvm.as_ref())
        .map(|j| j.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    Ok((forge_json.main_class, forge_cp, extra_game, extra_jvm))
}

// ── JVM args ─────────────────────────────────────────────────────────────────

async fn detect_java_major_version(java: &str) -> Option<u32> {
    let out = tokio::process::Command::new(java)
        .arg("-version")
        .output()
        .await
        .ok()?;
    // java -version écrit sur stderr
    let text = String::from_utf8_lossy(&out.stderr);
    for line in text.lines() {
        if line.contains("version") {
            // Formats : `"21.0.2"` ou `"1.8.0_xxx"`
            if let (Some(s), Some(e)) = (line.find('"'), line.rfind('"')) {
                if s < e {
                    let ver = &line[s + 1..e];
                    let parts: Vec<&str> = ver.split('.').collect();
                    let major: u32 = parts[0].parse().ok()?;
                    return Some(if major == 1 {
                        parts.get(1)?.parse().ok()?
                    } else {
                        major
                    });
                }
            }
        }
    }
    None
}

fn build_jvm_args(ram_mb: u32, natives_dir: &PathBuf, java_major: u32) -> Vec<String> {
    let base = vec![
        format!("-Xmx{}m", ram_mb),
        format!("-Xms{}m", ram_mb),  // Xms = Xmx : pas de redimensionnement du heap
        format!("-Djava.library.path={}", natives_dir.display()),
        format!("-Dorg.lwjgl.librarypath={}", natives_dir.display()),
        "-XX:+DisableExplicitGC".into(),       // Ignore System.gc() appelés par les mods
        "-XX:+AlwaysPreTouch".into(),          // Pré-alloue les pages RAM au boot
        "-XX:+PerfDisableSharedMem".into(),    // Pas de fichiers perf OS (source de jitter)
        "-XX:+UseStringDeduplication".into(),  // Réduit les doublons String en mémoire
    ];

    if java_major >= 21 {
        // ── ZGC Generational (Java 21+) ───────────────────────────────────────
        // GC concurrent : collecte en parallèle du jeu → pauses < 1ms
        // Élimine les freezes récurrents de 200ms causés par G1 mixed collections
        let mut args = base;
        args.push("-XX:+UseZGC".into());
        // ZGenerational est le défaut depuis Java 24 — ne pas l'ajouter pour éviter le warning
        if java_major < 24 {
            args.push("-XX:+ZGenerational".into());
        }
        args.extend([
            "-XX:ZAllocationSpikeTolerance=5.0".into(),
            "-XX:+UnlockExperimentalVMOptions".into(),
        ]);
        args
    } else {
        // ── G1GC (Java 17/18/19/20) ──────────────────────────────────────────
        // ZGC Generational non disponible, fallback G1GC avec tuning client
        let region_size = if ram_mb >= 12288 { "16M" }
            else if ram_mb >= 6144 { "8M" }
            else if ram_mb >= 3072 { "4M" }
            else { "2M" };
        let mut args = base;
        args.extend([
            "-XX:+UseG1GC".into(),
            "-XX:+ParallelRefProcEnabled".into(),
            "-XX:MaxGCPauseMillis=100".into(),
            "-XX:+UnlockExperimentalVMOptions".into(),
            format!("-XX:G1HeapRegionSize={}", region_size),
            "-XX:G1NewSizePercent=30".into(),
            "-XX:G1MaxNewSizePercent=40".into(),
            "-XX:G1ReservePercent=20".into(),
            "-XX:G1HeapWastePercent=5".into(),
            "-XX:G1MixedGCCountTarget=4".into(),
            "-XX:InitiatingHeapOccupancyPercent=20".into(),
            "-XX:G1MixedGCLiveThresholdPercent=90".into(),
            "-XX:G1RSetUpdatingPauseTimePercent=5".into(),
            "-XX:SurvivorRatio=32".into(),
            "-XX:MaxTenuringThreshold=1".into(),
        ]);
        args
    }
}

// Lien vers la WinAPI multimédia (timer haute résolution)
#[cfg(target_os = "windows")]
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(uPeriod: u32) -> u32;
    fn timeEndPeriod(uPeriod: u32) -> u32;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn dedup_classpath(entries: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        let key = artifact_key(&entry);
        if seen.insert(key) {
            result.push(entry);
        }
    }
    result
}

fn artifact_key(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let marker = "/libraries/";
    if let Some(idx) = normalized.rfind(marker) {
        let rel = &normalized[idx + marker.len()..];
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.len() >= 3 {
            let group_artifact = parts[..parts.len() - 2].join("/");
            let filename = parts.last().unwrap_or(&"");
            // Les JARs natifs ("-natives-") ont une clé unique par fichier :
            // on ne les déduplique pas entre eux (x86_64 ≠ arm64),
            // et ils ne doivent pas effacer le JAR principal du même artifact.
            if filename.contains("-natives-") {
                return format!("{}/{}", group_artifact, filename);
            }
            return group_artifact;
        }
    }
    normalized
}

fn should_download_library(lib: &Library) -> bool {
    let os_name = if cfg!(target_os = "windows") { "windows" } else if cfg!(target_os = "macos") { "osx" } else { "linux" };
    let Some(rules) = &lib.rules else { return true };
    let mut allowed = true;
    for rule in rules {
        let action = rule.get("action").and_then(|a| a.as_str()).unwrap_or("allow");
        if let Some(os) = rule.get("os") {
            if let Some(name) = os.get("name").and_then(|n| n.as_str()) {
                if name == os_name { allowed = action == "allow"; } else if action == "allow" { allowed = false; }
            }
        } else {
            allowed = action == "allow";
        }
    }
    allowed
}

fn artifact_path(base: &PathBuf, artifact: &Artifact, name: &str) -> PathBuf {
    if let Some(ref p) = artifact.path { return base.join(p); }
    library_jar_path(base, name)
}

fn library_jar_path(base: &PathBuf, name: &str) -> PathBuf {
    let parts: Vec<&str> = name.split(':').collect();
    if parts.len() < 3 { return base.join(name); }
    let group_path = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    let classifier = parts.get(3).copied().unwrap_or("");
    let filename = if classifier.is_empty() {
        format!("{}-{}.jar", artifact, version)
    } else {
        format!("{}-{}-{}.jar", artifact, version, classifier)
    };
    base.join(group_path).join(artifact).join(version).join(filename)
}

async fn extract_natives(jar_path: &PathBuf, natives_dir: &PathBuf) -> Result<()> {
    let jar_bytes = tokio::fs::read(jar_path).await?;
    let cursor = std::io::Cursor::new(jar_bytes);
    let mut archive = zip::ZipArchive::new(cursor)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().to_string();
        if name.starts_with("META-INF") || name.ends_with('/') { continue; }
        let is_native = name.ends_with(".dll") || name.ends_with(".so") || name.ends_with(".dylib") || name.ends_with(".jnilib");
        if !is_native { continue; }
        let file_name = std::path::Path::new(&name).file_name().unwrap_or_default().to_string_lossy().to_string();
        let out_path = natives_dir.join(&file_name);
        if !out_path.exists() {
            let mut out = std::fs::File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    Ok(())
}

fn build_game_args(
    details: &VersionDetails,
    session: &MinecraftSession,
    game_dir: &std::path::Path,
    assets_dir: &PathBuf,
    version_id: &str,
) -> Vec<String> {
    let assets_root = assets_dir.to_string_lossy().into_owned();
    let game_dir_str = game_dir.to_string_lossy().into_owned();
    let replacements: &[(&str, &str)] = &[
        ("${auth_player_name}", &session.username),
        ("${version_name}", version_id),
        ("${game_directory}", &game_dir_str),
        ("${assets_root}", &assets_root),
        ("${assets_index_name}", &details.asset_index.id),
        ("${auth_uuid}", &session.uuid),
        ("${auth_access_token}", &session.access_token),
        ("${user_type}", "msa"),
        ("${version_type}", "release"),
        // Vieilles versions (1.7.x–1.12.x)
        ("${user_properties}", "{}"),
        ("${game_assets}", &assets_root),
        ("${auth_session}", &session.access_token),
    ];

    let apply = |s: &str| -> String {
        let mut out = s.to_string();
        for (k, v) in replacements { out = out.replace(k, v); }
        out
    };

    let mut args = Vec::new();
    if let Some(ref mc_args) = details.minecraft_arguments {
        for part in mc_args.split_whitespace() { args.push(apply(part)); }
    } else if let Some(ref arguments) = details.arguments {
        for val in &arguments.game {
            if let serde_json::Value::String(s) = val { args.push(apply(s)); }
        }
    }
    args
}

const MOJANG_JAVA_MANIFEST: &str =
    "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

/// Retourne un exécutable Java prêt à l'emploi pour `required_major`.
/// Ordre de priorité : JAVA_HOME → install système → runtime Mojang en cache → téléchargement Mojang.
pub async fn ensure_java(
    component: &str,
    required_major: u32,
    mc_dir: &PathBuf,
    client: &reqwest::Client,
    app: &tauri::AppHandle,
) -> Result<String> {
    // 1. JAVA_HOME
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let exe = PathBuf::from(&home).join("bin").join(java_exe_name());
        if exe.exists() {
            if let Some(v) = detect_java_major_version(&exe.to_string_lossy()).await {
                if v >= required_major {
                    return Ok(exe.to_string_lossy().to_string());
                }
            }
        }
    }

    // 2. Installation système
    if let Some(java) = find_system_java(required_major) {
        return Ok(java);
    }

    // 3. Runtime Mojang déjà téléchargé
    let runtime_dir = mc_dir.join("runtime").join(component);
    let java_exe = if cfg!(target_os = "macos") {
        runtime_dir.join("jre.bundle").join("Contents").join("Home").join("bin").join("java")
    } else {
        runtime_dir.join("bin").join(java_exe_name())
    };
    if java_exe.exists() {
        return Ok(java_exe.to_string_lossy().to_string());
    }

    // 4. Téléchargement depuis Mojang
    tracing::info!("Java {} ({}) introuvable — téléchargement depuis Mojang", required_major, component);
    set_progress(app, 12, 100, &format!("Téléchargement Java {} (Mojang)...", required_major));
    download_mojang_runtime(component, &runtime_dir, client, app).await?;

    if java_exe.exists() {
        Ok(java_exe.to_string_lossy().to_string())
    } else {
        Err(anyhow!("Runtime Java installé mais introuvable à {}", java_exe.display()))
    }
}

async fn download_mojang_runtime(
    component: &str,
    dest: &PathBuf,
    client: &reqwest::Client,
    app: &tauri::AppHandle,
) -> Result<()> {
    let platform = mojang_platform_key();

    let all: serde_json::Value = client.get(MOJANG_JAVA_MANIFEST).send().await?.json().await?;

    let manifest_url = all
        .get(platform).and_then(|p| p.get(component))
        .and_then(|c| c.get(0)).and_then(|e| e.get("manifest"))
        .and_then(|m| m.get("url")).and_then(|u| u.as_str())
        .ok_or_else(|| anyhow!("Runtime Mojang '{}' indisponible pour '{}'", component, platform))?
        .to_string();

    let file_manifest: serde_json::Value = client.get(&manifest_url).send().await?.json().await?;
    let files = file_manifest["files"]
        .as_object()
        .ok_or_else(|| anyhow!("Manifest Java invalide"))?;

    // Crée d'abord tous les répertoires (pas de concurrence nécessaire)
    for (rel_path, info) in files.iter() {
        if info["type"].as_str() == Some("directory") {
            tokio::fs::create_dir_all(dest.join(rel_path)).await?;
        }
    }

    let total = files.len() as u64;
    let sem = Arc::new(Semaphore::new(24));
    let mut tasks: JoinSet<Result<()>> = JoinSet::new();

    for (rel_path, info) in files.iter() {
        match info["type"].as_str().unwrap_or("") {
            "file" => {
                let url = info["downloads"]["raw"]["url"].as_str().unwrap_or("").to_string();
                let executable = info["executable"].as_bool().unwrap_or(false);
                let file_dest = dest.join(rel_path);
                let sem = sem.clone();
                let client = client.clone();
                tasks.spawn(async move {
                    if !file_dest.exists() {
                        let _permit = sem.acquire().await.unwrap();
                        if let Some(p) = file_dest.parent() {
                            tokio::fs::create_dir_all(p).await?;
                        }
                        download_file(&client, &url, &file_dest).await?;
                    }
                    #[cfg(unix)]
                    if executable {
                        use std::os::unix::fs::PermissionsExt;
                        tokio::fs::set_permissions(&file_dest, std::fs::Permissions::from_mode(0o755)).await?;
                    }
                    let _ = executable;
                    Ok::<(), anyhow::Error>(())
                });
            }
            #[cfg(unix)]
            "link" => {
                let target = info["target"].as_str().unwrap_or("").to_string();
                let link = dest.join(rel_path);
                if !link.exists() {
                    if let Some(p) = link.parent() { tokio::fs::create_dir_all(p).await?; }
                    tokio::fs::symlink(&target, &link).await.ok();
                }
            }
            _ => {}
        }
    }

    let mut done = 0u64;
    while let Some(r) = tasks.join_next().await {
        r??;
        done += 1;
        if done % 100 == 0 || done == total {
            set_progress(app, 12 + done * 8 / total.max(1), 100,
                &format!("Java runtime {}/{}", done, total));
        }
    }
    Ok(())
}

fn mojang_platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        if cfg!(target_arch = "aarch64") { "windows-arm64" }
        else if cfg!(target_pointer_width = "64") { "windows-x64" }
        else { "windows-x86" }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") { "mac-os-arm64" } else { "mac-os" }
    } else {
        if cfg!(target_pointer_width = "64") { "linux" } else { "linux-i386" }
    }
}

/// Cherche un JDK système compatible avec `required_major`.
/// Java 8 : version exacte requise (LaunchWrapper incompatible Java 9+).
/// Java 9+ : version minimale (n'importe quelle version >= required_major convient).
fn find_system_java(required_major: u32) -> Option<String> {
    let roots: &[&str] = if cfg!(target_os = "windows") {
        &[
            r"C:\Program Files\Java",
            r"C:\Program Files\Eclipse Adoptium",
            r"C:\Program Files\Microsoft",
            r"C:\Program Files\BellSoft",
            r"C:\Program Files\Amazon Corretto",
            r"C:\Program Files\Semeru Runtime",
        ]
    } else if cfg!(target_os = "macos") {
        &["/Library/Java/JavaVirtualMachines"]
    } else {
        &["/usr/lib/jvm", "/usr/local/lib/jvm", "/opt/java"]
    };

    // Java 8 : version exacte (LaunchWrapper incompatible Java 9+).
    // Java 9+ : version exacte uniquement — versions plus récentes (ex : Java 24 avec MC
    // qui requiert 21) changent l'ordre d'init des classes et font crasher LWJGL 3.3.3
    // nativement en présence d'un agent JVM. ensure_java() télécharge le runtime Mojang sinon.
    let max_major = required_major;

    let mut best: Option<(u32, String)> = None;
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else { continue };
        for entry in entries.flatten() {
            let dir_name = entry.file_name().to_string_lossy().to_lowercase();
            let Some(major) = java_major_from_dir_name(&dir_name) else { continue };
            if major < required_major || major > max_major { continue; }
            let exe = if cfg!(target_os = "macos") {
                entry.path().join("Contents").join("Home").join("bin").join("java")
            } else {
                entry.path().join("bin").join(java_exe_name())
            };
            if exe.exists() && (best.is_none() || major < best.as_ref().unwrap().0) {
                best = Some((major, exe.to_string_lossy().to_string()));
            }
        }
    }
    best.map(|(_, p)| p)
}

fn java_exe_name() -> &'static str {
    if cfg!(target_os = "windows") { "java.exe" } else { "java" }
}

/// Extrait la version majeure depuis un nom de répertoire JDK.
/// Reconnaît : "jdk-21", "jre-21", "jdk-21.0.3+9", "java-21-openjdk-amd64", "temurin-21", etc.
fn java_major_from_dir_name(name: &str) -> Option<u32> {
    let stripped = name
        .strip_prefix("jdk-")
        .or_else(|| name.strip_prefix("jre-"))
        .or_else(|| name.strip_prefix("java-"))
        .or_else(|| name.strip_prefix("temurin-"))
        .or_else(|| name.strip_prefix("corretto-"))
        .or_else(|| name.strip_prefix("semeru-"))?;
    stripped.split(['.', '+', '-', '_']).next()?.parse().ok()
}

async fn download_file(client: &reqwest::Client, url: &str, path: &PathBuf) -> Result<()> {
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("Download failed {}: {}", url, resp.status()));
    }
    let bytes = resp.bytes().await?;
    let mut file = tokio::fs::File::create(path).await?;
    file.write_all(&bytes).await?;
    Ok(())
}
