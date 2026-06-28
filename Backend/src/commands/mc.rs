use serde::Serialize;

use crate::{db, minecraft::auth as mc_auth, state::{SharedState, YuyuSession}, BETA_TEST};

/// Id à utiliser pour les requêtes DB liées aux comptes Minecraft. En beta,
/// pas de compte YuyuFrame requis — 0 est le placeholder "pas de compte"
/// déjà utilisé ailleurs dans le schéma (cf. table `instances`). Même bug
/// que celui corrigé dans auth.rs : ce guard existait à plusieurs endroits
/// ici aussi, bloquant `mc_list_accounts`/`mc_switch`/`mc_delete` en beta.
fn current_yuyu_user_id(yuyu_session: &Option<YuyuSession>) -> Result<i64, String> {
    match yuyu_session {
        Some(y) => Ok(y.user_id),
        None if BETA_TEST => Ok(0),
        None => Err("Non authentifié".into()),
    }
}

#[derive(Serialize)]
pub struct AccountInfo {
    pub mc_username: String,
    pub mc_uuid: String,
    pub is_active: bool,
}

#[tauri::command]
pub async fn mc_list_accounts(
    state: tauri::State<'_, SharedState>,
) -> Result<Vec<AccountInfo>, String> {
    let s = state.read().await;
    let yuyu_user_id = current_yuyu_user_id(&s.yuyu_session)?;
    let conn = s.db.lock().await;

    let rows = db::list_mc_sessions(&conn, yuyu_user_id).map_err(|e| e.to_string())?;
    let active_uuid = db::get_active_mc_uuid(&conn, yuyu_user_id).map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|r| AccountInfo {
            is_active: active_uuid.as_deref() == Some(&r.mc_uuid),
            mc_username: r.mc_username,
            mc_uuid: r.mc_uuid,
        })
        .collect())
}

#[tauri::command]
pub async fn mc_switch(
    state: tauri::State<'_, SharedState>,
    uuid: String,
) -> Result<AccountInfo, String> {
    let (yuyu_user_id, row) = {
        let s = state.read().await;
        let yuyu_user_id = current_yuyu_user_id(&s.yuyu_session)?;
        let conn = s.db.lock().await;
        let row = db::get_mc_session(&conn, yuyu_user_id, &uuid)
            .map_err(|e| e.to_string())?
            .ok_or("Compte introuvable")?;
        (yuyu_user_id, row)
    };

    let now = chrono::Utc::now().timestamp();
    let mc_session = if row.expires_at - now < 1800 {
        tracing::info!("Rafraîchissement du token lors du switch pour {}", row.mc_username);
        match mc_auth::refresh_session(&row.ms_refresh_token).await {
            Ok((mc_at, mc_user, mc_uuid, new_refresh, new_exp)) => {
                let s = state.read().await;
                let conn = s.db.lock().await;
                db::update_mc_tokens(&conn, yuyu_user_id, &mc_uuid, &mc_at, &new_refresh, new_exp).ok();
                drop(conn);
                drop(s);
                crate::state::MinecraftSession {
                    username: mc_user, uuid: mc_uuid, access_token: mc_at,
                    refresh_token: Some(new_refresh), expires_at: new_exp,
                }
            }
            Err(e) => {
                tracing::warn!("Échec du rafraîchissement: {}", e);
                crate::state::MinecraftSession {
                    username: row.mc_username.clone(), uuid: row.mc_uuid.clone(),
                    access_token: row.access_token.clone(),
                    refresh_token: Some(row.ms_refresh_token.clone()), expires_at: row.expires_at,
                }
            }
        }
    } else {
        crate::state::MinecraftSession {
            username: row.mc_username.clone(), uuid: row.mc_uuid.clone(),
            access_token: row.access_token.clone(),
            refresh_token: Some(row.ms_refresh_token.clone()), expires_at: row.expires_at,
        }
    };

    {
        let s = state.read().await;
        let conn = s.db.lock().await;
        db::set_active_mc(&conn, yuyu_user_id, &uuid).map_err(|e| e.to_string())?;
    }

    let info = AccountInfo {
        mc_username: mc_session.username.clone(),
        mc_uuid: mc_session.uuid.clone(),
        is_active: true,
    };
    state.write().await.session = Some(mc_session);
    Ok(info)
}

#[tauri::command]
pub async fn mc_delete(
    state: tauri::State<'_, SharedState>,
    uuid: String,
) -> Result<(), String> {
    {
        let s = state.read().await;
        let yuyu_user_id = current_yuyu_user_id(&s.yuyu_session)?;
        let conn = s.db.lock().await;
        db::delete_mc_session(&conn, yuyu_user_id, &uuid).map_err(|e| e.to_string())?;
        db::clear_active_mc(&conn, yuyu_user_id, &uuid).ok();
    }

    let mut w = state.write().await;
    if w.session.as_ref().map(|s| s.uuid.as_str()) == Some(uuid.as_str()) {
        w.session = None;
    }
    Ok(())
}
