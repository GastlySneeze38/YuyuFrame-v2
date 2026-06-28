use tauri::{Emitter, Manager};

use crate::commands::instances::instance_dir;
use crate::db;
use crate::minecraft::{auth, launcher};
use crate::state::{MinecraftSession, SharedState};

#[tauri::command]
pub async fn launch_game(
    state: tauri::State<'_, SharedState>,
    app: tauri::AppHandle,
    instance_id: String,
    p2p: Option<bool>,
    avoid_beta: Option<bool>,
) -> Result<(), String> {
    let session = {
        let s = state.read().await;
        s.session.clone().ok_or("Non connecté à Minecraft")?
    };

    // Refresh the MC token if it expires within the next 5 minutes
    let session = refresh_if_needed(session, &state).await?;

    if state.read().await.is_instance_running(&instance_id) {
        return Err(format!("L'instance {} est déjà en cours", instance_id));
    }

    let yuyu_user_id = {
        let s = state.read().await;
        s.current_yuyu_user_id().unwrap_or(0)
    };

    let instance = {
        let s = state.read().await;
        let db = s.db.lock().await;
        db::instance_get(&db, &instance_id, yuyu_user_id)
            .map_err(|e| e.to_string())?
            .ok_or("Instance introuvable")?
    };
    let instance = crate::commands::instances::Instance {
        id: instance.id,
        name: instance.name,
        mc_version: instance.mc_version,
        loader: instance.loader,
        ram_mb: instance.ram_mb,
        favorite: instance.favorite,
        description: instance.description,
    };

    let game_dir = instance_dir(&instance_id);
    tokio::fs::create_dir_all(&game_dir).await.map_err(|e| e.to_string())?;

    // Open or reopen the console window (label unique par instance)
    let window_label = format!("mc-console-{}", &instance_id[..8.min(instance_id.len())]);
    if let Some(existing) = app.get_webview_window(&window_label) {
        let _ = existing.close();
    }
    let _ = tauri::WebviewWindowBuilder::new(
        &app,
        &window_label,
        tauri::WebviewUrl::App(std::path::PathBuf::from("console")),
    )
    .title(format!("Console — {}", instance.name))
    .inner_size(960.0, 620.0)
    .decorations(false)
    .build();

    state.write().await.running_instances.insert(instance_id.clone());
    let _ = app.emit("game_state", serde_json::json!({
        "running": true,
        "instance_id": &instance_id,
    }));

    let state_clone = state.inner().clone();

    tokio::spawn(async move {
        let started_at = chrono::Utc::now().timestamp();

        let session_id: Option<i64> = {
            let s = state_clone.read().await;
            let db = s.db.lock().await;
            db::session_start(
                &db,
                yuyu_user_id,
                &instance.id,
                &instance.name,
                &instance.mc_version,
                &instance.loader,
            )
            .ok()
        };

        if let Err(e) = launcher::download_and_launch(
            &instance.mc_version,
            Some(&instance.loader),
            &session,
            instance.ram_mb,
            &game_dir,
            app.clone(),
            state_clone.clone(),
            p2p.unwrap_or(false),
            avoid_beta.unwrap_or(true),
            &window_label,
        )
        .await
        {
            tracing::error!("Erreur de lancement: {}", e);
            let _ = app.emit("launch_error", e.to_string());
        }

        if let Some(sid) = session_id {
            let duration = chrono::Utc::now().timestamp() - started_at;
            let s = state_clone.read().await;
            let db = s.db.lock().await;
            let _ = db::session_end(&db, sid, duration);
        }

        state_clone.write().await.running_instances.remove(&instance_id);
        let _ = app.emit("game_state", serde_json::json!({
            "running": false,
            "instance_id": &instance_id,
        }));
    });

    Ok(())
}

async fn refresh_if_needed(
    session: MinecraftSession,
    state: &tauri::State<'_, SharedState>,
) -> Result<MinecraftSession, String> {
    let now = chrono::Utc::now().timestamp();
    // Refresh if the token expires within 5 minutes
    if session.expires_at > now + 300 {
        return Ok(session);
    }

    let refresh_token = session
        .refresh_token
        .as_deref()
        .ok_or("Token MC expiré mais pas de refresh_token — reconnectez-vous")?
        .to_string();

    tracing::info!("Token MC expiré — rafraîchissement en cours...");

    let (mc_access_token, mc_username, mc_uuid, new_refresh_token, expires_at) =
        auth::refresh_session(&refresh_token)
            .await
            .map_err(|e| format!("Échec du rafraîchissement du token MC : {}", e))?;

    let new_session = MinecraftSession {
        username: mc_username,
        uuid: mc_uuid,
        access_token: mc_access_token,
        refresh_token: Some(new_refresh_token.clone()),
        expires_at,
    };

    // Persist to state and DB
    {
        let s = state.read().await;
        let yuyu_user_id = s.current_yuyu_user_id().unwrap_or(0);
        let db = s.db.lock().await;
        let _ = db::update_mc_tokens(
            &db,
            yuyu_user_id,
            &new_session.uuid,
            &new_session.access_token,
            &new_refresh_token,
            expires_at,
        );
    }
    state.write().await.session = Some(new_session.clone());

    tracing::info!("Token MC rafraîchi — expire dans 24h");
    Ok(new_session)
}

#[tauri::command]
pub async fn reload_agent() -> Result<(), String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "Variable APPDATA introuvable".to_string())?;
    let trigger = std::path::Path::new(&appdata)
        .join("YuyuFrame")
        .join("p2p")
        .join("reload.trigger");

    if let Some(parent) = trigger.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string();

    tokio::fs::write(&trigger, ts).await.map_err(|e| e.to_string())?;
    Ok(())
}
