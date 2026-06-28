import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { listen } from '@tauri-apps/api/event'
import { api } from '@/api/client'
import { useStore } from '@/stores/useStore'
import { BETA_TEST } from '@/config/beta'

const OWNERSHIP_API = 'http://127.0.0.1:3849/ownership'
const POLL_MS = 500
const CELL = 8          // px par quadrant (2×2 par chunk)
const VIEW_HALF = 10    // chunks affichés de chaque côté du centre
const CHUNK_PX = CELL * 2
const CANVAS = (VIEW_HALF * 2 + 1) * CHUNK_PX   // total px
const HISTORY_CAP = 180  // ~90s à 500ms/poll

const COLORS = [
  '#22c55e',  // 0 — moi (vert)
  '#ef4444',  // 1
  '#3b82f6',  // 2
  '#f97316',  // 3
  '#a855f7',  // 4
  '#06b6d4',  // 5
]

function ownerColor(o: number): string {
  return COLORS[o % COLORS.length]
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' Mo'
  if (n >= 1024) return (n / 1024).toFixed(1) + ' Ko'
  return n + ' o'
}

function tpsColor(tps: number): string {
  if (tps >= 19) return '#22c55e'
  if (tps >= 15) return '#eab308'
  return '#ef4444'
}

function latencyColor(ms: number): string {
  if (ms < 0) return 'rgba(255,255,255,0.3)'
  if (ms <= 60) return '#22c55e'
  if (ms <= 150) return '#eab308'
  return '#ef4444'
}

function pushSample(arr: number[], v: number): void {
  arr.push(v)
  if (arr.length > HISTORY_CAP) arr.shift()
}

interface QuadEntry { cx: number; cz: number; q: number; o: number }
interface OwnershipData {
  peer_id: string
  peer_name: string
  my_x: number
  my_z: number
  pc: number
  tps: number
  mspt: number
  latency_ms: number
  chunks_computed: number
  chunks_skipped: number
  hook_calls: number
  tick_chunk_diag: string
  is_paused_diag: string
  player_list_empty_diag: string
  send_hook_diag: string
  baseline_blocks_applied: number
  baseline_chunks_applied: number
  baseline_queue: number
  baseline_chunks_sent: number
  baseline_bytes_sent: number
  baseline_active_streams: number
  live_blocks_applied: number
  live_queue: number
  send_hook_calls: number
  live_blocks_sent: number
  live_entities_sent: number
  live_queue_out: number
  quads: QuadEntry[]
  peers_reported?: OwnershipData[]
}

// q: 0=NW, 1=NE, 2=SW, 3=SE → offsets en quadrants (col, row) dans le chunk
const QUAD_OFFSET: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1]]

export default function Server() {
  const navigate = useNavigate()
  const { selectedInstanceId, selectedInstance, isInstanceRunning, setInstanceRunning } = useStore()

  if (BETA_TEST) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4" style={{ background: '#09090D' }}>
        <div style={{ fontSize: 32, opacity: 0.15 }}>
          <svg viewBox="0 0 24 24" fill="white" width={48} height={48}><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" /></svg>
        </div>
        <p style={{ fontSize: 14, fontWeight: 700, color: 'rgba(255,255,255,0.5)' }}>P2P non disponible en bêta</p>
        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', textAlign: 'center', maxWidth: 280 }}>
          Le serveur P2P sera accessible dans une prochaine version.
        </p>
        <button
          onClick={() => navigate('/home')}
          className="rounded-xl px-5 py-2 text-sm font-semibold transition-all duration-150"
          style={{ background: 'rgba(75,63,207,0.18)', border: '1px solid rgba(75,63,207,0.35)', color: 'rgba(180,170,255,0.9)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(75,63,207,0.3)' }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(75,63,207,0.18)' }}
        >
          Retour
        </button>
      </div>
    )
  }

  const gameRunning = !!selectedInstanceId && isInstanceRunning(selectedInstanceId)
  const instance = selectedInstance()

  useEffect(() => {
    const unlisten = listen<{ running: boolean; instance_id: string }>('game_state', (event) => {
      setInstanceRunning(event.payload.instance_id, event.payload.running)
    })
    return () => { unlisten.then((fn) => fn()) }
  }, [])

  const [reloadStatus, setReloadStatus] = useState<'idle' | 'sent' | 'error'>('idle')

  const handleReloadAgent = async () => {
    try {
      await api.launch.reloadAgent()
      setReloadStatus('sent')
      setTimeout(() => setReloadStatus('idle'), 2500)
    } catch {
      setReloadStatus('error')
      setTimeout(() => setReloadStatus('idle'), 2500)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: '#09090D' }}>

      {/* Header — identique au gabarit standard de l'app (Stats/Settings/Plans) */}
      <div
        className="flex flex-shrink-0 items-center gap-3 px-6 py-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <button
          onClick={() => navigate('/home')}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-all duration-150"
          style={{ color: 'rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.04)' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 15, height: 15 }}>
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
        </button>

        <div style={{ width: 1, height: 28, background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

        <div>
          <h1 className="font-black text-white" style={{ fontSize: 16, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
            Serveur P2P
          </h1>
          <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 1 }}>
            {instance ? (
              <span style={{ color: 'rgba(120,110,230,0.7)', fontWeight: 600 }}>{instance.name} — {instance.mc_version}</span>
            ) : (
              <span style={{ color: 'rgba(255,100,100,0.6)' }}>Aucune instance sélectionnée</span>
            )}
          </p>
        </div>

        {gameRunning && (
          <div className="ml-auto flex flex-col items-end gap-1">
            <button
              onClick={handleReloadAgent}
              disabled={reloadStatus !== 'idle'}
              style={{
                height: 30, padding: '0 14px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                letterSpacing: '0.03em', cursor: reloadStatus !== 'idle' ? 'default' : 'pointer',
                background: reloadStatus === 'sent'
                  ? 'rgba(40,160,90,0.18)'
                  : reloadStatus === 'error'
                    ? 'rgba(200,50,50,0.18)'
                    : 'rgba(255,255,255,0.04)',
                border: reloadStatus === 'sent'
                  ? '1px solid rgba(40,160,90,0.35)'
                  : reloadStatus === 'error'
                    ? '1px solid rgba(200,50,50,0.35)'
                    : '1px solid rgba(255,255,255,0.08)',
                color: reloadStatus === 'sent'
                  ? 'rgba(80,210,130,0.9)'
                  : reloadStatus === 'error'
                    ? 'rgba(255,100,100,0.9)'
                    : 'rgba(255,255,255,0.45)',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                if (reloadStatus === 'idle') (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.7)'
              }}
              onMouseLeave={(e) => {
                if (reloadStatus === 'idle') (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.45)'
              }}
            >
              {reloadStatus === 'sent'
                ? 'Rechargement envoyé ✓'
                : reloadStatus === 'error'
                  ? 'Erreur d’écriture'
                  : 'Recharger l’agent P2P'}
            </button>
            <p style={{ fontSize: 9, color: 'rgba(255,255,255,0.18)' }}>
              Relit p2p-agent.properties sans relancer Minecraft
            </p>
          </div>
        )}
      </div>

      {/* Content — pleine largeur, style tableau de bord (liste de serveurs + détail) */}
      <div className="flex-1 overflow-auto">
        <div className="w-full px-6 py-6">
          <DebugPanel />
        </div>
      </div>
    </div>
  )
}

function StatBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: '8px 10px', flex: '1 1 130px', minWidth: 0 }}>
      <div style={{ color: 'rgba(255,255,255,0.3)', marginBottom: 6, fontSize: 10, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: 1 }}>{title}</div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  )
}

/** Ligne label/valeur atténuée — la valeur n'est plus en blanc pur pour rester discrète face au titre. */
function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2" style={{ fontSize: 11 }}>
      <span style={{ color: 'rgba(255,255,255,0.4)' }}>{label}</span>
      <span style={{ color: 'rgba(255,255,255,0.78)', fontFamily: 'monospace', fontSize: 13 }}>{value}</span>
    </div>
  )
}

/** Bloc texte brut pour un diagnostic ASM exposé par le serveur HTTP d'ownership. */
function DiagLine({ title, value }: { title: string; value: string | undefined }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 6, padding: '10px 12px' }}>
      <div style={{ color: 'rgba(255,255,255,0.3)', marginBottom: 4, fontSize: 10, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: 1 }}>{title}</div>
      <div style={{ color: 'rgba(255,255,255,0.78)', wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 11 }}>{value || '—'}</div>
    </div>
  )
}

/** Petit graphe SVG fait main (polyline + aire translucide), sans dépendance externe. Étiré en 100% via viewBox. */
function Sparkline({ data, color, height = 26 }: { data: number[]; color: string; height?: number }) {
  const VW = 240
  if (data.length < 2) {
    return <svg width="100%" height={height} style={{ display: 'block' }} />
  }
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const stepX = VW / (data.length - 1)
  const linePoints = data.map((v, i) => {
    const x = i * stepX
    const y = height - ((v - min) / range) * height
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const areaPoints = `0,${height} ${linePoints.join(' ')} ${VW},${height}`
  return (
    <svg viewBox={`0 0 ${VW} ${height}`} preserveAspectRatio="none" width="100%" height={height} style={{ display: 'block' }}>
      <polyline points={areaPoints} fill={`${color}22`} stroke="none" />
      <polyline points={linePoints.join(' ')} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** Grand graphe temporel plein cadre (style "Graphs" Hetzner) — valeur courante + min/max + aire. */
function Chart({ title, data, color, unit }: { title: string; data: number[]; color: string; unit?: string }) {
  const current = data.at(-1) ?? 0
  const min = data.length ? Math.min(...data) : 0
  const max = data.length ? Math.max(...data) : 0
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: 14, minWidth: 0 }}>
      <div className="flex items-baseline justify-between" style={{ marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.8 }}>{title}</span>
        <span style={{ fontSize: 18, fontWeight: 700, color, fontFamily: 'monospace' }}>
          {current.toFixed(1)}{unit ? <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginLeft: 3 }}>{unit}</span> : null}
        </span>
      </div>
      <Sparkline data={data.length ? data : [0, 0]} color={color} height={90} />
      <div className="flex justify-between" style={{ marginTop: 6, fontSize: 9, color: 'rgba(255,255,255,0.25)', fontFamily: 'monospace' }}>
        <span>min {min.toFixed(1)}</span>
        <span>max {max.toFixed(1)}</span>
      </div>
    </div>
  )
}

const thStyle: CSSProperties = { textAlign: 'left', padding: '7px 10px', color: 'rgba(255,255,255,0.35)', fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }
const tdStyle: CSSProperties = { padding: '7px 10px', color: 'rgba(255,255,255,0.7)', verticalAlign: 'middle' }

/**
 * Table des pairs connus : self + peers_reported[] (agents locaux multi-instance).
 * Les vrais pairs P2P distants ne sont pas détaillés individuellement côté agent
 * (pas de latence/débit par pair distant) — comptés honnêtement en ligne "non détaillés".
 */
function PeersTable({ self }: { self: OwnershipData }) {
  const rows = [self, ...(self.peers_reported ?? [])]
  const undetailed = Math.max(0, (self.pc ?? 0) - rows.length)

  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8, color: 'rgba(255,255,255,0.35)' }}>
        Pairs connectés
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
            <th style={thStyle}></th>
            <th style={thStyle}>Pair</th>
            <th style={thStyle}>Position</th>
            <th style={thStyle}>TPS</th>
            <th style={thStyle}>Latence</th>
            <th style={thStyle}>Quads</th>
            <th style={thStyle}>Blocs env.</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => {
            const myQuads = p.quads.filter(q => q.o === 0).length
            return (
              <tr key={p.peer_id} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <td style={tdStyle}><div style={{ width: 8, height: 8, borderRadius: '50%', background: ownerColor(i) }} /></td>
                <td style={tdStyle}>
                  <div style={{ color: '#fff' }}>{p.peer_name}</div>
                  <div style={{ color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', fontSize: 9 }}>{p.peer_id}</div>
                </td>
                <td style={tdStyle}>{Math.floor(p.my_x)}, {Math.floor(p.my_z)}</td>
                <td style={{ ...tdStyle, color: tpsColor(p.tps) }}>{p.tps.toFixed(1)}</td>
                <td style={{ ...tdStyle, color: latencyColor(p.latency_ms) }}>{p.latency_ms >= 0 ? p.latency_ms + ' ms' : '—'}</td>
                <td style={tdStyle}>{myQuads}</td>
                <td style={tdStyle}>{p.live_blocks_sent}</td>
              </tr>
            )
          })}
          {undetailed > 0 && (
            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <td colSpan={7} style={{ ...tdStyle, color: 'rgba(255,255,255,0.3)', fontStyle: 'italic' }}>
                + {undetailed} pair(s) distant(s) non détaillé(s) — pas de métriques par pair distant côté agent
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function HealthBadge({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span style={{
      fontSize: 9, fontWeight: 600, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap',
      background: ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
      color: ok ? '#22c55e' : '#ef4444', border: `1px solid ${ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
    }}>
      {label} {ok ? '✓' : '✗'}
    </span>
  )
}

const TABS = [
  { id: 'apercu', label: 'Aperçu' },
  { id: 'performance', label: 'Performance' },
  { id: 'reseau', label: 'Réseau' },
  { id: 'sync', label: 'Synchronisation' },
  { id: 'diagnostic', label: 'Diagnostic' },
] as const
type TabId = typeof TABS[number]['id']

/**
 * Sidebar gauche — style panneau d'hébergeur : liste des agents connus (local + rapportés)
 * en haut, puis navigation par catégories (onglets) pour l'agent sélectionné en bas.
 */
function ServerSidebar({ agents, error, activeId, onSelect, tab, onTabChange }: {
  agents: OwnershipData[]
  error: boolean
  activeId: string | null
  onSelect: (id: string) => void
  tab: TabId
  onTabChange: (t: TabId) => void
}) {
  return (
    <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, alignSelf: 'flex-start' }}>
      <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8, color: 'rgba(255,255,255,0.35)' }}>
          Agents ({agents.length})
        </div>
        {agents.length === 0 ? (
          <div style={{ padding: 14, fontSize: 11, color: error ? '#ef4444' : 'rgba(255,255,255,0.3)', fontFamily: 'monospace' }}>
            {error ? 'Agent P2P inaccessible' : 'En attente de données…'}
          </div>
        ) : (
          agents.map((a, i) => {
            const isActive = a.peer_id === activeId
            return (
              <button
                key={a.peer_id}
                onClick={() => onSelect(a.peer_id)}
                className="flex w-full items-center gap-2 text-left"
                style={{
                  padding: '9px 12px', fontSize: 11, fontFamily: 'monospace', cursor: 'pointer',
                  background: isActive ? 'rgba(129,140,248,0.12)' : 'transparent',
                  borderLeft: isActive ? '2px solid #818cf8' : '2px solid transparent',
                  color: isActive ? '#fff' : 'rgba(255,255,255,0.55)',
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: ownerColor(i), flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.peer_name}</div>
                  <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>{i === 0 ? 'local' : 'rapporté'}</div>
                </div>
                <span style={{ fontSize: 10, color: tpsColor(a.tps), fontWeight: 700, flexShrink: 0 }}>{a.tps.toFixed(0)}</span>
              </button>
            )
          })
        )}
      </div>

      <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8, color: 'rgba(255,255,255,0.35)' }}>
          Catégories
        </div>
        {TABS.map(t => {
          const isActive = t.id === tab
          return (
            <button
              key={t.id}
              onClick={() => onTabChange(t.id)}
              className="flex w-full items-center text-left"
              style={{
                padding: '9px 12px', fontSize: 11, fontWeight: 600, fontFamily: 'monospace', cursor: 'pointer',
                background: isActive ? 'rgba(129,140,248,0.12)' : 'transparent',
                borderLeft: isActive ? '2px solid #818cf8' : '2px solid transparent',
                color: isActive ? '#fff' : 'rgba(255,255,255,0.5)',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DebugPanel() {
  const [data, setData] = useState<OwnershipData | null>(null)
  const [error, setError] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('apercu')

  // Polling — un seul agent local (propriétaire du port 3849) répond ; les autres
  // agents locaux (test multi-instance sur la même machine) lui poussent leurs stats
  // via POST /report, agrégées ici dans peers_reported.
  useEffect(() => {
    let alive = true
    async function poll() {
      while (alive) {
        try {
          const res = await fetch(OWNERSHIP_API)
          if (res.ok) {
            const json: OwnershipData = await res.json()
            setData(json)
            setError(false)
          }
        } catch {
          setError(true)
        }
        await new Promise(r => setTimeout(r, POLL_MS))
      }
    }
    poll()
    return () => { alive = false }
  }, [])

  const agents = data ? [data, ...(data.peers_reported ?? [])] : []
  const activeId = selected ?? agents[0]?.peer_id ?? null
  const active = agents.find(a => a.peer_id === activeId) ?? null
  const isLocal = active === agents[0]

  return (
    <div className="flex w-full gap-4">
      <ServerSidebar agents={agents} error={error} activeId={activeId} onSelect={setSelected} tab={tab} onTabChange={setTab} />
      <div className="flex-1" style={{ minWidth: 0 }}>
        <AgentDetail
          data={active}
          error={error && agents.length === 0}
          label={isLocal ? 'Agent local' : 'Agent rapporté (autre instance locale)'}
          showPeers={isLocal}
          tab={tab}
        />
      </div>
    </div>
  )
}

function AgentDetail({ data, error, label, showPeers, tab }: { data: OwnershipData | null; error?: boolean; label: string; showPeers?: boolean; tab: TabId }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [copied, setCopied] = useState(false)

  // Historique côté client (perdu au reload — backend ne stocke aucune série temporelle).
  const historyRef = useRef({
    tps: [] as number[],
    mspt: [] as number[],
    latency: [] as number[],
    blocksSentRate: [] as number[],
    liveBlocksAppliedRate: [] as number[],
    baselineBlocksAppliedRate: [] as number[],
    queueIn: [] as number[],
    queueOut: [] as number[],
  })
  const lastSampleRef = useRef<{ t: number; sent: number; liveApplied: number; baselineApplied: number } | null>(null)

  useEffect(() => {
    if (!data) return
    const h = historyRef.current
    const now = performance.now()
    let sentRate = 0
    let liveAppliedRate = 0
    let baselineAppliedRate = 0
    if (lastSampleRef.current) {
      const dt = (now - lastSampleRef.current.t) / 1000
      if (dt > 0) {
        sentRate = Math.max(0, (data.live_blocks_sent - lastSampleRef.current.sent) / dt)
        liveAppliedRate = Math.max(0, (data.live_blocks_applied - lastSampleRef.current.liveApplied) / dt)
        baselineAppliedRate = Math.max(0, (data.baseline_blocks_applied - lastSampleRef.current.baselineApplied) / dt)
      }
    }
    lastSampleRef.current = {
      t: now,
      sent: data.live_blocks_sent,
      liveApplied: data.live_blocks_applied,
      baselineApplied: data.baseline_blocks_applied,
    }

    pushSample(h.tps, data.tps)
    pushSample(h.mspt, data.mspt)
    if (data.latency_ms >= 0) pushSample(h.latency, data.latency_ms)
    pushSample(h.blocksSentRate, sentRate)
    pushSample(h.liveBlocksAppliedRate, liveAppliedRate)
    pushSample(h.baselineBlocksAppliedRate, baselineAppliedRate)
    pushSample(h.queueIn, data.live_queue)
    pushSample(h.queueOut, data.live_queue_out)
  }, [data])

  // Rendu canvas (carte d'ownership)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { my_x, my_z, quads } = data
    const myCx = Math.floor(my_x / 16)
    const myCz = Math.floor(my_z / 16)

    ctx.fillStyle = '#0A0A12'
    ctx.fillRect(0, 0, CANVAS, CANVAS)

    const map = new Map<string, number>()
    for (const q of quads) map.set(`${q.cx},${q.cz},${q.q}`, q.o)

    for (let dcx = -VIEW_HALF; dcx <= VIEW_HALF; dcx++) {
      for (let dcz = -VIEW_HALF; dcz <= VIEW_HALF; dcz++) {
        const cx = myCx + dcx
        const cz = myCz + dcz
        const screenX = (dcx + VIEW_HALF) * CHUNK_PX
        const screenZ = (dcz + VIEW_HALF) * CHUNK_PX

        for (let q = 0; q < 4; q++) {
          const owner = map.get(`${cx},${cz},${q}`)
          const [qcol, qrow] = QUAD_OFFSET[q]
          const px = screenX + qcol * CELL
          const pz = screenZ + qrow * CELL

          if (owner !== undefined) {
            ctx.fillStyle = ownerColor(owner)
            ctx.globalAlpha = owner === 0 ? 0.35 : 0.22
            ctx.fillRect(px + 1, pz + 1, CELL - 1, CELL - 1)
            ctx.globalAlpha = 1
          }
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.08)'
        ctx.lineWidth = 0.5
        ctx.strokeRect(screenX, screenZ, CHUNK_PX, CHUNK_PX)
      }
    }

    const myScreenX = VIEW_HALF * CHUNK_PX
    const myScreenZ = VIEW_HALF * CHUNK_PX
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.strokeRect(myScreenX, myScreenZ, CHUNK_PX, CHUNK_PX)

    const fracX = ((my_x % 16) + 16) % 16
    const fracZ = ((my_z % 16) + 16) % 16
    const dotX = myScreenX + (fracX / 16) * CHUNK_PX
    const dotZ = myScreenZ + (fracZ / 16) * CHUNK_PX
    ctx.beginPath()
    ctx.arc(dotX, dotZ, 3, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.shadowColor = '#ffffff'
    ctx.shadowBlur = 6
    ctx.fill()
    ctx.shadowBlur = 0
  }, [data, tab])

  const myCount = data?.quads.filter(q => q.o === 0).length ?? 0
  const total = data?.quads.length ?? 0
  const h = historyRef.current

  const handleCopy = async () => {
    const payload = {
      captured_at: new Date().toISOString(),
      peer: { id: data?.peer_id ?? null, name: data?.peer_name ?? null },
      performance: {
        tps: data?.tps ?? null,
        mspt: data?.mspt ?? null,
        latency_ms: data && data.latency_ms >= 0 ? data.latency_ms : null,
        pairs: data?.pc ?? 0,
      },
      synchronisation_initiale: {
        reception: {
          chunks: data?.baseline_chunks_applied ?? 0,
          blocs: data?.baseline_blocks_applied ?? 0,
          file: data?.baseline_queue ?? 0,
        },
        emission: {
          chunks: data?.baseline_chunks_sent ?? 0,
          volume: fmtBytes(data?.baseline_bytes_sent ?? 0),
          streams_actifs: data?.baseline_active_streams ?? 0,
        },
      },
      temps_reel: {
        ownership: {
          mes_quads: myCount,
          total_quads: total,
          chunks_simules: data?.chunks_computed ?? 0,
          chunks_ignores: data?.chunks_skipped ?? 0,
          hook_appele: data?.hook_calls ?? 0,
          diagnostic_asm: data?.tick_chunk_diag ?? null,
        },
        delta_recu: {
          blocs_appliques: data?.live_blocks_applied ?? 0,
          file: data?.live_queue ?? 0,
        },
        delta_envoye: {
          hook_send_appele: data?.send_hook_calls ?? 0,
          diagnostic_asm: data?.send_hook_diag ?? null,
          blocs: data?.live_blocks_sent ?? 0,
          entites: data?.live_entities_sent ?? 0,
          file_sortante: data?.live_queue_out ?? 0,
        },
      },
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {}
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {/* ── Barre d'en-tête ── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: error ? '#ef4444' : '#22c55e', boxShadow: `0 0 5px ${error ? '#ef4444' : '#22c55e'}` }} />
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', fontFamily: 'monospace' }}>
            {error ? 'Agent P2P inaccessible (port 3849)' : label}
          </span>
          {data && (
            <span style={{ fontSize: 10, color: 'rgba(120,110,230,0.7)', fontFamily: 'monospace', fontWeight: 600 }}>
              ({data.peer_name} · {data.peer_id})
            </span>
          )}
        </div>
        <button
          onClick={handleCopy}
          disabled={!data}
          style={{
            fontSize: 10, fontWeight: 600, fontFamily: 'monospace', letterSpacing: 0.3,
            padding: '3px 9px', borderRadius: 5, cursor: data ? 'pointer' : 'default',
            background: copied ? 'rgba(40,160,90,0.18)' : 'rgba(255,255,255,0.04)',
            border: copied ? '1px solid rgba(40,160,90,0.35)' : '1px solid rgba(255,255,255,0.08)',
            color: copied ? 'rgba(80,210,130,0.9)' : 'rgba(255,255,255,0.4)',
            transition: 'all 0.15s',
          }}
        >
          {copied ? 'Copié ✓' : '{ } Copier en JSON'}
        </button>
      </div>

      {/* ── Aperçu — intro du serveur, pas un tableau de stats ── */}
      {tab === 'apercu' && (
        <div className="flex flex-col gap-4">
          <div
            className="flex items-center gap-6"
            style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '20px 22px', background: 'rgba(255,255,255,0.02)' }}
          >
            <div style={{
              width: 88, height: 88, flexShrink: 0, borderRadius: 16,
              background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth={1.3} style={{ width: 42, height: 42 }}>
                <rect x="3" y="3" width="18" height="5.5" rx="1.1" />
                <rect x="3" y="10" width="18" height="5.5" rx="1.1" />
                <rect x="3" y="17" width="18" height="4" rx="1" />
                <circle cx="6.3" cy="5.75" r="0.9" fill={!error ? '#22c55e' : '#ef4444'} stroke="none" />
                <circle cx="6.3" cy="12.75" r="0.9" fill={!error ? '#22c55e' : '#ef4444'} stroke="none" />
              </svg>
            </div>
            <div className="flex flex-col gap-1" style={{ minWidth: 0 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>
                {error ? 'Agent P2P inaccessible' : (data ? data.peer_name : '—')}
              </span>
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
                {data ? `${data.peer_id} · ${data.pc} pair(s) connecté(s)` : 'En attente de données…'}
              </span>
              <div className="flex items-baseline gap-2" style={{ marginTop: 8 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 38, fontWeight: 700, color: data ? tpsColor(data.tps) : 'rgba(255,255,255,0.25)' }}>
                  {data ? data.tps.toFixed(1) : '—'}
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>TPS</span>
              </div>
            </div>
          </div>

          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 10, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: 0.8, color: 'rgba(255,255,255,0.35)' }}>
              Pairs & ping
            </div>
            <div className="flex flex-col" style={{ padding: '6px 12px' }}>
              {data ? [data, ...(data.peers_reported ?? [])].map((p, i) => (
                <div key={p.peer_id} className="flex items-center justify-between gap-3" style={{ padding: '6px 0', borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                  <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
                    <div style={{ width: 9, height: 9, borderRadius: 2, background: ownerColor(i), flexShrink: 0 }} />
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{i === 0 ? 'Moi' : p.peer_name}</span>
                  </div>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: i === 0 ? 'rgba(255,255,255,0.3)' : latencyColor(p.latency_ms) }}>
                    {i === 0 ? '—' : p.latency_ms >= 0 ? `${p.latency_ms} ms` : '—'}
                  </span>
                </div>
              )) : (
                <div style={{ padding: '8px 0', fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>En attente de données…</div>
              )}
              {(data?.pc ?? 0) - 1 - (data?.peers_reported?.length ?? 0) > 0 && (
                <div style={{ padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.05)', fontFamily: 'monospace', fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
                  +{(data?.pc ?? 0) - 1 - (data?.peers_reported?.length ?? 0)} pair(s) distant(s) non détaillé(s)
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Performance — graphes temporels pleine largeur ── */}
      {tab === 'performance' && (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          <Chart title="TPS" data={h.tps} color={data ? tpsColor(data.tps) : '#818cf8'} />
          <Chart title="MSPT" data={h.mspt} color="#818cf8" unit="ms" />
          <Chart title="Latence" data={h.latency} color={data ? latencyColor(data.latency_ms) : '#818cf8'} unit="ms" />
          <Chart title="Blocs envoyés / s" data={h.blocksSentRate} color="#818cf8" />
          <Chart title="Blocs appliqués / s" data={h.liveBlocksAppliedRate} color="#22c55e" />
          <Chart title="File sortante" data={h.queueOut} color="#f59e0b" />
          <Chart title="File entrante" data={h.queueIn} color="#f59e0b" />
        </div>
      )}

      {/* ── Réseau — table des pairs + carte d'ownership en grand ── */}
      {tab === 'reseau' && (
        <div className="flex flex-col gap-3">
          {showPeers && data ? <PeersTable self={data} /> : (
            <div style={{ padding: 14, fontSize: 11, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
              La table des pairs n'est disponible que sur l'agent local (propriétaire de l'agrégation).
            </div>
          )}
          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.8, color: 'rgba(255,255,255,0.35)' }}>
              Carte d'ownership
            </div>
            <div className="flex justify-center" style={{ padding: 14 }}>
              <div style={{ width: CANVAS, maxWidth: '100%', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, overflow: 'hidden' }}>
                <canvas ref={canvasRef} width={CANVAS} height={CANVAS} style={{ display: 'block', width: '100%', height: 'auto' }} />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Synchronisation : snapshot initial vs delta temps réel ── */}
      {tab === 'sync' && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div style={{ fontSize: 10, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: 1, color: 'rgba(255,255,255,0.35)' }}>
                Snapshot initial
              </div>
              <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)' }}>Handshake unique à la connexion (J1 → J2)</div>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <StatBox title="Réception (chez moi)">
                <StatRow label="Chunks" value={data?.baseline_chunks_applied ?? 0} />
                <StatRow label="Blocs" value={data?.baseline_blocks_applied ?? 0} />
                <StatRow label="Vitesse" value={`${(h.baselineBlocksAppliedRate.at(-1) ?? 0).toFixed(1)} /s`} />
                <Sparkline data={h.baselineBlocksAppliedRate} color="#f97316" />
                <StatRow label="File" value={data?.baseline_queue ?? 0} />
              </StatBox>
              <StatBox title="Émission (vers le pair)">
                <StatRow label="Chunks" value={data?.baseline_chunks_sent ?? 0} />
                <StatRow label="Volume" value={fmtBytes(data?.baseline_bytes_sent ?? 0)} />
                <StatRow label="Streams actifs" value={data?.baseline_active_streams ?? 0} />
              </StatBox>
              <StatBox title="Ownership détaillé">
                <StatRow label="Chunks simulés" value={data?.chunks_computed ?? 0} />
                <StatRow label="Chunks ignorés" value={data?.chunks_skipped ?? 0} />
              </StatBox>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div style={{ fontSize: 10, fontFamily: 'monospace', textTransform: 'uppercase', letterSpacing: 1, color: 'rgba(255,255,255,0.35)' }}>
                Delta temps réel
              </div>
              <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.3)' }}>Flux continu pendant la partie</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <HealthBadge label="tickChunk hook (ownership)" ok={(data?.hook_calls ?? 0) > 0} />
              <HealthBadge label="send() hook (delta sortant)" ok={(data?.send_hook_calls ?? 0) > 0} />
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <StatBox title="Reçu (chez moi)">
                <StatRow label="Blocs appliqués" value={data?.live_blocks_applied ?? 0} />
                <StatRow label="File entrante" value={data?.live_queue ?? 0} />
              </StatBox>
              <StatBox title="Émis (vers le pair)">
                <StatRow label="Blocs envoyés" value={data?.live_blocks_sent ?? 0} />
                <StatRow label="Entités envoyées" value={data?.live_entities_sent ?? 0} />
                <StatRow label="File sortante" value={data?.live_queue_out ?? 0} />
              </StatBox>
            </div>
          </div>
        </div>
      )}

      {/* ── Diagnostic ── */}
      {tab === 'diagnostic' && (
        <div className="flex flex-col gap-3">
          <DiagLine title="Diagnostic ASM tickChunk" value={data?.tick_chunk_diag} />
          <DiagLine title="Diagnostic pause (isPaused)" value={data?.is_paused_diag} />
          <DiagLine title="Diagnostic liste joueurs vide" value={data?.player_list_empty_diag} />
          <DiagLine title="Diagnostic ASM send() (delta sortant)" value={data?.send_hook_diag} />
        </div>
      )}
    </div>
  )
}
