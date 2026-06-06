//! Couche libp2p pour la connexion P2P inter-machines (Couche 1).
//!
//! Flux :
//!   1. start() — génère/charge la clé Ed25519, construit le swarm, écoute en TCP
//!   2. Connexion aux relay nodes publics (bootstrap.libp2p.io)
//!   3. Réservation circuit relay → on devient joignable via relay
//!   4. connect_to(peer_id) — rejoint un pair via le relay, dcutr tente le hole punch
//!   5. Messages entrants → BridgeEvent::Message(json)
//!   6. Déconnexion pair → BridgeEvent::PeerLeft(peer_id)

use anyhow::{Context, Result};
use futures::StreamExt;
use libp2p::{
    dcutr, identify, multiaddr::Protocol, noise,
    relay,
    request_response::{self, ProtocolSupport},
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, Multiaddr, PeerId, StreamProtocol,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::OnceLock,
    time::Duration,
};
use tokio::sync::mpsc;

// ── Relay nodes publics de Protocol Labs ────────────────────────────────────

const RELAY_ADDRS: &[&str] = &[
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
];

// ── Type de message jeu (JSON encodé en CBOR sur le wire) ───────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameMsg(pub String);

// ── NetworkBehaviour ─────────────────────────────────────────────────────────

#[derive(NetworkBehaviour)]
struct Behaviour {
    relay_client: relay::client::Behaviour,
    identify:     identify::Behaviour,
    dcutr:        dcutr::Behaviour,
    rr:           request_response::cbor::Behaviour<GameMsg, ()>,
}

// ── Événements envoyés au bridge ─────────────────────────────────────────────

pub enum BridgeEvent {
    /// Message JSON reçu du pair distant
    Message(String),
    /// Le pair distant s'est déconnecté
    PeerLeft(String),
}

// ── Handle public ────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct P2PLibp2pHandle {
    pub peer_id: PeerId,
    cmd_tx: mpsc::Sender<Cmd>,
}

enum Cmd {
    Connect(String),   // peer_id cible (base58)
    Send(String),      // JSON à envoyer
}

static HANDLE: OnceLock<P2PLibp2pHandle> = OnceLock::new();

impl P2PLibp2pHandle {
    /// Démarre le nœud libp2p. Retourne le handle + le receiver des événements bridge.
    pub async fn start() -> Result<(Self, mpsc::Receiver<BridgeEvent>)> {
        let keypair   = load_or_generate_keypair()?;
        let peer_id   = keypair.public().to_peer_id();
        let relay_ids = known_relay_peer_ids();

        let (cmd_tx,    mut cmd_rx) = mpsc::channel::<Cmd>(64);
        let (bridge_tx, bridge_rx) = mpsc::channel::<BridgeEvent>(256);

        let handle = P2PLibp2pHandle { peer_id, cmd_tx };

        // Swarm
        let mut swarm = libp2p::SwarmBuilder::with_existing_identity(keypair)
            .with_tokio()
            .with_tcp(tcp::Config::default(), noise::Config::new, yamux::Config::default)?
            .with_dns()?
            .with_relay_client(noise::Config::new, yamux::Config::default)?
            .with_behaviour(|key, relay_client| {
                Ok(Behaviour {
                    relay_client,
                    identify: identify::Behaviour::new(
                        identify::Config::new("/yuyuframe/1.0.0".into(), key.public())
                            .with_interval(Duration::from_secs(60)),
                    ),
                    dcutr: dcutr::Behaviour::new(key.public().to_peer_id()),
                    rr: request_response::cbor::Behaviour::new(
                        [(StreamProtocol::new("/yuyu/data/1.0"), ProtocolSupport::Full)],
                        request_response::Config::default()
                            .with_request_timeout(Duration::from_secs(30)),
                    ),
                })
            })?
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(120)))
            .build();

        // TCP local (port aléatoire)
        swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse()?)?;

        // Connexion aux relay nodes
        for addr_str in RELAY_ADDRS {
            if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                let _ = swarm.dial(addr);
            }
        }

        // Boucle swarm
        tokio::spawn(async move {
            let mut remote_peer:       Option<PeerId>          = None;
            let mut relay_addrs:       Vec<(PeerId, Multiaddr)> = Vec::new();
            let mut listening_relays:  HashSet<PeerId>          = HashSet::new();

            loop {
                tokio::select! {
                    Some(cmd) = cmd_rx.recv() => {
                        match cmd {
                            Cmd::Connect(id_str) => {
                                let Ok(target) = id_str.parse::<PeerId>() else { continue };
                                let mut dialed = false;
                                // Essayer via relays déjà identifiés
                                for (_, relay_addr) in &relay_addrs {
                                    let circuit = relay_addr.clone()
                                        .with(Protocol::P2pCircuit)
                                        .with(Protocol::P2p(target));
                                    if swarm.dial(circuit).is_ok() {
                                        dialed = true;
                                        break;
                                    }
                                }
                                // Fallback : essayer les addrs RELAY_ADDRS directement
                                if !dialed {
                                    for addr_str in RELAY_ADDRS {
                                        if let Ok(addr) = addr_str.parse::<Multiaddr>() {
                                            let circuit = addr
                                                .with(Protocol::P2pCircuit)
                                                .with(Protocol::P2p(target));
                                            let _ = swarm.dial(circuit);
                                        }
                                    }
                                }
                                tracing::info!("[P2P libp2p] Connexion vers {}", &id_str[..12.min(id_str.len())]);
                            }
                            Cmd::Send(json) => {
                                if let Some(peer) = remote_peer {
                                    swarm.behaviour_mut().rr.send_request(&peer, GameMsg(json));
                                }
                            }
                        }
                    }
                    event = swarm.next() => {
                        let Some(event) = event else { break };
                        match event {
                            // Données reçues du pair distant
                            SwarmEvent::Behaviour(BehaviourEvent::Rr(
                                request_response::Event::Message {
                                    peer,
                                    message: request_response::Message::Request {
                                        request: GameMsg(json), channel, ..
                                    },
                                }
                            )) => {
                                let _ = swarm.behaviour_mut().rr.send_response(channel, ());
                                let _ = bridge_tx.send(BridgeEvent::Message(json)).await;
                                if remote_peer.is_none() {
                                    remote_peer = Some(peer);
                                    tracing::info!("[P2P libp2p] Pair actif: {}", &peer.to_string()[..12]);
                                }
                            }

                            // Identify d'un relay → écouter dessus
                            SwarmEvent::Behaviour(BehaviourEvent::Identify(
                                identify::Event::Received { peer_id, info: _ }
                            )) => {
                                if relay_ids.contains(&peer_id)
                                    && !listening_relays.contains(&peer_id)
                                {
                                    if let Some(relay_ma) = relay_addr_for_peer(&peer_id) {
                                        let listen = relay_ma.clone().with(Protocol::P2pCircuit);
                                        if swarm.listen_on(listen).is_ok() {
                                            tracing::info!("[P2P libp2p] Relay réservé: {}", &peer_id.to_string()[..12]);
                                            listening_relays.insert(peer_id);
                                            relay_addrs.push((peer_id, relay_ma));
                                        }
                                    }
                                }
                            }

                            // Connexion établie
                            SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                                if !relay_ids.contains(&peer_id) {
                                    tracing::info!("[P2P libp2p] Pair connecté: {}", &peer_id.to_string()[..12]);
                                    remote_peer = Some(peer_id);
                                }
                            }

                            // Connexion fermée
                            SwarmEvent::ConnectionClosed { peer_id, cause, .. } => {
                                if remote_peer == Some(peer_id) {
                                    tracing::warn!("[P2P libp2p] Pair déconnecté ({:?})", cause);
                                    remote_peer = None;
                                    let _ = bridge_tx.send(
                                        BridgeEvent::PeerLeft(peer_id.to_string())
                                    ).await;
                                }
                            }

                            // Hole punch
                            SwarmEvent::Behaviour(BehaviourEvent::Dcutr(ev)) => {
                                tracing::debug!("[P2P libp2p] dcutr: {:?}", ev);
                            }

                            _ => {}
                        }
                    }
                }
            }
        });

        Ok((handle, bridge_rx))
    }

    pub async fn connect_to(&self, peer_id_str: String) -> Result<()> {
        self.cmd_tx.send(Cmd::Connect(peer_id_str)).await
            .context("Swarm arrêté")
    }

    /// Version non-async pour appel depuis un std::thread (signaling server).
    /// Fire-and-forget : si le canal est plein le message est droppé.
    pub fn try_send_json(&self, json: String) {
        let _ = self.cmd_tx.try_send(Cmd::Send(json));
    }

    /// Retourne le PeerID local encodé en base58 (code de session à partager)
    pub fn session_code(&self) -> String {
        self.peer_id.to_string()
    }

    pub fn get_global() -> Option<&'static P2PLibp2pHandle> {
        HANDLE.get()
    }

    pub fn set_global(handle: P2PLibp2pHandle) {
        let _ = HANDLE.set(handle);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn known_relay_peer_ids() -> HashSet<PeerId> {
    RELAY_ADDRS.iter()
        .filter_map(|s| s.parse::<Multiaddr>().ok())
        .filter_map(|ma| ma.iter().find_map(|p| match p {
            Protocol::P2p(id) => Some(id),
            _ => None,
        }))
        .collect()
}

fn relay_addr_for_peer(target: &PeerId) -> Option<Multiaddr> {
    RELAY_ADDRS.iter()
        .filter_map(|s| s.parse::<Multiaddr>().ok())
        .find(|ma| ma.iter().any(|p| matches!(p, Protocol::P2p(id) if id == *target)))
}

fn load_or_generate_keypair() -> Result<libp2p::identity::Keypair> {
    let key_path: PathBuf = dirs::data_dir()
        .unwrap_or_default()
        .join("YuyuFrame").join("p2p").join("keypair.bin");

    if key_path.exists() {
        let bytes = std::fs::read(&key_path)?;
        libp2p::identity::Keypair::from_protobuf_encoding(&bytes)
            .context("Clé corrompue — supprimez keypair.bin pour en générer une nouvelle")
    } else {
        let kp = libp2p::identity::Keypair::generate_ed25519();
        if let Some(parent) = key_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&key_path, kp.to_protobuf_encoding()?)?;
        tracing::info!("[P2P libp2p] Nouvelle clé Ed25519 générée");
        Ok(kp)
    }
}
