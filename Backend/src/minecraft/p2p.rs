use std::collections::HashMap;
use std::io;
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tungstenite::{accept, Message};

use crate::minecraft::p2p_libp2p::{BridgeEvent, P2PLibp2pHandle};

pub const SIGNALING_PORT: u16 = 8765;

// ── Paths ─────────────────────────────────────────────────────────────────────

/// Dossier P2P dans AppData/YuyuFrame/p2p/
/// Doit contenir : p2p-agent.jar, mixin.jar, rust_core.dll
pub fn p2p_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("YuyuFrame")
        .join("p2p")
}

// ── Signaling server ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Msg {
    Join      { id: String, name: String },
    Position  { id: String, x: i32, z: i32 },
    PeerList  { peers: Vec<PeerEntry> },
    PeerJoined { id: String, name: String, x: i32, z: i32 },
    PeerLeft  { id: String },
    /// Déclenché par le Mixin en jeu quand le joueur entre le code de l'hôte.
    /// Le signaling se charge d'établir la connexion libp2p vers la cible.
    ConnectTo { target: String },
    /// Relay de données entre pairs.
    /// `to` absent = broadcast à tous sauf `from`.
    /// `to` présent = unicast vers le pair ciblé.
    Data {
        from: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        payload: String,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct PeerEntry { id: String, name: String, x: i32, z: i32 }

struct PeerHandle {
    name: String,
    x: i32,
    z: i32,
    tx: std::sync::mpsc::Sender<String>,
}

type PeerMap = Arc<Mutex<HashMap<String, PeerHandle>>>;

static SIGNALING_STARTED: OnceLock<()> = OnceLock::new();
static PEERS_GLOBAL: OnceLock<PeerMap> = OnceLock::new();

fn peers_global() -> &'static PeerMap {
    PEERS_GLOBAL.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Démarre le signaling WebSocket en arrière-plan (idempotent).
pub fn start_signaling(app: tauri::AppHandle) {
    SIGNALING_STARTED.get_or_init(|| {
        let peers: PeerMap = peers_global().clone();
        let pm = peers.clone();
        // Capture le handle tokio pour que handle_peer puisse spawner des tâches async
        // (notamment pour déclencher join_libp2p sur réception de ConnectTo).
        let rt = tokio::runtime::Handle::current();
        thread::spawn(move || {
            let listener = match TcpListener::bind(("127.0.0.1", SIGNALING_PORT)) {
                Ok(l) => l,
                Err(e) => {
                    tracing::error!("[P2P Signaling] Bind impossible sur le port {}: {}", SIGNALING_PORT, e);
                    return;
                }
            };
            tracing::info!("[P2P Signaling] En écoute sur ws://127.0.0.1:{}", SIGNALING_PORT);
            for stream in listener.incoming().flatten() {
                let pm = pm.clone();
                let rt = rt.clone();
                thread::spawn(move || handle_peer(stream, pm, rt));
            }
        });
    });
}

fn send_all(peers: &PeerMap, exclude: &str, json: &str) {
    let map = peers.lock().unwrap();
    for (id, p) in map.iter() {
        if id != exclude {
            p.tx.send(json.to_owned()).ok();
        }
    }
}

fn handle_peer(stream: TcpStream, peers: PeerMap, rt: tokio::runtime::Handle) {
    stream.set_read_timeout(Some(Duration::from_millis(10))).ok();
    stream.set_nodelay(true).ok();

    let mut ws = match accept(stream) {
        Ok(w)  => w,
        Err(_) => return,
    };

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let mut my_id: Option<String> = None;

    loop {
        while let Ok(msg) = rx.try_recv() {
            if ws.send(Message::Text(msg.into())).is_err() { return; }
        }

        match ws.read() {
            Ok(Message::Text(raw)) => {
                let raw = raw.to_string();
                match serde_json::from_str::<Msg>(&raw) {
                    Ok(Msg::Join { id, name }) => {
                        let list = {
                            let map = peers.lock().unwrap();
                            let entries: Vec<PeerEntry> = map.iter()
                                .map(|(eid, p)| PeerEntry { id: eid.clone(), name: p.name.clone(), x: p.x, z: p.z })
                                .collect();
                            serde_json::to_string(&Msg::PeerList { peers: entries }).unwrap()
                        };
                        tx.send(list).ok();

                        peers.lock().unwrap().insert(id.clone(), PeerHandle {
                            name: name.clone(), x: 0, z: 0, tx: tx.clone(),
                        });
                        my_id = Some(id.clone());

                        let joined = serde_json::to_string(&Msg::PeerJoined {
                            id: id.clone(), name: name.clone(), x: 0, z: 0,
                        }).unwrap();
                        send_all(&peers, &id, &joined);

                        // Informe les machines distantes qu'un pair a rejoint
                        if let Some(handle) = P2PLibp2pHandle::get_global() {
                            handle.try_send_json(raw.clone());
                        }

                        tracing::info!("[P2P Signaling] + {} ({}...)", name, &id[..8.min(id.len())]);
                    }
                    Ok(Msg::ConnectTo { target }) => {
                        tracing::info!("[P2P Signaling] ConnectTo demandé → {}", &target[..target.len().min(12)]);
                        rt.spawn(async move {
                            if let Err(e) = join_libp2p(target).await {
                                tracing::error!("[P2P] ConnectTo échoué : {}", e);
                            }
                        });
                    }
                    Ok(Msg::Position { id, x, z }) => {
                        if let Some(p) = peers.lock().unwrap().get_mut(&id) {
                            p.x = x; p.z = z;
                        }
                        send_all(&peers, &id, &raw);
                        // Propage la position aux machines distantes
                        if let Some(handle) = P2PLibp2pHandle::get_global() {
                            handle.try_send_json(raw.clone());
                        }
                    }
                    Ok(Msg::Data { ref from, ref to, ref payload }) => {
                        let out = serde_json::to_string(&Msg::Data {
                            from: from.clone(),
                            to: to.clone(),
                            payload: payload.clone(),
                        }).unwrap();
                        match to {
                            Some(target) => {
                                // Unicast : local d'abord, puis libp2p si pair absent localement
                                let delivered_locally = {
                                    let map = peers.lock().unwrap();
                                    if let Some(peer) = map.get(target.as_str()) {
                                        peer.tx.send(out.clone()).ok();
                                        true
                                    } else {
                                        false
                                    }
                                };
                                if !delivered_locally {
                                    if let Some(handle) = P2PLibp2pHandle::get_global() {
                                        handle.try_send_json(out);
                                    }
                                }
                            }
                            None => {
                                // Broadcast local + inter-machine via libp2p
                                send_all(&peers, from, &out);
                                if let Some(handle) = P2PLibp2pHandle::get_global() {
                                    handle.try_send_json(out.clone());
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Message::Ping(d)) => { ws.send(Message::Pong(d)).ok(); }
            Ok(Message::Close(_)) => break,
            Err(tungstenite::Error::Io(e))
                if e.kind() == io::ErrorKind::WouldBlock
                || e.kind() == io::ErrorKind::TimedOut => {}
            Err(_) => break,
            _ => {}
        }
    }

    if let Some(id) = my_id {
        let name = peers.lock().unwrap()
            .remove(&id).map(|p| p.name).unwrap_or_default();
        let left = serde_json::to_string(&Msg::PeerLeft { id: id.clone() }).unwrap();
        send_all(&peers, &id, &left);
        // Informe les machines distantes que le pair est parti
        if let Some(handle) = P2PLibp2pHandle::get_global() {
            handle.try_send_json(left.clone());
        }
        tracing::info!("[P2P Signaling] - {} déconnecté", name);
    }
}

// ── Libp2p — démarrage et bridge ─────────────────────────────────────────────

/// Démarre le nœud libp2p et retourne le code de session (PeerID base58).
pub async fn start_libp2p() -> Result<String> {
    if let Some(handle) = P2PLibp2pHandle::get_global() {
        return Ok(handle.session_code());
    }

    let (handle, mut bridge_rx) = P2PLibp2pHandle::start().await?;
    let code = handle.session_code();
    P2PLibp2pHandle::set_global(handle);

    // Bridge task : messages libp2p → clients WebSocket locaux
    tokio::spawn(async move {
        while let Some(event) = bridge_rx.recv().await {
            let peers = peers_global();
            match event {
                BridgeEvent::Message(json) => {
                    // Transformer join → peer_joined pour les clients locaux
                    let injected = transform_for_local_clients(&json);
                    let map = peers.lock().unwrap();
                    for peer in map.values() {
                        peer.tx.send(injected.clone()).ok();
                    }
                }
                BridgeEvent::PeerLeft(peer_id) => {
                    let left = serde_json::to_string(&Msg::PeerLeft { id: peer_id }).unwrap();
                    let map = peers.lock().unwrap();
                    for peer in map.values() {
                        peer.tx.send(left.clone()).ok();
                    }
                }
            }
        }
    });

    tracing::info!("[P2P libp2p] Démarré — code: {}", &code[..12]);
    Ok(code)
}

/// Connecte au pair distant via son code de session (PeerID base58).
pub async fn join_libp2p(peer_id: String) -> Result<()> {
    let handle = P2PLibp2pHandle::get_global()
        .ok_or_else(|| anyhow!("libp2p non démarré — appelez p2p_start d'abord"))?;
    handle.connect_to(peer_id).await
}

/// Transforme un message reçu du pair distant pour l'injecter dans les clients locaux.
/// Principalement : join {id, name} → peer_joined {id, name, x:0, z:0}
fn transform_for_local_clients(json: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
        if v["type"] == "join" {
            return serde_json::to_string(&serde_json::json!({
                "type": "peer_joined",
                "id":   v["id"],
                "name": v["name"],
                "x": 0, "z": 0
            })).unwrap_or_else(|_| json.to_string());
        }
    }
    json.to_string()
}

// ── Mappings Mojang ───────────────────────────────────────────────────────────

/// Télécharge (si absent) et retourne le chemin vers `client-mappings-<ver>.txt`.
/// Remplace l'ancien `ensure_mapped_jar` — plus besoin de remapper.jar.
pub async fn ensure_mappings(
    version: &str,
    client: &reqwest::Client,
    app: &tauri::AppHandle,
) -> Result<PathBuf> {
    let cache_dir = p2p_dir().join("cache");
    tokio::fs::create_dir_all(&cache_dir).await?;

    let mappings = cache_dir.join(format!("client-mappings-{}.txt", version));
    if mappings.exists() {
        tracing::info!("[P2P] Mappings en cache : {}", mappings.display());
        return Ok(mappings);
    }

    download_mappings(version, &mappings, client, app).await?;
    Ok(mappings)
}

async fn download_mappings(
    version: &str,
    dest: &Path,
    client: &reqwest::Client,
    app: &tauri::AppHandle,
) -> Result<()> {
    tracing::info!("[P2P] Téléchargement des mappings Mojang pour {}...", version);
    let _ = app.emit("download_progress", serde_json::json!({
        "current": 0, "total": 100,
        "message": format!("P2P : mappings Mojang {}...", version)
    }));

    let manifest: serde_json::Value = client
        .get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
        .send().await?.json().await?;

    let ver_url = manifest["versions"]
        .as_array()
        .and_then(|a| a.iter().find(|v| v["id"].as_str() == Some(version)))
        .and_then(|v| v["url"].as_str())
        .ok_or_else(|| anyhow!("Version {} introuvable dans le manifest Mojang", version))?
        .to_owned();

    let ver_data: serde_json::Value = client.get(&ver_url).send().await?.json().await?;

    let url = ver_data["downloads"]["client_mappings"]["url"]
        .as_str()
        .ok_or_else(|| anyhow!(
            "Pas de client_mappings pour {} — version < 1.14.4 non supportée", version
        ))?
        .to_owned();

    tracing::info!("[P2P] Mappings URL : {}", url);
    let bytes = client.get(&url).send().await?.bytes().await?;
    tokio::fs::write(dest, &bytes).await?;
    tracing::info!("[P2P] Mappings → {}", dest.display());
    Ok(())
}
