mod commands;
mod db;
mod minecraft;
mod state;

/// Miroir de `Frontend/src/config/beta.ts` — pendant la beta, le frontend
/// saute l'écran de connexion YuyuFrame, mais le backend l'ignorait
/// totalement et continuait à exiger un `yuyu_session` valide pour lier un
/// compte Minecraft (auth_start_device/auth_poll), bloquant tout le monde en
/// beta. Garder les deux flags synchronisés à la main (pas de mécanisme de
/// partage Frontend/Backend pour cette constante).
pub const BETA_TEST: bool = true;

use std::sync::Arc;
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

pub fn run() {
    // Le build release tourne en `windows_subsystem = "windows"` (cf.
    // main.rs) — aucune console n'est attachée, donc tous les logs qui
    // s'affichaient en dev étaient invisibles en prod, rendant tout bug
    // spécifique au build buildé impossible à diagnostiquer. On écrit
    // maintenant aussi dans un fichier `yuyuframe.log`, en plus du stdout
    // pour le dev. Toujours dans %APPDATA%\YuyuFrame\.minecraft (jamais dans
    // CARGO_MANIFEST_DIR) : en dev ce dossier est surveillé par `cargo
    // watch`, donc chaque écriture de log déclenchait un rebuild en boucle.
    let log_dir = dirs::data_dir()
        .map(|d| d.join("YuyuFrame").join(".minecraft"))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    std::fs::create_dir_all(&log_dir).ok();
    let file_appender = tracing_appender::rolling::never(&log_dir, "yuyuframe.log");
    let (non_blocking, _log_guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_subscriber::fmt::layer().with_writer(non_blocking).with_ansi(false))
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let db_path = if cfg!(dev) {
                // Dev : garde la DB dans Backend/ à côté du code source
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("yuyu.db")
            } else {
                // Prod : à côté de l'exécutable
                std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|d| d.join("yuyu.db")))
                    .unwrap_or_else(|| std::path::PathBuf::from("yuyu.db"))
            };

            let conn = db::init_db(&db_path).expect("Impossible d'initialiser la base de données");
            tracing::info!("Base de données : {}", db_path.display());

            let yuyu_session = db::load_yuyu_jwt(&conn)
                .ok()
                .flatten()
                .map(|row| {
                    tracing::info!("Session YuyuFrame restaurée pour {}", row.username);
                    // Adopte les instances orphelines (yuyu_user_id = 0) au redémarrage
                    db::instance_claim_unclaimed(&conn, row.user_id).ok();
                    state::YuyuSession {
                        user_id: row.user_id,
                        username: row.username,
                        token: row.jwt,
                        plan: row.plan,
                        plan_expires_at: row.plan_expires_at,
                    }
                });

            // Restaurer la session MC active depuis la DB. En BETA_TEST il n'y a
            // jamais de `yuyu_session` (login YuyuFrame skippé), donc gater cette
            // restauration sur sa présence faisait que `session` restait toujours
            // `None` au démarrage — le jeu refusait de se lancer depuis Home tant
            // qu'on n'était pas passé par mc_switch (page Login) pour le repeupler
            // en mémoire. 0 est le même placeholder "pas de compte" qu'ailleurs
            // (cf. commentaire dans `commands::mc::current_yuyu_user_id`).
            let mc_yuyu_user_id = yuyu_session.as_ref().map(|ys| ys.user_id).unwrap_or(0);
            let mc_session = (|| {
                let active_uuid = db::get_active_mc_uuid(&conn, mc_yuyu_user_id).ok().flatten()?;
                let row = db::get_mc_session(&conn, mc_yuyu_user_id, &active_uuid).ok().flatten()?;
                tracing::info!("Session Minecraft restaurée pour {}", row.mc_username);
                Some(state::MinecraftSession {
                    username: row.mc_username,
                    uuid: row.mc_uuid,
                    access_token: row.access_token,
                    refresh_token: Some(row.ms_refresh_token),
                    expires_at: row.expires_at,
                })
            })();

            let app_state: state::SharedState = Arc::new(RwLock::new(state::AppState {
                db: Arc::new(Mutex::new(conn)),
                yuyu_session,
                session: mc_session,
                download_progress: None,
                running_instances: std::collections::HashSet::new(),
                auth_device_code: None,
            }));

            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::yuyu::yuyu_status,
            commands::yuyu::yuyu_register,
            commands::yuyu::yuyu_login,
            commands::yuyu::yuyu_logout,
            commands::yuyu::yuyu_refresh_plan,
            commands::yuyu::yuyu_create_checkout,
            commands::yuyu::yuyu_dev_simulate_payment,
            commands::auth::auth_start_device,
            commands::auth::auth_poll,
            commands::auth::auth_status,
            commands::auth::auth_logout,
            commands::mc::mc_list_accounts,
            commands::mc::mc_switch,
            commands::mc::mc_delete,
            commands::versions::list_versions,
            commands::launch::launch_game,
            commands::launch::reload_agent,
            commands::mods::mods_list,
            commands::mods::mods_toggle,
            commands::mods::mods_delete,
            commands::mods::mods_install,
            commands::mods::mods_upload,
            commands::mods::mods_import_optifine,
            commands::mods::mod_icon,
            commands::mods::mods_check_update_safety,
            commands::modpack::modpack_fetch_index,
            commands::modpack::modpack_install,
            commands::modpack::modpack_remove,
            commands::modpack::modpack_rename_file,
            commands::modpack::modpack_get_meta,
            commands::instances::instance_list,
            commands::instances::instance_create,
            commands::instances::instance_delete,
            commands::instances::instance_update,
            commands::instances::instance_toggle_favorite,
            commands::instances::instance_duplicate,
            commands::instances::instance_startup_sync,
            commands::sync::sync_list_instances,
            commands::sync::sync_list_saves,
            commands::sync::sync_push_instance,
            commands::sync::sync_pull_instance,
            commands::sync::sync_delete_instance,
            commands::stats::stats_get,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
