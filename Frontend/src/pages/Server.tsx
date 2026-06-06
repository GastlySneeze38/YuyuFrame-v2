import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { api } from '@/api/client'
import { useStore } from '@/stores/useStore'

export default function Server() {
  const navigate = useNavigate()
  const {
    username,
    selectedInstanceId, selectedInstance,
    isInstanceRunning, setInstanceRunning,
    closeOnLaunch,
  } = useStore()

  const gameRunning = !!selectedInstanceId && isInstanceRunning(selectedInstanceId)
  const instance = selectedInstance()
  const [launchMsg, setLaunchMsg] = useState('')

  useEffect(() => {
    let unlistenState: (() => void) | null = null
    let unlistenError: (() => void) | null = null

    listen<{ running: boolean; instance_id: string }>('game_state', (event) => {
      const { running, instance_id } = event.payload
      setInstanceRunning(instance_id, running)
      if (!running) getCurrentWindow().show()
    }).then((fn) => { unlistenState = fn })

    listen<string>('launch_error', (event) => {
      setLaunchMsg(event.payload)
      if (selectedInstanceId) setInstanceRunning(selectedInstanceId, false)
    }).then((fn) => { unlistenError = fn })

    return () => {
      unlistenState?.()
      unlistenError?.()
    }
  }, [])

  const canLaunch = !!selectedInstanceId && !!username && !gameRunning

  const handleLaunch = async () => {
    if (!selectedInstanceId || gameRunning || !username) return
    setLaunchMsg('')
    try {
      await api.launch.startP2p(selectedInstanceId)
      setInstanceRunning(selectedInstanceId, true)
      if (closeOnLaunch) getCurrentWindow().hide()
    } catch (e) {
      setLaunchMsg(e instanceof Error ? e.message : 'Erreur de lancement')
    }
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6" style={{ background: '#09090D' }}>

      {/* Header */}
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-center justify-center rounded-2xl" style={{ width: 56, height: 56, background: 'rgba(75,63,207,0.18)', border: '1px solid rgba(75,63,207,0.35)' }}>
          <svg viewBox="0 0 24 24" fill="rgba(120,110,230,0.9)" width={26} height={26}>
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
          </svg>
        </div>
        <h1 className="font-black text-white" style={{ fontSize: 28, letterSpacing: '-0.01em', textShadow: '0 0 32px rgba(75,63,207,0.5)' }}>
          Serveur P2P
        </h1>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', textAlign: 'center', maxWidth: 320 }}>
          {instance ? (
            <span style={{ color: 'rgba(120,110,230,0.7)', fontWeight: 600 }}>{instance.name} — {instance.mc_version}</span>
          ) : (
            <span style={{ color: 'rgba(255,100,100,0.6)' }}>Aucune instance sélectionnée</span>
          )}
        </p>
      </div>

      {/* Explication */}
      <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <InfoRow icon="🎮" label="Héberger" desc="Charge un monde solo — ton code de session s'affiche dans le menu pause." />
        <InfoRow icon="🔗" label="Rejoindre" desc="Va dans Multijoueur → onglet P2P → entre le code de ton ami." />
      </div>

      {/* Bouton lancer */}
      <button
        onClick={username ? handleLaunch : () => navigate('/login')}
        disabled={gameRunning || (!!username && !selectedInstanceId)}
        className="font-bold text-white transition-all duration-200 active:scale-95"
        style={{
          width: 280, height: 60, borderRadius: 18, fontSize: 14, letterSpacing: '0.06em',
          background: canLaunch ? '#4B3FCF' : !username ? 'rgba(75,63,207,0.45)' : 'rgba(40,38,65,0.7)',
          boxShadow: canLaunch ? '0 6px 36px rgba(75,63,207,0.5)' : 'none',
          cursor: (gameRunning || (!!username && !selectedInstanceId)) ? 'not-allowed' : 'pointer',
          border: '1px solid rgba(120,110,230,0.25)',
        }}
        onMouseEnter={(e) => { if (canLaunch) { e.currentTarget.style.background = '#6155e8'; e.currentTarget.style.boxShadow = '0 8px 40px rgba(75,63,207,0.65)' } }}
        onMouseLeave={(e) => { if (canLaunch) { e.currentTarget.style.background = '#4B3FCF'; e.currentTarget.style.boxShadow = '0 6px 36px rgba(75,63,207,0.5)' } }}
      >
        {gameRunning ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin-slow rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
            EN JEU...
          </span>
        ) : !username ? 'SE CONNECTER'
          : !selectedInstanceId ? 'AUCUNE INSTANCE'
          : 'LANCER AVEC P2P'}
      </button>

      {launchMsg && (
        <p className="rounded-lg px-4 py-2 text-center text-xs text-red-300" style={{ background: 'rgba(200,50,50,0.12)', maxWidth: 320 }}>
          {launchMsg}
        </p>
      )}

      {/* Back */}
      <button
        onClick={() => navigate('/home')}
        className="transition-colors duration-150"
        style={{ fontSize: 12, color: 'rgba(255,255,255,0.22)', fontWeight: 500 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.6)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.22)' }}
      >
        ← Retour
      </button>
    </div>
  )
}

function InfoRow({ icon, label, desc }: { icon: string; label: string; desc: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <span style={{ fontSize: 18, flexShrink: 0, marginTop: 1 }}>{icon}</span>
      <div>
        <p style={{ fontSize: 12, fontWeight: 700, color: 'rgba(200,195,255,0.85)', marginBottom: 2 }}>{label}</p>
        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', lineHeight: 1.5 }}>{desc}</p>
      </div>
    </div>
  )
}
