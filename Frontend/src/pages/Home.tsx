import { useEffect, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { BETA_TEST } from '@/config/beta'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { api } from '@/api/client'
import { useStore } from '@/stores/useStore'

interface DownloadProgress {
  current: number
  total: number
  message: string
}

const FEATURES = [
  {
    title: 'Sync P2P',
    desc: 'Synchronise configurations, mods et instances entre toutes tes machines en connexion directe. Aucun cloud, aucun serveur tiers — tes données restent chez toi.',
    icon: <svg viewBox="0 0 24 24" fill="currentColor" width={15} height={15}><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" /></svg>,
    path: '/sync',
  },
  {
    title: 'Statistiques avancées',
    desc: 'Suivi du temps de session, historique détaillé par instance et graphiques hebdomadaires. Visualise tes habitudes de jeu et compare tes performances dans le temps.',
    icon: <svg viewBox="0 0 24 24" fill="currentColor" width={15} height={15}><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" /></svg>,
    path: '/stats',
  },
  {
    title: 'Accès Pro',
    desc: 'Fonctionnalités réservées aux abonnés : limites augmentées, accès anticipé aux nouvelles fonctions et support prioritaire en cas de problème.',
    icon: <svg viewBox="0 0 24 24" fill="currentColor" width={15} height={15}><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 4l5 2.18V11c0 3.5-2.33 6.79-5 7.93-2.67-1.14-5-4.43-5-7.93V7.18L12 5z" /></svg>,
    path: null,
  },
]

const STARS = Array.from({ length: 55 }, (_, i) => ({
  x: (i * 37 + ((i * 7 + 13) % 100) * 1.7) % 100,
  y: (i * 23 + ((i * 7 + 13) % 100) * 2.3) % 62,
  r: i % 4 === 0 ? 2 : 1,
  o: 0.15 + (i % 5) * 0.08,
}))

function loaderColor(loader: string) {
  if (loader === 'fabric') return '#b5a0ff'
  if (loader === 'forge') return '#f0a040'
  return 'rgba(255,255,255,0.4)'
}

export default function Home() {
  const navigate = useNavigate()
  const location = useLocation()
  const {
    username, uuid,
    clearUser,
    instances, setInstances,
    selectedInstanceId, setSelectedInstanceId, selectedInstance,
    isInstanceRunning, setInstanceRunning,
    setLastSession,
    closeOnLaunch,
    p2pEnabled, setP2pEnabled,
    avoidBetaDependencies,
  } = useStore()

  const gameRunning = !!selectedInstanceId && isInstanceRunning(selectedInstanceId)

  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [launchMsg, setLaunchMsg] = useState('')
  const [bannerPulse, setBannerPulse] = useState(false)
  const [bannerAnimating, setBannerAnimating] = useState(false)

  const instance = selectedInstance()

  useEffect(() => {
    api.instances.list().then((list) => {
      setInstances(list)
      if (!selectedInstanceId && list.length > 0) {
        setSelectedInstanceId(list[0].id)
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    let unlistenProgress: (() => void) | null = null
    let unlistenState: (() => void) | null = null
    let unlistenError: (() => void) | null = null

    listen<DownloadProgress>('download_progress', (event) => {
      setProgress(event.payload)
    }).then((fn) => { unlistenProgress = fn })

    listen<{ running: boolean; instance_id: string }>('game_state', (event) => {
      const { running, instance_id } = event.payload
      setInstanceRunning(instance_id, running)
      if (!running) {
        setProgress(null)
        getCurrentWindow().show()
      }
    }).then((fn) => { unlistenState = fn })

    listen<string>('launch_error', (event) => {
      setLaunchMsg(event.payload)
      if (selectedInstanceId) setInstanceRunning(selectedInstanceId, false)
      setProgress(null)
    }).then((fn) => { unlistenError = fn })

    return () => {
      unlistenProgress?.()
      unlistenState?.()
      unlistenError?.()
    }
  }, [])

  const handleLogout = async () => {
    await api.auth.logout()
    clearUser()
    navigate('/login', { replace: true })
  }

  const handleBannerPlay = () => {
    setBannerAnimating((v) => !v)
  }

  const handleLaunch = async () => {
    if (!selectedInstanceId || gameRunning || !username) return
    setBannerPulse(true)
    setTimeout(() => setBannerPulse(false), 900)
    setLaunchMsg('')
    try {
      if (p2pEnabled) await api.launch.startP2p(selectedInstanceId, avoidBetaDependencies)
      else await api.launch.start(selectedInstanceId, avoidBetaDependencies)
      setInstanceRunning(selectedInstanceId, true)
      if (instance) setLastSession({ instanceName: instance.name, at: new Date().toISOString() })
      if (closeOnLaunch) getCurrentWindow().hide()
    } catch (e) {
      // invoke() de Tauri rejette avec une simple chaîne (pas un Error JS)
      // quand une commande Rust renvoie Err(String) — sans ce cas, le vrai
      // message d'erreur était masqué par un texte générique inutile pour
      // diagnostiquer le problème (cf. même bug corrigé sur Login.tsx).
      const message = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Erreur de lancement'
      setLaunchMsg(message)
    }
  }

  const canLaunch = !!selectedInstanceId && !!username && !gameRunning
  const percent = progress && progress.total > 0
    ? Math.round(progress.current / progress.total * 100)
    : 0

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: '#09090D' }}>

      {/* ── Main area ── */}
      <div className="flex gap-4 overflow-hidden p-4" style={{ flex: '1 1 0', minHeight: 0 }}>

        {/* LEFT: Cinematic Minecraft banner */}
        <div
          className="relative flex-1 overflow-hidden rounded-[20px]"
          style={{
            border: '1px solid rgba(200,200,220,0.08)',
            boxShadow: '0 8px 40px rgba(0,0,0,0.7)',
          }}
        >
          <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, #020208 0%, #06041a 18%, #0e0932 40%, #1c1250 58%, #130d35 76%, #070512 100%)' }} />
          <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 38% 55%, rgba(75,63,207,0.09) 0%, transparent 55%)' }} />
          <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at 68% 58%, rgba(80,210,80,0.06) 0%, transparent 38%)' }} />

          {/* Aurora — pulse infinie quand animating */}
          {bannerAnimating && (
            <div
              className="absolute inset-0 pointer-events-none animate-banner-glow"
              style={{ background: 'radial-gradient(ellipse at 38% 60%, rgba(90,70,255,0.7) 0%, rgba(75,63,207,0.35) 40%, transparent 70%)' }}
            />
          )}

          {/* Stars — scintillent en continu quand animating */}
          <div className={`absolute inset-0 ${bannerAnimating ? 'animate-star-pulse' : ''}`}>
            {STARS.map((s, i) => (
              <div key={i} className="absolute rounded-full" style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.r, height: s.r, background: `rgba(255,255,255,${s.o})` }} />
            ))}
          </div>

          {/* Flash violet au lancement */}
          {bannerPulse && (
            <div
              className="absolute inset-0 pointer-events-none animate-banner-flash rounded-[20px]"
              style={{ background: 'radial-gradient(ellipse at 50% 50%, rgba(160,130,255,0.95) 0%, rgba(90,70,255,0.6) 35%, transparent 72%)', zIndex: 10 }}
            />
          )}

          <div className={`absolute bottom-0 left-0 right-0 ${bannerAnimating ? 'animate-terrain-float' : ''}`} style={{ height: '38%' }}>
            <svg viewBox="0 0 800 220" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
              <path d="M0 220 L0 110 L16 110 L16 90 L32 90 L32 110 L48 110 L48 130 L64 130 L64 100 L80 100 L80 78 L96 78 L96 100 L112 100 L112 120 L128 120 L128 95 L144 95 L144 78 L160 78 L160 95 L176 95 L176 115 L192 115 L192 135 L208 135 L208 115 L224 115 L224 98 L240 98 L240 78 L256 78 L256 95 L272 95 L272 115 L288 115 L288 100 L304 100 L304 82 L320 82 L320 100 L336 100 L336 120 L352 120 L352 100 L368 100 L368 82 L384 82 L384 100 L400 100 L400 118 L416 118 L416 135 L432 135 L432 115 L448 115 L448 95 L464 95 L464 78 L480 78 L480 92 L496 92 L496 110 L512 110 L512 128 L528 128 L528 108 L544 108 L544 88 L560 88 L560 108 L576 108 L576 125 L592 125 L592 140 L608 140 L608 120 L624 120 L624 100 L640 100 L640 80 L656 80 L656 98 L672 98 L672 115 L688 115 L688 100 L704 100 L704 82 L720 82 L720 100 L736 100 L736 118 L752 118 L752 105 L768 105 L768 120 L784 120 L784 140 L800 140 L800 220 Z" fill="rgba(4,3,12,0.88)" />
            </svg>
          </div>

          <div className="absolute bottom-0 left-0 right-0 h-24" style={{ background: 'linear-gradient(to top, rgba(9,9,13,0.95), transparent)' }} />

          {/* Play capsule — top left (animation only) */}
          <button
            onClick={handleBannerPlay}
            className="absolute left-4 top-4 flex items-center gap-2 transition-all duration-200"
            style={{
              height: 30, paddingLeft: 10, paddingRight: 14,
              background: bannerAnimating ? 'rgba(75,63,207,0.45)' : 'rgba(18,15,38,0.78)',
              border: bannerAnimating ? '1px solid rgba(120,100,255,0.6)' : '1px solid rgba(255,255,255,0.22)',
              borderRadius: 20,
              backdropFilter: 'blur(10px)',
              transition: 'background 0.3s, border-color 0.3s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(75,63,207,0.32)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.45)' }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = bannerAnimating ? 'rgba(75,63,207,0.45)' : 'rgba(18,15,38,0.78)'
              e.currentTarget.style.borderColor = bannerAnimating ? 'rgba(120,100,255,0.6)' : 'rgba(255,255,255,0.22)'
            }}
          >
            {bannerAnimating ? (
              <svg viewBox="0 0 10 10" fill="white" width={9} height={9}><rect x="1" y="1" width="3" height="8" /><rect x="6" y="1" width="3" height="8" /></svg>
            ) : (
              <svg viewBox="0 0 10 10" fill="white" width={9} height={9}><polygon points="1,1 9,5 1,9" /></svg>
            )}
            <span className="text-xs font-medium text-white">
              {bannerAnimating ? 'Stop' : 'Play'}
            </span>
          </button>

          {/* Instance badge — bottom right */}
          {instance && (
            <div className="absolute bottom-4 right-4 flex items-center gap-1.5">
              <span style={{ fontSize: 10, color: loaderColor(instance.loader), fontWeight: 600 }}>{instance.loader}</span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.18)', fontWeight: 500 }}>{instance.mc_version}</span>
            </div>
          )}
        </div>

        {/* RIGHT: Launcher panel */}
        <div className="relative flex w-[28%] flex-shrink-0 flex-col items-center justify-between overflow-hidden px-1 py-5">

          <button
            onClick={() => navigate('/information')}
            className="absolute flex items-center justify-center rounded-lg transition-all duration-150"
            style={{ top: 8, right: 8, width: 36, height: 36, color: 'rgba(255,255,255,0.3)', background: 'transparent' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.3)'; e.currentTarget.style.background = 'transparent' }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width={20} height={20}><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" /></svg>
          </button>

          <h1 className="text-center font-black text-white leading-none" style={{ fontSize: 'clamp(28px, 3.5vw, 64px)', textShadow: '0 0 40px rgba(75,63,207,0.60)', letterSpacing: '-0.01em' }}>
            YuyuFrame
          </h1>

          {/* Avatar */}
          <div className="flex flex-col items-center gap-2">
            {username ? (
              <button onClick={() => navigate('/login')} className="flex flex-col items-center gap-2 group" title="Gérer les comptes">
                <div className="relative">
                  {uuid && (
                    <img
                      src={`https://mc-heads.net/avatar/${uuid}/200`}
                      alt={username}
                      className="rounded-xl transition-all duration-200 group-hover:brightness-75"
                      style={{ width: 'clamp(80px, 9vw, 150px)', height: 'clamp(80px, 9vw, 150px)', imageRendering: 'pixelated', boxShadow: '0 4px 24px rgba(0,0,0,0.6)' }}
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                        const fb = e.currentTarget.nextElementSibling as HTMLElement | null
                        if (fb) fb.style.display = 'flex'
                      }}
                    />
                  )}
                  <div className="items-center justify-center rounded-xl font-black text-white transition-all duration-200 group-hover:brightness-75"
                    style={{ width: 'clamp(80px, 9vw, 150px)', height: 'clamp(80px, 9vw, 150px)', fontSize: 'clamp(28px, 4vw, 56px)', background: 'rgba(75,63,207,0.60)', fontFamily: 'monospace', display: uuid ? 'none' : 'flex' }}>
                    {username[0].toUpperCase()}
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    <svg viewBox="0 0 24 24" fill="white" style={{ width: 24, height: 24, opacity: 0.9 }}>
                      <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                    </svg>
                  </div>
                </div>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>{username}</span>
              </button>
            ) : (
              <button
                onClick={() => navigate('/login')}
                className="flex flex-col items-center justify-center gap-2 rounded-xl transition-all duration-200"
                style={{ width: 'clamp(80px, 9vw, 150px)', height: 'clamp(80px, 9vw, 150px)', border: '2px dashed rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.25)' }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(75,63,207,0.5)'; e.currentTarget.style.color = 'rgba(120,110,230,0.7)' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = 'rgba(255,255,255,0.25)' }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="h-8 w-8">
                  <path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z" />
                </svg>
                <span style={{ fontSize: 10, letterSpacing: '0.1em', fontWeight: 600 }}>SE CONNECTER</span>
              </button>
            )}
          </div>

          <div className="w-full h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />

          {/* Instance selector */}
          <div className="w-full flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600 }}>
                Instance
              </label>
              <button
                onClick={() => navigate('/instances')}
                className="flex items-center gap-1 transition-colors duration-150"
                style={{ fontSize: 10, color: 'rgba(75,63,207,0.7)', fontWeight: 600 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#7872e8' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(75,63,207,0.7)' }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width={10} height={10}><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" /></svg>
                Gérer
              </button>
            </div>

            {instances.length === 0 ? (
              <button
                onClick={() => navigate('/instances')}
                className="w-full flex items-center justify-center gap-2 rounded-xl transition-all duration-200"
                style={{ height: 45, border: '2px dashed rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.2)', fontSize: 12 }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(75,63,207,0.4)'; e.currentTarget.style.color = 'rgba(120,110,230,0.6)' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = 'rgba(255,255,255,0.2)' }}
              >
                Créer une instance
              </button>
            ) : (
              <div className="relative w-full">
                <select
                  value={selectedInstanceId ?? ''}
                  onChange={(e) => setSelectedInstanceId(e.target.value)}
                  className="w-full appearance-none rounded-xl px-3 pr-8 text-sm font-medium text-white outline-none"
                  style={{ height: 45, background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  {instances.map((inst) => (
                    <option key={inst.id} value={inst.id} style={{ background: '#111118', color: 'white' }}>
                      {inst.name} — {inst.mc_version} ({inst.loader})
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                  <svg viewBox="0 0 10 6" fill="white" width={10} height={6} style={{ opacity: 0.45 }}>
                    <path d="M0 0l5 6 5-6z" />
                  </svg>
                </div>
              </div>
            )}

            {/* Instance info pill */}
            {instance && (
              <div className="flex flex-col gap-1.5 px-3 py-1.5 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex items-center gap-2">
                  <span style={{ fontSize: 10, color: loaderColor(instance.loader), fontWeight: 700 }}>{instance.loader.toUpperCase()}</span>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>·</span>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>{instance.mc_version}</span>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>·</span>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>{instance.ram_mb >= 1024 ? `${instance.ram_mb / 1024}Go` : `${instance.ram_mb}Mo`}</span>
                </div>

                <button
                  onClick={() => !gameRunning && !BETA_TEST && setP2pEnabled(!p2pEnabled)}
                  disabled={gameRunning || BETA_TEST}
                  title={BETA_TEST ? 'P2P non disponible en beta' : undefined}
                  className="flex items-center justify-between transition-all duration-150"
                  style={{
                    height: 26, borderRadius: 8, padding: '0 8px',
                    cursor: gameRunning || BETA_TEST ? 'not-allowed' : 'pointer',
                    background: BETA_TEST ? 'rgba(255,255,255,0.01)' : p2pEnabled ? 'rgba(75,63,207,0.18)' : 'rgba(255,255,255,0.02)',
                    border: BETA_TEST ? '1px solid rgba(255,255,255,0.04)' : p2pEnabled ? '1px solid rgba(120,100,255,0.35)' : '1px solid rgba(255,255,255,0.06)',
                    opacity: BETA_TEST ? 0.60 : 1,
                  }}
                >
                  <span className="flex items-center gap-1.5" style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.25)' }}>
                    <svg viewBox="0 0 24 24" fill="currentColor" width={11} height={11}><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" /></svg>
                    P2P {BETA_TEST && <span style={{ fontSize: 9, opacity: 0.6 }}>(bêta)</span>}
                  </span>
                  <span
                    className="relative transition-all duration-200"
                    style={{ width: 26, height: 14, borderRadius: 7, background: 'rgba(255,255,255,0.12)' }}
                  >
                    <span
                      className="absolute top-0.5 rounded-full bg-white transition-all duration-200"
                      style={{ width: 10, height: 10, left: 2, opacity: 0.4 }}
                    />
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* Launch button */}
          <button
            onClick={username ? handleLaunch : () => navigate('/login')}
            disabled={gameRunning || (!!username && !selectedInstanceId)}
            className="w-full font-bold text-white transition-all duration-200 active:scale-95"
            style={{
              height: 60, borderRadius: 16, fontSize: 14, letterSpacing: '0.04em',
              background: canLaunch ? '#4B3FCF' : !username ? 'rgba(75,63,207,0.45)' : 'rgba(40,38,65,0.7)',
              boxShadow: canLaunch ? '0 4px 28px rgba(75,63,207,0.42)' : 'none',
              cursor: (gameRunning || (!!username && !selectedInstanceId)) ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => { if (canLaunch) { e.currentTarget.style.background = '#6155e8'; e.currentTarget.style.boxShadow = '0 6px 32px rgba(75,63,207,0.62)' } else if (!username) { e.currentTarget.style.background = 'rgba(75,63,207,0.65)' } }}
            onMouseLeave={(e) => { if (canLaunch) { e.currentTarget.style.background = '#4B3FCF'; e.currentTarget.style.boxShadow = '0 4px 28px rgba(75,63,207,0.42)' } else if (!username) { e.currentTarget.style.background = 'rgba(75,63,207,0.45)' } }}
          >
            {gameRunning ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin-slow rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
                EN JEU...
              </span>
            ) : !username ? 'SE CONNECTER'
              : !selectedInstanceId ? 'AUCUNE INSTANCE'
              : `LANCER ${instance?.name ?? ''}`}
          </button>

          {launchMsg && (
            <p className="w-full rounded-lg px-3 py-2 text-center text-xs text-red-300" style={{ background: 'rgba(200,50,50,0.12)' }}>
              {launchMsg}
            </p>
          )}

          {progress && (
            <div className="w-full flex flex-col gap-1.5">
              <div className="flex justify-between" style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
                <span className="truncate">{progress.message}</span>
                <span className="ml-2 flex-shrink-0">{percent}%</span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: 'rgba(0,0,0,0.4)' }}>
                <div className="h-full rounded-full transition-all duration-300" style={{ width: `${percent}%`, background: '#4B3FCF' }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Footer ── */}
      <div
        className="flex flex-shrink-0 flex-col px-6 py-4"
        style={{ flex: '0 0 30%', minHeight: 250, background: '#09090D', borderTop: '1px solid rgba(255,255,255,0.06)', gap: 12 }}
      >

        {/* Zone principale — s'étire pour remplir l'espace disponible */}
        <div className="flex flex-1 flex-col gap-4">

        {/* Feature cards — explicatif */}
        <div className="flex items-stretch gap-2">
          {FEATURES.map((f, i) => {
            const betaLocked = BETA_TEST && (f.path === '/sync')
            return (
            <div
              key={i}
              onClick={f.path && !betaLocked ? () => navigate(f.path!) : undefined}
              className="flex flex-1 flex-col gap-1.5 rounded-xl px-3 py-2.5 transition-all duration-150"
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.05)',
                cursor: betaLocked ? 'not-allowed' : f.path ? 'pointer' : 'default',
                opacity: betaLocked ? 0.60 : 1,
              }}
              onMouseEnter={(e) => {
                if (!f.path || betaLocked) return
                e.currentTarget.style.background = 'rgba(75,63,207,0.06)'
                e.currentTarget.style.borderColor = 'rgba(120,100,255,0.25)'
              }}
              onMouseLeave={(e) => {
                if (!f.path || betaLocked) return
                e.currentTarget.style.background = 'rgba(255,255,255,0.02)'
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)'
              }}
            >
              <div className="flex items-center gap-1.5" style={{ color: 'rgba(255,255,255,0.35)' }}>
                {f.icon}
                <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' }}>
                  {f.title}
                </span>
              </div>
              <p style={{ fontSize: 9, color: 'rgba(255,255,255,0.28)', lineHeight: 1.55, margin: 0 }}>
                {f.desc}
              </p>
            </div>
          )})}
        </div>

        {/* Brand | Nav | Promo — 3 colonnes égales, alignées en haut */}
        <div className="my-auto grid gap-8" style={{ gridTemplateColumns: 'auto 1fr auto', alignItems: 'center' }}>

          {/* LEFT — Brand + compte */}
          <div className="flex flex-col gap-2">
            <span className="font-black text-white" style={{ fontSize: 15, letterSpacing: '-0.01em' }}>
              YuyuFrame
            </span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.22)', lineHeight: 1.5 }}>
              Le launcher Minecraft open-source.
            </span>
            <div className="flex items-center mt-1">
              {username ? (
                <div className="flex items-center overflow-hidden" style={{ height: 32, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)' }}>
                  <button
                    onClick={() => navigate('/login')}
                    className="flex items-center gap-2 h-full pl-2.5 pr-3 transition-all duration-150"
                    title="Gérer le compte"
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(75,63,207,0.14)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', flexShrink: 0, display: 'inline-block' }} />
                    {uuid && (
                      <img src={`https://mc-heads.net/avatar/${uuid}/32`} alt={username}
                        style={{ width: 16, height: 16, imageRendering: 'pixelated', borderRadius: 3, flexShrink: 0 }}
                        onError={(e) => { e.currentTarget.style.display = 'none' }}
                      />
                    )}
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.82)', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {username}
                    </span>
                  </button>
                  <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
                  <button
                    onClick={handleLogout}
                    className="flex items-center justify-center h-full px-2.5 transition-all duration-150"
                    title="Déconnexion"
                    style={{ color: 'rgba(255,255,255,0.28)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(200,50,50,0.14)'; e.currentTarget.style.color = 'rgb(248,113,113)' }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(255,255,255,0.28)' }}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12}>
                      <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => navigate('/login')}
                  className="flex items-center gap-1.5 rounded-xl px-4 font-semibold transition-all duration-200"
                  style={{ height: 32, fontSize: 11, background: '#4B3FCF', color: 'white' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#6155e8' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#4B3FCF' }}
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12}><path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z" /></svg>
                  Se connecter
                </button>
              )}
            </div>
          </div>

          {/* CENTER — Nav pyramid */}
          <div className="flex items-center justify-center gap-2 w-full" style={{ containerType: 'inline-size' }}>
            <NavLink label="Instances" path="/instances" onClick={() => navigate('/instances')} currentPath={location.pathname} distance={3}>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.12-.36.18-.57.18s-.41-.06-.57-.18l-7.9-4.44A1 1 0 013 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.12.36-.18.57-.18s.41.06.57.18l7.9 4.44c.32.17.53.5.53.88v9z" /></svg>
            </NavLink>
            <NavLink label="Réglages" path="/settings" onClick={() => navigate('/settings')} currentPath={location.pathname} distance={2}>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" /></svg>
            </NavLink>
            <NavLink label="Sync" path="/sync" onClick={() => navigate('/sync')} currentPath={location.pathname} distance={1} accent disabled={BETA_TEST}>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" /></svg>
            </NavLink>
            <NavLink label="Plans" path="/plans" onClick={() => navigate('/plans')} currentPath={location.pathname} distance={0} plans disabled={BETA_TEST}>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>
            </NavLink>
            <NavLink label="Stats" path="/stats" onClick={() => navigate('/stats')} currentPath={location.pathname} distance={1} accent>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z" /></svg>
            </NavLink>
            <NavLink label="Compte" path="/login" onClick={() => navigate('/login')} currentPath={location.pathname} distance={2}>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" /></svg>
            </NavLink>
            <NavLink label="Serveur" path="/server" onClick={() => navigate('/server')} currentPath={location.pathname} distance={3} disabled={BETA_TEST}>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" /></svg>
            </NavLink>
          </div>

          {/* RIGHT — YuyuFrame Pro, miroir du LEFT aligné à droite */}
          <div className="flex flex-col gap-2 items-end">
            <span className="font-black text-white text-right" style={{ fontSize: 15, letterSpacing: '-0.01em' }}>
              YuyuFrame <span style={{ color: '#a78bfa' }}>Pro</span>
            </span>
            <span className="text-right" style={{ fontSize: 10, color: 'rgba(255,255,255,0.22)', lineHeight: 1.6 }}>
              Sync illimité · Stats avancées
            </span>
            {/* Pill pleine largeur : bouton | séparateur | -50% */}
            <div className="flex items-center overflow-hidden mt-1" style={{ height: 32, borderRadius: 10, background: 'rgba(75,63,207,0.08)', border: '1px solid rgba(120,100,255,0.2)' }}>
              <button
                onClick={() => navigate('/plans')}
                className="flex items-center gap-2 h-full pl-3 pr-3 transition-all duration-150"
                title="Voir les plans Pro"
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(75,63,207,0.2)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12} style={{ color: '#a78bfa', flexShrink: 0 }}><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.82)', whiteSpace: 'nowrap' }}>
                  Voir les plans
                </span>
              </button>
              <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
              <div className="flex items-center justify-center h-full px-3">
                <span style={{ fontSize: 10, fontWeight: 700, color: '#a78bfa', whiteSpace: 'nowrap' }}>-50%</span>
              </div>
            </div>
          </div>
        </div>

        </div>{/* fin zone principale */}

        {/* Divider — collé en bas */}
        <div className="mt-auto h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />

        {/* Copyright + legal */}
        <div className="flex items-center justify-between">
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.15)', fontWeight: 500 }}>
            © 2025 YuyuFrame — Tous droits réservés
          </span>
          <div className="flex items-center gap-4">
            {['Licence', 'Confidentialité', 'Conditions'].map((lbl) => (
              <button
                key={lbl}
                className="transition-colors duration-150"
                style={{ fontSize: 10, color: 'rgba(255,255,255,0.18)', fontWeight: 500 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.5)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.18)' }}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  )
}


function NavLink({ label, onClick, plans, accent, distance = 0, path, currentPath, disabled, children }: {
  label: string; onClick: () => void; plans?: boolean; accent?: boolean; distance?: number; path?: string; currentPath?: string; disabled?: boolean; children: React.ReactNode
}) {
  // Tailles relatives à la fenêtre via clamp — s'adaptent à toutes les largeurs
  // Unités cqw : relatives à la largeur réellement disponible pour la nav (container query),
  // plutôt qu'à la largeur de toute la fenêtre — la nav s'adapte donc à la place qui lui est laissée.
  const SIZES = [
    { h: 'clamp(52px,6vh,76px)', fs: 'clamp(13px,2.6cqw,21px)', fw: 700,  icon: 'clamp(16px,2.6cqw,22px)', px: 'clamp(7px,1.4cqw,12px)' },
    { h: 'clamp(46px,5.5vh,68px)', fs: 'clamp(12px,2.3cqw,19px)', fw: 650, icon: 'clamp(14px,2.3cqw,19px)', px: 'clamp(6px,1.2cqw,11px)' },
    { h: 'clamp(40px,5vh,60px)',   fs: 'clamp(11px,2cqw,17px)', fw: 600, icon: 'clamp(12px,2cqw,17px)', px: 'clamp(5px,1.1cqw,9px)'   },
    { h: 'clamp(36px,4.5vh,52px)', fs: 'clamp(10px,1.7cqw,14px)', fw: 550, icon: 'clamp(11px,1.7cqw,14px)', px: 'clamp(4px,0.9cqw,8px)' },
  ]

  const d = Math.min(distance, 3)
  const { h, fs, fw, icon, px } = SIZES[d]
  const isActive = path ? currentPath === path : false
  const baseColor = plans ? '#c4b5fd' : isActive ? '#a5b4fc' : 'rgba(255,255,255,0.9)'

  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? 'Non disponible en bêta' : undefined}
      className="relative flex items-center gap-1 rounded-xl transition-all duration-150"
      style={{
        height: h, fontSize: fs, fontWeight: fw, color: baseColor,
        paddingLeft: px, paddingRight: px,
        background: disabled ? (plans ? 'rgba(75,63,207,0.1)' : 'transparent') : plans ? 'rgba(75,63,207,0.1)' : 'transparent',
        border: disabled ? (plans ? '1px solid rgba(120,100,255,0.22)' : '1px solid transparent') : plans ? '1px solid rgba(120,100,255,0.22)' : '1px solid transparent',
        boxShadow: disabled ? (plans ? '0 0 18px rgba(75,63,207,0.12) inset' : 'none') : plans ? '0 0 18px rgba(75,63,207,0.12) inset' : 'none',
        whiteSpace: 'nowrap',
        opacity: disabled ? 0.60 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        if (plans) {
          e.currentTarget.style.color = '#e9d5ff'
          e.currentTarget.style.background = 'rgba(75,63,207,0.22)'
          e.currentTarget.style.borderColor = 'rgba(139,92,246,0.48)'
        } else if (accent) {
          e.currentTarget.style.color = '#c4b5fd'
          e.currentTarget.style.background = 'rgba(139,92,246,0.22)'
          e.currentTarget.style.borderColor = 'rgba(139,92,246,0.60)'
        } else {
          e.currentTarget.style.color = 'rgba(255,255,255,0.92)'
          e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
        }
      }}
      onMouseLeave={(e) => {
        if (disabled) return
        e.currentTarget.style.color = baseColor
        e.currentTarget.style.background = plans ? 'rgba(75,63,207,0.1)' : 'transparent'
        e.currentTarget.style.borderColor = plans ? 'rgba(120,100,255,0.22)' : 'transparent'
      }}
    >
      <span style={{ display: 'flex', width: icon, height: icon, flexShrink: 0, color: plans ? '#a78bfa' : 'inherit' }}>{children}</span>
      {label}
      {isActive && (
        <span style={{ position: 'absolute', bottom: 5, left: '50%', transform: 'translateX(-50%)', width: 14, height: 2, borderRadius: 1, background: plans ? '#a78bfa' : '#818cf8' }} />
      )}
    </button>
  )
}
