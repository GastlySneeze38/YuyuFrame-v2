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
    /// Présent uniquement sur le format legacy (pré-1.13) à la place de
    /// `arguments.game` — contient notamment `--tweakClass ...`, indispensable
    /// pour que Forge s'injecte dans le launchwrapper.
    #[serde(rename = "minecraftArguments")]
    pub minecraft_arguments: Option<String>,
}

#[derive(Deserialize)]
pub struct ForgeLibrary {
    pub name: String,
    pub downloads: Option<ForgeLibDownloads>,
    /// Dépôt maven de base — uniquement présent sur le format legacy (pré-1.13)
    /// qui n'a pas de bloc `downloads.artifact.url`.
    #[serde(default)]
    pub url: Option<String>,
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

/// Trouve un dossier de version déjà installé correspondant à ce MC+build Forge.
/// On ne déduit pas l'id depuis un format fixe : les vieux Forge pré-1.13
/// (1.7.x à ~1.12) utilisent des ids irréguliers selon la version (casse,
/// suffixe dupliqué...), donc on recherche plutôt un dossier existant dont le
/// nom contient à la fois la version MC et le build Forge.
pub fn find_installed(mc_version: &str, forge_ver: &str, mc_dir: &PathBuf) -> Option<String> {
    let versions_dir = mc_dir.join("versions");
    let entries = std::fs::read_dir(&versions_dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains(forge_ver) && name.contains(mc_version) && entry.path().join(format!("{}.json", name)).exists() {
            return Some(name);
        }
    }
    None
}

enum InstallerProfile {
    /// Installeur récent (>= ~1.13) : peut s'installer en ligne de commande
    /// via `--installClient`.
    Modern { id: String },
    /// Installeur pré-1.13 : son `SimpleInstaller` n'a **aucun** mode
    /// headless pour le client (il ouvre toujours une fenêtre Swing — testé
    /// empiriquement, `--installClient` n'existe même pas dans son parseur
    /// d'options). On reproduit donc l'installation nous-mêmes à partir du
    /// profil embarqué.
    Legacy { id: String, profile: serde_json::Value },
}

/// Inspecte l'installeur téléchargé pour déterminer son format et l'id réel
/// de version qu'il va produire, sans deviner via un pattern de chaîne (les
/// vieux Forge ont des ids irréguliers selon la version : casse, suffixe
/// dupliqué...).
fn inspect_installer(installer_path: &PathBuf) -> Result<InstallerProfile> {
    use std::io::Read;
    let bytes = std::fs::read(installer_path)?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)?;

    if let Ok(mut entry) = archive.by_name("version.json") {
        let mut content = String::new();
        entry.read_to_string(&mut content)?;
        let v: serde_json::Value = serde_json::from_str(&content)?;
        if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
            return Ok(InstallerProfile::Modern { id: id.to_string() });
        }
    }

    let mut entry = archive
        .by_name("install_profile.json")
        .map_err(|_| anyhow!("Installeur Forge invalide (profil introuvable)"))?;
    let mut content = String::new();
    entry.read_to_string(&mut content)?;
    let profile: serde_json::Value = serde_json::from_str(&content)?;
    let id = profile
        .get("versionInfo")
        .and_then(|vi| vi.get("id"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| anyhow!("Impossible de déterminer l'ID de version Forge"))?
        .to_string();
    Ok(InstallerProfile::Legacy { id, profile })
}

/// Écrit le version json et télécharge les libs (incluant le universal jar
/// Forge) décrits par le profil legacy — équivalent du travail que ferait le
/// `SimpleInstaller` GUI pour un client.
async fn install_legacy(version_id: &str, profile: &serde_json::Value, mc_dir: &PathBuf, libraries_dir: &PathBuf) -> Result<()> {
    let version_info = profile
        .get("versionInfo")
        .ok_or_else(|| anyhow!("Profil Forge legacy invalide"))?;

    let version_dir = mc_dir.join("versions").join(version_id);
    tokio::fs::create_dir_all(&version_dir).await?;
    tokio::fs::write(
        version_dir.join(format!("{}.json", version_id)),
        serde_json::to_vec_pretty(version_info)?,
    )
    .await?;

    // L'artefact Forge lui-même est publié sous un nom de fichier différent
    // (`install.filePath`, ex: "...-universal.jar") de son nom maven standard
    // — on le récupère sous ce nom distant mais on le range localement sous
    // le nom standard pour que la résolution générique des libs le retrouve.
    let forge_artifact_name = profile.pointer("/install/path").and_then(|v| v.as_str());
    let forge_file_name = profile.pointer("/install/filePath").and_then(|v| v.as_str());

    let libraries = version_info
        .get("libraries")
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();

    for lib in libraries {
        let Some(name) = lib.get("name").and_then(|v| v.as_str()) else { continue };
        let parts: Vec<&str> = name.split(':').collect();
        if parts.len() < 3 {
            continue;
        }
        let group = parts[0].replace('.', "/");
        let art = parts[1];
        let ver = parts[2];
        let local_path = libraries_dir.join(&group).join(art).join(ver).join(format!("{}-{}.jar", art, ver));

        if let Some(parent) = local_path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if local_path.exists() {
            continue;
        }

        let base = lib.get("url").and_then(|v| v.as_str()).unwrap_or("https://libraries.minecraft.net/");
        let remote_file = if Some(name) == forge_artifact_name {
            forge_file_name.map(|s| s.to_string()).unwrap_or_else(|| format!("{}-{}.jar", art, ver))
        } else {
            format!("{}-{}.jar", art, ver)
        };
        let url = format!("{}{}/{}/{}/{}", base, group, art, ver, remote_file);

        if let Ok(resp) = reqwest::Client::new().get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = resp.bytes().await {
                    let _ = tokio::fs::write(&local_path, &bytes).await;
                }
            }
        }
    }

    Ok(())
}

/// Download the Forge installer and run it targeting `mc_dir`. Returns the
/// real installed version id (cf. [`inspect_installer`]).
pub async fn install(
    mc_version: &str,
    forge_ver: &str,
    mc_dir: &PathBuf,
    libraries_dir: &PathBuf,
    java: &str,
) -> Result<String> {
    let installer_name = format!("forge-{}-{}-installer.jar", mc_version, forge_ver);
    // Forge moderne (>= ~1.13) range ses installeurs sous "{mc}-{forge}/".
    // Forge pré-1.13 a régulièrement répété la version MC dans le dossier :
    // "{mc}-{forge}-{mc}/". On essaie le format moderne puis on retombe sur
    // l'ancien si le serveur répond 404.
    let modern_url = format!("{}{}-{}/{}", FORGE_MAVEN, mc_version, forge_ver, installer_name);
    let legacy_installer_name = format!("forge-{}-{}-{}-installer.jar", mc_version, forge_ver, mc_version);
    let legacy_url = format!("{}{}-{}-{}/{}", FORGE_MAVEN, mc_version, forge_ver, mc_version, legacy_installer_name);

    let temp = mc_dir.join(".forge-installer");
    tokio::fs::create_dir_all(&temp).await?;
    let installer_path = temp.join(&installer_name);

    if !installer_path.exists() {
        let client = reqwest::Client::new();
        tracing::info!("Téléchargement installeur Forge depuis {}", modern_url);
        let mut resp = client.get(&modern_url).send().await?;
        if !resp.status().is_success() {
            tracing::info!("Format moderne introuvable ({}), essai du format legacy {}", resp.status(), legacy_url);
            resp = client.get(&legacy_url).send().await?;
            if !resp.status().is_success() {
                return Err(anyhow!(
                    "Téléchargement installeur Forge échoué: {}",
                    resp.status()
                ));
            }
        }
        let bytes = resp.bytes().await?;
        tokio::fs::write(&installer_path, &bytes).await?;
    }

    let profile = inspect_installer(&installer_path)?;

    let result = match profile {
        InstallerProfile::Modern { id } => {
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

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                Err(anyhow!("Installeur Forge échoué:\n{}", stderr))
            } else {
                Ok(id)
            }
        }
        InstallerProfile::Legacy { id, profile } => {
            tracing::info!("Installation manuelle du profil Forge legacy {}...", id);
            install_legacy(&id, &profile, mc_dir, libraries_dir).await.map(|_| id)
        }
    };

    // Clean up installer temp dir regardless of outcome
    let _ = tokio::fs::remove_dir_all(&temp).await;

    result
}

/// Read and parse the installed Forge version JSON, given its resolved id
/// (cf. [`find_installed`] / [`install`]).
pub fn read_version_json(version_id: &str, mc_dir: &PathBuf) -> Result<ForgeVersionJson> {
    let path = mc_dir
        .join("versions")
        .join(version_id)
        .join(format!("{}.json", version_id));
    let content = std::fs::read_to_string(&path)
        .map_err(|_| anyhow!("Forge non installé: {}", version_id))?;
    serde_json::from_str(&content).map_err(|e| anyhow!("Version Forge invalide: {}", e))
}

/// Download a Forge-specific library and return its local path. Handles both
/// the modern `downloads.artifact` shape and the legacy (pré-1.13) shape
/// where a library only has `name` + an optional base maven `url`.
pub async fn download_library(lib: &ForgeLibrary, libraries_dir: &PathBuf) -> Option<PathBuf> {
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

    let (local_path, url) = if let Some(downloads) = lib.downloads.as_ref() {
        let artifact = downloads.artifact.as_ref()?;
        let local_path = match &artifact.path {
            Some(rel_path) => libraries_dir.join(rel_path),
            None => libraries_dir.join(&group).join(art).join(ver).join(&fname),
        };
        (local_path, artifact.url.clone())
    } else {
        let local_path = libraries_dir.join(&group).join(art).join(ver).join(&fname);
        let base = lib.url.clone().unwrap_or_else(|| "https://libraries.minecraft.net/".to_string());
        (local_path, format!("{}{}/{}/{}/{}", base, group, art, ver, fname))
    };

    if let Some(parent) = local_path.parent() {
        if tokio::fs::create_dir_all(parent).await.is_err() {
            return None;
        }
    }

    if !local_path.exists() && !url.is_empty() {
        if let Ok(resp) = reqwest::Client::new().get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = resp.bytes().await {
                    let _ = tokio::fs::write(&local_path, &bytes).await;
                }
            }
        }
    }

    if local_path.exists() { Some(local_path) } else { None }
}
