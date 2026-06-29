#![allow(dead_code)]

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MinecraftSession {
    pub username: String,
    pub uuid: String,
    pub access_token: String,
    /// Microsoft OAuth refresh token (long-lived, stored en DB)
    pub refresh_token: Option<String>,
    pub expires_at: i64,
}

#[derive(Debug, Clone)]
pub struct YuyuSession {
    pub user_id: i64,
    pub username: String,
    pub token: String,
    pub plan: String,
    pub plan_expires_at: Option<i64>,
}

impl YuyuSession {
    fn plan_not_expired(&self) -> bool {
        self.plan_expires_at
            .map(|exp| exp > chrono::Utc::now().timestamp())
            .unwrap_or(true)
    }

    pub fn is_premium(&self) -> bool {
        (self.plan == "premium" || self.plan == "ultimate") && self.plan_not_expired()
    }

    pub fn is_ultimate(&self) -> bool {
        self.plan == "ultimate" && self.plan_not_expired()
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DownloadProgress {
    pub current: u64,
    pub total: u64,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct AuthDeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_at: i64,
}

pub struct AppState {
    pub db: Arc<Mutex<Connection>>,
    pub yuyu_session: Option<YuyuSession>,
    pub session: Option<MinecraftSession>,
    pub download_progress: Option<DownloadProgress>,
    pub running_instances: std::collections::HashSet<String>,
    pub auth_device_code: Option<AuthDeviceCode>,
}

impl AppState {
    pub fn is_instance_running(&self, id: &str) -> bool {
        self.running_instances.contains(id)
    }
    pub fn any_running(&self) -> bool {
        !self.running_instances.is_empty()
    }

    /// Id à utiliser pour les requêtes DB/state liées à un compte YuyuFrame.
    /// En `BETA_TEST`, il n'y a jamais de `yuyu_session` (le login YuyuFrame
    /// est skippé) — 0 est le placeholder "pas de compte" déjà utilisé dans
    /// le schéma (cf. table `instances`, colonne yuyu_user_id DEFAULT 0).
    /// Source unique de vérité : avant l'introduction de ce helper, ce même
    /// garde était dupliqué à la main dans `auth.rs`/`mc.rs`, et certains
    /// endroits (restauration de session au démarrage, `auth_logout`)
    /// l'oubliaient, bloquant des fonctionnalités entières en beta.
    pub fn current_yuyu_user_id(&self) -> Option<i64> {
        match &self.yuyu_session {
            Some(y) => Some(y.user_id),
            None if crate::BETA_TEST => Some(0),
            None => None,
        }
    }
}

pub type SharedState = Arc<RwLock<AppState>>;
