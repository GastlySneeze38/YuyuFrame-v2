#![allow(dead_code)]

use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;

const VERSION_MANIFEST: &str =
    "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

#[derive(Debug, Deserialize)]
struct VersionManifest {
    versions: Vec<VersionInfo>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VersionInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub url: String,
}

pub async fn fetch_version_list() -> Result<Vec<VersionInfo>> {
    let client = reqwest::Client::new();
    let manifest: VersionManifest = client
        .get(VERSION_MANIFEST)
        .send()
        .await?
        .json()
        .await?;
    Ok(manifest
        .versions
        .into_iter()
        .filter(|v| v.version_type == "release" || v.version_type == "snapshot")
        .collect())
}

#[derive(Debug, Deserialize)]
pub struct JavaVersionInfo {
    pub component: String,
    #[serde(rename = "majorVersion")]
    pub major_version: u32,
}

#[derive(Debug, Deserialize)]
pub struct VersionDetails {
    pub id: String,
    #[serde(rename = "mainClass")]
    pub main_class: String,
    #[serde(rename = "minecraftArguments")]
    pub minecraft_arguments: Option<String>,
    pub arguments: Option<Arguments>,
    pub downloads: Downloads,
    pub libraries: Vec<Library>,
    #[serde(rename = "assetIndex")]
    pub asset_index: AssetIndex,
    #[serde(rename = "javaVersion")]
    pub java_version: Option<JavaVersionInfo>,
}

#[derive(Debug, Deserialize)]
pub struct Arguments {
    pub game: Vec<serde_json::Value>,
    pub jvm: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct Downloads {
    pub client: Artifact,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Artifact {
    pub url: String,
    pub sha1: String,
    pub size: u64,
    /// Relative path inside the libraries directory (e.g. "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar")
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Library {
    pub name: String,
    pub downloads: Option<LibraryDownloads>,
    pub rules: Option<Vec<serde_json::Value>>,
    /// Old format: maps OS name → classifier key (e.g. "windows" → "natives-windows")
    pub natives: Option<HashMap<String, String>>,
    pub extract: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LibraryDownloads {
    pub artifact: Option<Artifact>,
    /// Old format native JARs keyed by classifier ("natives-windows", etc.)
    pub classifiers: Option<HashMap<String, Artifact>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetIndex {
    pub id: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct AssetIndexFile {
    pub objects: HashMap<String, AssetObject>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetObject {
    pub hash: String,
    pub size: u64,
}

pub async fn fetch_version_details(url: &str) -> Result<VersionDetails> {
    let client = reqwest::Client::new();
    Ok(client.get(url).send().await?.json().await?)
}

pub async fn fetch_asset_index(url: &str) -> Result<AssetIndexFile> {
    let client = reqwest::Client::new();
    Ok(client.get(url).send().await?.json().await?)
}
