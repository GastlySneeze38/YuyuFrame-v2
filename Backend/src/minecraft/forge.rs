use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

const FORGE_PROMOTIONS: &str =
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN: &str =
    "https://maven.minecraftforge.net/net/minecraftforge/forge/";

#[derive(Deserialize)]
struct ForgePromos {
    promos: HashMap<String, String>,
}

/// Subset of the Forge installed version JSON (similar structure to vanilla).
#[derive(Deserialize)]
pub struct ForgeVersionJson {
    #[serde(rename = "mainClass")]
    pub main_class: String,
    pub libraries: Option<Vec<ForgeLibrary>>,
    pub arguments: Option<ForgeArguments>,
}

#[derive(Deserialize)]
pub struct ForgeLibrary {
    pub name: String,
    pub downloads: Option<ForgeLibDownloads>,
}

#[derive(Deserialize)]
pub struct ForgeLibDownloads {
    pub artifact: Option<ForgeArtifact>,
}

#[derive(Deserialize, Clone)]
pub struct ForgeArtifact {
    pub url: String,
    pub path: Option<String>,
}

#[derive(Deserialize)]
pub struct ForgeArguments {
    pub game: Option<Vec<serde_json::Value>>,
    pub jvm: Option<Vec<serde_json::Value>>,
}

/// Returns the Forge version string (e.g. "54.0.1") for a given MC version.
pub async fn fetch_latest_version(mc_version: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let promos: ForgePromos = client
        .get(FORGE_PROMOTIONS)
        .send()
        .await?
        .json()
        .await
        .map_err(|_| anyhow!("Impossible de contacter le serveur Forge"))?;

    let recommended = format!("{}-recommended", mc_version);
    let latest = format!("{}-latest", mc_version);

    promos
        .promos
        .get(&recommended)
        .or_else(|| promos.promos.get(&latest))
        .cloned()
        .ok_or_else(|| anyhow!("Aucune version Forge pour Minecraft {}", mc_version))
}

/// Version ID as stored in .minecraft/versions/ after installation.
pub fn version_id(mc_version: &str, forge_ver: &str) -> String {
    format!("{}-forge-{}", mc_version, forge_ver)
}

/// Check whether the Forge version profile is already installed.
pub fn is_installed(mc_version: &str, forge_ver: &str, mc_dir: &PathBuf) -> bool {
    let vid = version_id(mc_version, forge_ver);
    mc_dir
        .join("versions")
        .join(&vid)
        .join(format!("{}.json", vid))
        .exists()
}

/// Download the Forge installer and run it targeting `mc_dir`.
pub async fn install(
    mc_version: &str,
    forge_ver: &str,
    mc_dir: &PathBuf,
    java: &str,
) -> Result<()> {
    let installer_name = format!("forge-{}-{}-installer.jar", mc_version, forge_ver);
    let url = format!("{}{}-{}/{}", FORGE_MAVEN, mc_version, forge_ver, installer_name);

    let temp = mc_dir.join(".forge-installer");
    tokio::fs::create_dir_all(&temp).await?;
    let installer_path = temp.join(&installer_name);

    if !installer_path.exists() {
        tracing::info!("Téléchargement installeur Forge depuis {}", url);
        let client = reqwest::Client::new();
        let resp = client.get(&url).send().await?;
        if !resp.status().is_success() {
            return Err(anyhow!(
                "Téléchargement installeur Forge échoué: {}",
                resp.status()
            ));
        }
        let bytes = resp.bytes().await?;
        tokio::fs::write(&installer_path, &bytes).await?;
    }

    tracing::info!("Lancement installeur Forge...");
    let output = tokio::process::Command::new(java)
        .args([
            "-jar",
            &installer_path.to_string_lossy(),
            "--installClient",
            &mc_dir.to_string_lossy(),
        ])
        .current_dir(mc_dir)
        .output()
        .await?;

    // Clean up installer temp dir regardless of outcome
    let _ = tokio::fs::remove_dir_all(&temp).await;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("Installeur Forge échoué:\n{}", stderr));
    }

    Ok(())
}

/// Read and parse the installed Forge version JSON.
pub fn read_version_json(mc_version: &str, forge_ver: &str, mc_dir: &PathBuf) -> Result<ForgeVersionJson> {
    let vid = version_id(mc_version, forge_ver);
    let path = mc_dir
        .join("versions")
        .join(&vid)
        .join(format!("{}.json", vid));
    let content = std::fs::read_to_string(&path)
        .map_err(|_| anyhow!("Forge non installé pour {}", mc_version))?;
    serde_json::from_str(&content).map_err(|e| anyhow!("Version Forge invalide: {}", e))
}

/// Download a Forge-specific library and return its local path.
pub async fn download_library(lib: &ForgeLibrary, libraries_dir: &PathBuf) -> Option<PathBuf> {
    let downloads = lib.downloads.as_ref()?;
    let artifact = downloads.artifact.as_ref()?;

    let local_path = if let Some(ref rel_path) = artifact.path {
        libraries_dir.join(rel_path)
    } else {
        let parts: Vec<&str> = lib.name.split(':').collect();
        if parts.len() < 3 {
            return None;
        }
        let group = parts[0].replace('.', "/");
        let art = parts[1];
        let ver = parts[2];
        let fname = if parts.len() > 3 {
            format!("{}-{}-{}.jar", art, ver, parts[3])
        } else {
            format!("{}-{}.jar", art, ver)
        };
        libraries_dir.join(&group).join(art).join(ver).join(fname)
    };

    if let Some(parent) = local_path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return None;
        }
    }

    if !local_path.exists() && !artifact.url.is_empty() {
        if let Ok(resp) = reqwest::Client::new().get(&artifact.url).send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = resp.bytes().await {
                    let _ = tokio::fs::write(&local_path, &bytes).await;
                }
            }
        }
    }

    if local_path.exists() { Some(local_path) } else { None }
}
