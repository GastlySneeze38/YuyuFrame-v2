use serde::Serialize;

use crate::minecraft::versions;

#[derive(Serialize)]
pub struct VersionEntry {
    pub id: String,
    pub version_type: String,
    pub url: String,
}

#[tauri::command]
pub async fn list_versions() -> Result<Vec<VersionEntry>, String> {
    versions::fetch_version_list()
        .await
        .map(|list| {
            list.into_iter()
                .map(|v| VersionEntry { id: v.id, version_type: v.version_type, url: v.url })
                .collect()
        })
        .map_err(|e| e.to_string())
}
