mod commands;
mod db;
mod minecraft;
mod state;

use std::sync::Arc;
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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

            // Restaurer la session MC active depuis la DB si un utilisateur est connecté
            let mc_session = yuyu_session.as_ref().and_then(|ys| {
                let active_uuid = db::get_active_mc_uuid(&conn, ys.user_id).ok().flatten()?;
                let row = db::get_mc_session(&conn, ys.user_id, &active_uuid).ok().flatten()?;
                tracing::info!("Session Minecraft restaurée pour {}", row.mc_username);
                Some(state::MinecraftSession {
                    username: row.mc_username,
                    uuid: row.mc_uuid,
                    access_token: row.access_token,
                    refresh_token: Some(row.ms_refresh_token),
                    expires_at: row.expires_at,
                })
            });

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
            commands::mods::mods_list,
            commands::mods::mods_toggle,
            commands::mods::mods_delete,
            commands::mods::mods_install,
            commands::mods::mods_upload,
            commands::mods::mod_icon,
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
