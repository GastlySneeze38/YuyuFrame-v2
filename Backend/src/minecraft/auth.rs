use anyhow::{anyhow, Result};
use serde::Deserialize;

use crate::state::MinecraftSession;

const MS_CLIENT_ID: &str = "00000000402B5328";
const MS_REDIRECT_URI: &str = "https://login.live.com/oauth20_desktop.srf";
const DEVICE_CODE_URL: &str = "https://login.live.com/oauth20_connect.srf";
const TOKEN_URL: &str = "https://login.live.com/oauth20_token.srf";
const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_AUTH_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";

// ── Response types ────────────────────────────────────────────────────────────

pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: i64,
}

#[derive(Deserialize)]
struct MsDeviceCodeResp {
    device_code: String,
    user_code: String,
    #[serde(alias = "verification_url")]
    verification_uri: String,
    expires_in: i64,
}

#[derive(Deserialize)]
struct MsTokenResp {
    access_token: Option<String>,
    refresh_token: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct XblResp {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    display_claims: XblDisplayClaims,
}

#[derive(Deserialize)]
struct XblDisplayClaims {
    xui: Vec<XblXui>,
}

#[derive(Deserialize)]
struct XblXui {
    uhs: String,
}

#[derive(Deserialize)]
struct XstsResp {
    #[serde(rename = "Token")]
    token: String,
}

#[derive(Deserialize)]
struct McAuthResp {
    access_token: String,
}

#[derive(Deserialize)]
struct McProfileResp {
    id: String,
    name: String,
}

// ── Shared Xbox auth chain ────────────────────────────────────────────────────

/// Exchange a Microsoft access token for a Minecraft access token + profile.
/// Returns (mc_access_token, mc_username, mc_uuid).
async fn xbox_auth_chain(
    client: &reqwest::Client,
    ms_access_token: &str,
) -> Result<(String, String, String)> {
    // Xbox Live
    let xbl_body = serde_json::json!({
        "Properties": {
            "AuthMethod": "RPS",
            "SiteName": "user.auth.xboxlive.com",
            "RpsTicket": format!("d={}", ms_access_token)
        },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    });
    let xbl_resp: XblResp = client
        .post(XBL_URL)
        .json(&xbl_body)
        .header("Accept", "application/json")
        .send()
        .await?
        .json()
        .await?;

    let userhash = xbl_resp
        .display_claims
        .xui
        .first()
        .ok_or_else(|| anyhow!("No userhash in XBL response"))?
        .uhs
        .clone();

    // XSTS
    let xsts_body = serde_json::json!({
        "Properties": {
            "SandboxId": "RETAIL",
            "UserTokens": [xbl_resp.token]
        },
        "RelyingParty": "rp://api.minecraftservices.com/",
        "TokenType": "JWT"
    });
    let xsts_resp: XstsResp = client
        .post(XSTS_URL)
        .json(&xsts_body)
        .header("Accept", "application/json")
        .send()
        .await?
        .json()
        .await?;

    // Minecraft auth
    let mc_body = serde_json::json!({
        "identityToken": format!("XBL3.0 x={};{}", userhash, xsts_resp.token)
    });
    let mc_resp: McAuthResp = client
        .post(MC_AUTH_URL)
        .json(&mc_body)
        .send()
        .await?
        .json()
        .await?;

    // Profile
    let profile: McProfileResp = client
        .get(MC_PROFILE_URL)
        .bearer_auth(&mc_resp.access_token)
        .send()
        .await?
        .json()
        .await?;

    Ok((mc_resp.access_token, profile.name, profile.id))
}

// ── Device code flow ──────────────────────────────────────────────────────────

pub async fn start_device_auth() -> Result<DeviceCodeResponse> {
    let client = reqwest::Client::new();
    let params = [
        ("client_id", MS_CLIENT_ID),
        ("scope", "XboxLive.signin offline_access"),
        ("redirect_uri", MS_REDIRECT_URI),
        ("response_type", "device_code"),
    ];
    let raw = client
        .post(DEVICE_CODE_URL)
        .form(&params)
        .send()
        .await?
        .text()
        .await?;
    tracing::debug!("MS device code raw response: {}", raw);
    let resp: MsDeviceCodeResp = serde_json::from_str(&raw)
        .map_err(|e| anyhow!("Échec parsing device code: {} — Body: {}", e, raw))?;
    Ok(DeviceCodeResponse {
        device_code: resp.device_code,
        user_code: resp.user_code,
        verification_uri: resp.verification_uri,
        expires_in: resp.expires_in,
    })
}

/// Polls Microsoft. Returns None if still pending, Some(session) on success.
pub async fn poll_device_auth(device_code: &str) -> Result<Option<MinecraftSession>> {
    let client = reqwest::Client::new();
    let params = [
        ("client_id", MS_CLIENT_ID),
        ("device_code", device_code),
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ("redirect_uri", MS_REDIRECT_URI),
    ];
    let raw = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await?
        .text()
        .await?;
    tracing::debug!("MS poll raw response: {}", raw);
    let resp: MsTokenResp = serde_json::from_str(&raw)
        .map_err(|e| anyhow!("Échec parsing poll: {} — Body: {}", e, raw))?;

    if let Some(err) = resp.error {
        if err == "authorization_pending" {
            return Ok(None);
        }
        return Err(anyhow!("Auth error: {}", err));
    }

    let ms_access_token = resp
        .access_token
        .ok_or_else(|| anyhow!("No MS access token"))?;
    let ms_refresh_token = resp.refresh_token;

    let (mc_access_token, mc_username, mc_uuid) =
        xbox_auth_chain(&client, &ms_access_token).await?;

    Ok(Some(MinecraftSession {
        username: mc_username,
        uuid: mc_uuid,
        access_token: mc_access_token,
        refresh_token: ms_refresh_token,
        expires_at: chrono::Utc::now().timestamp() + 86400,
    }))
}

// ── Token refresh ─────────────────────────────────────────────────────────────

/// Use a Microsoft refresh token to get a new Minecraft session.
/// Returns (mc_access_token, mc_username, mc_uuid, new_ms_refresh_token, new_expires_at).
pub async fn refresh_session(
    ms_refresh_token: &str,
) -> Result<(String, String, String, String, i64)> {
    let client = reqwest::Client::new();

    // Exchange refresh token for new MS access token
    let params = [
        ("client_id", MS_CLIENT_ID),
        ("refresh_token", ms_refresh_token),
        ("grant_type", "refresh_token"),
        ("scope", "XboxLive.signin offline_access"),
        ("redirect_uri", MS_REDIRECT_URI),
    ];
    let raw = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await?
        .text()
        .await?;
    tracing::debug!("MS refresh raw response: {}", raw);
    let resp: MsTokenResp = serde_json::from_str(&raw)
        .map_err(|e| anyhow!("Échec parsing refresh: {} — Body: {}", e, raw))?;

    if let Some(err) = resp.error {
        return Err(anyhow!("MS refresh error: {}", err));
    }

    let ms_access_token = resp
        .access_token
        .ok_or_else(|| anyhow!("No MS access token from refresh"))?;

    // Keep old refresh token if Microsoft didn't issue a new one
    let new_ms_refresh_token = resp
        .refresh_token
        .unwrap_or_else(|| ms_refresh_token.to_string());

    let (mc_access_token, mc_username, mc_uuid) =
        xbox_auth_chain(&client, &ms_access_token).await?;

    let expires_at = chrono::Utc::now().timestamp() + 86400;

    Ok((
        mc_access_token,
        mc_username,
        mc_uuid,
        new_ms_refresh_token,
        expires_at,
    ))
}
