use serde::Serialize;

use crate::{db, state::SharedState};

#[derive(Serialize)]
pub struct InstanceStat {
    pub instance_id: String,
    pub instance_name: String,
    pub mc_version: String,
    pub loader: String,
    pub sessions: i64,
    pub total_secs: i64,
}

#[derive(Serialize)]
pub struct RecentSession {
    pub instance_name: String,
    pub mc_version: String,
    pub loader: String,
    pub started_at: i64,
    pub duration_secs: i64,
}

#[derive(Serialize)]
pub struct DailyStat {
    pub date: String,
    pub secs: i64,
}

#[derive(Serialize)]
pub struct StatsPayload {
    pub total_sessions: i64,
    pub total_secs: i64,
    pub per_instance: Vec<InstanceStat>,
    pub recent_sessions: Vec<RecentSession>,
    pub daily: Vec<DailyStat>,
}

#[tauri::command]
pub async fn stats_get(state: tauri::State<'_, SharedState>) -> Result<StatsPayload, String> {
    let s = state.read().await;
    let user_id = s.current_yuyu_user_id().unwrap_or(0);
    let db = s.db.lock().await;

    let (total_sessions, total_secs) =
        db::stats_totals(&db, user_id).map_err(|e| e.to_string())?;

    let per_instance = db::stats_per_instance(&db, user_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| InstanceStat {
            instance_id: r.instance_id,
            instance_name: r.instance_name,
            mc_version: r.mc_version,
            loader: r.loader,
            sessions: r.sessions,
            total_secs: r.total_secs,
        })
        .collect();

    let since_14d = chrono::Utc::now().timestamp() - 14 * 24 * 3600;
    let daily = db::stats_daily(&db, user_id, since_14d)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| DailyStat { date: r.date, secs: r.secs })
        .collect();

    let recent_sessions = db::stats_recent_sessions(&db, user_id, 20)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| RecentSession {
            instance_name: r.instance_name,
            mc_version: r.mc_version,
            loader: r.loader,
            started_at: r.started_at,
            duration_secs: r.duration_secs.unwrap_or(0),
        })
        .collect();

    Ok(StatsPayload {
        total_sessions,
        total_secs,
        per_instance,
        recent_sessions,
        daily,
    })
}
