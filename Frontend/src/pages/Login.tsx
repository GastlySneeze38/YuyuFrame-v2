import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { open } from '@tauri-apps/plugin-shell'
import { SkinViewer, WalkingAnimation } from 'skinview3d'
import { api } from '@/api/client'
import { useStore } from '@/stores/useStore'
import type { Account } from '@/types'

type Step = 'idle' | 'loading' | 'polling' | 'error'

export default function Login() {
  const navigate = useNavigate()
  const { uuid, accounts, setAccounts, setUser, removeAccount } = useStore()
  const [step, setStep] = useState<Step>('idle')
  const [userCode, setUserCode] = useState('')
  const [verifyUrl, setVerifyUrl] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [previewUuid, setPreviewUuid] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<SkinViewer | null>(null)

  useEffect(() => {
    api.mc.accounts()
      .then((accs) => {
        const mapped: Account[] = accs.map((a) => ({ username: a.mc_username, uuid: a.mc_uuid }))
        setAccounts(mapped)
        const active = accs.find((a) => a.is_active)
        if (active) setUser(active.mc_username, active.mc_uuid)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!canvasRef.current || !canvasContainerRef.current) return
    const container = canvasContainerRef.current
    const { width: w, height: h } = container.getBoundingClientRect()
    const viewer = new SkinViewer({
      canvas: canvasRef.current,
      width: w || 360,
      height: h || 520,
    })
    viewer.background = null
    viewer.autoRotate = true
    viewer.autoRotateSpeed = 0.7
    viewer.zoom = 0.85
    viewer.fov = 60
    viewer.animation = new WalkingAnimation()
    viewer.animation.speed = 0.4
    viewerRef.current = viewer

    const ro = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect()
      if (width > 0 && height > 0) viewer.setSize(width, height)
    })
    ro.observe(container)

    return () => {
      ro.disconnect()
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    const displayUuid = previewUuid ?? uuid
    if (displayUuid) {
      ;(viewer.loadSkin(`https://mc-heads.net/skin/${displayUuid}`, { model: 'auto-detect' }) as Promise<void> | void)?.catch?.(() => {})
    } else {
      viewer.loadSkin(null)
    }
  }, [uuid, previewUuid])

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const startLogin = async () => {
    setStep('loading')
    setError('')
    try {
      const resp = await api.auth.startDevice()
      setUserCode(resp.user_code)
      setVerifyUrl(resp.verification_uri)
      open(resp.verification_uri)
      setStep('polling')
      pollRef.current = setInterval(async () => {
        try {
          const poll = await api.auth.poll()
          if (poll.status === 'success' && poll.username) {
            stopPolling()
            const accs = await api.mc.accounts()
            const mapped: Account[] = accs.map((a) => ({ username: a.mc_username, uuid: a.mc_uuid }))
            setAccounts(mapped)
            const active = accs.find((a) => a.is_active)
            if (active) setUser(active.mc_username, active.mc_uuid)
            navigate('/home', { replace: true })
          } else if (poll.status === 'error') {
            stopPolling()
            setError(poll.error ?? 'Erreur inconnue')
            setStep('error')
          }
        } catch { /* keep polling */ }
      }, 5000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur de connexion au backend')
      setStep('error')
    }
  }

  const handleSelect = async (acc: Account) => {
    try {
      await api.mc.switch(acc.uuid)
      setUser(acc.username, acc.uuid)
      navigate('/home')
    } catch { /* ignore */ }
  }

  const handleRemove = async (acc: Account) => {
    try {
      await api.mc.delete(acc.uuid)
      removeAccount(acc.uuid)
    } catch { /* ignore */ }
  }

  useEffect(() => () => stopPolling(), [])

  const displayAccount = accounts.find((a) => a.uuid === (previewUuid ?? uuid))

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: '#09090D' }}>

      {/* Header */}
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
            Connexion
          </h1>
          <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 1 }}>
            Gérez vos comptes Minecraft (max 2)
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left — 3D skin viewer */}
        <div
          className="relative flex flex-shrink-0 flex-col"
          style={{
            width: '38%',
            background: 'radial-gradient(ellipse at 50% 58%, rgba(75,63,207,0.22) 0%, transparent 72%)',
            borderRight: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          {/* shadow under feet */}
          <div
            className="absolute"
            style={{
              bottom: '18%',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '28%',
              height: 14,
              background: 'rgba(75,63,207,0.55)',
              borderRadius: '50%',
              filter: 'blur(20px)',
            }}
          />

          {/* Canvas fills all available height */}
          <div ref={canvasContainerRef} className="relative z-10 min-h-0 flex-1">
            <canvas
              ref={canvasRef}
              style={{ background: 'transparent', display: 'block' }}
            />
          </div>

          <div className="relative z-10 flex flex-shrink-0 flex-col items-center gap-0.5 py-3">
            {displayAccount ? (
              <>
                <p className="font-bold text-white" style={{ fontSize: 13 }}>
                  {displayAccount.username}
                </p>
                <p style={{
                  fontSize: 10,
                  color: displayAccount.uuid === uuid ? 'rgba(74,222,128,0.75)' : 'rgba(255,255,255,0.3)',
                }}>
                  {displayAccount.uuid === uuid ? '● Actif' : '○ Aperçu'}
                </p>
              </>
            ) : (
              <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>Aucun compte</p>
            )}
          </div>
        </div>

        {/* Right — account management */}
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-8 py-7">

          {/* Branding */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <div className="h-4 w-4 rounded-sm" style={{ background: '#4B3FCF' }} />
              <span className="font-black text-white" style={{ fontSize: 22, letterSpacing: '-0.01em' }}>
                YuyuFrame
              </span>
            </div>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.28)' }}>
              {accounts.length === 0
                ? 'Connecte-toi pour jouer'
                : accounts.length < 2
                ? 'Ajoute un deuxième compte ou continue'
                : 'Sélectionne le compte avec lequel jouer'}
            </p>
          </div>

          {/* Account rows */}
          <div className="flex flex-col gap-2">
            {accounts.map((acc) => (
              <AccountRow
                key={acc.uuid}
                acc={acc}
                isActive={acc.uuid === uuid}
                onSelect={() => handleSelect(acc)}
                onRemove={() => handleRemove(acc)}
                onHover={() => setPreviewUuid(acc.uuid)}
                onLeave={() => setPreviewUuid(null)}
              />
            ))}

            {accounts.length < 2 && step === 'idle' && (
              <AddRow onClick={startLogin} />
            )}
          </div>

          {/* Auth flow panel */}
          {(step === 'loading' || step === 'polling' || step === 'error') && (
            <div
              className="rounded-2xl p-5"
              style={{
                background: 'rgba(255,255,255,0.025)',
                border: '1px solid rgba(255,255,255,0.07)',
              }}
            >
              {step === 'loading' && (
                <div className="flex items-center justify-center gap-3 py-2">
                  <span
                    className="h-4 w-4 animate-spin-slow rounded-full border-2"
                    style={{ borderColor: 'rgba(255,255,255,0.15)', borderTopColor: '#4B3FCF' }}
                  />
                  <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>Connexion en cours...</span>
                </div>
              )}

              {step === 'polling' && (
                <div className="flex flex-col gap-4">
                  <p className="text-center" style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
                    Entre ce code sur la page Microsoft :
                  </p>
                  <button
                    onClick={() => { navigator.clipboard.writeText(userCode); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
                    className="rounded-xl py-3 text-center transition-all duration-150"
                    style={{
                      background: copied ? 'rgba(74,222,128,0.08)' : 'rgba(0,0,0,0.4)',
                      border: `1px solid ${copied ? 'rgba(74,222,128,0.3)' : 'rgba(255,255,255,0.08)'}`,
                    }}
                    title="Cliquer pour copier"
                  >
                    <span className="font-mono font-black text-white" style={{ fontSize: 26, letterSpacing: '0.25em' }}>
                      {userCode}
                    </span>
                    <p style={{ fontSize: 10, marginTop: 4, color: copied ? 'rgb(134,239,172)' : 'rgba(255,255,255,0.2)' }}>
                      {copied ? 'Copié !' : 'Cliquer pour copier'}
                    </p>
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => open(verifyUrl)}
                      className="flex-1 rounded-xl py-2 text-sm font-medium text-white transition-all duration-150"
                      style={{ background: 'rgba(75,63,207,0.15)', border: '1px solid rgba(75,63,207,0.3)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(75,63,207,0.3)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(75,63,207,0.15)' }}
                    >
                      Ouvrir Microsoft →
                    </button>
                    <button
                      onClick={() => { stopPolling(); setStep('idle') }}
                      className="rounded-xl px-4 py-2 text-sm transition-all duration-150"
                      style={{ color: 'rgba(255,255,255,0.3)', border: '1px solid rgba(255,255,255,0.07)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.65)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.3)' }}
                    >
                      Annuler
                    </button>
                  </div>
                  <div className="flex items-center justify-center gap-2">
                    <span
                      className="h-3 w-3 animate-spin-slow rounded-full border"
                      style={{ borderColor: 'rgba(255,255,255,0.12)', borderTopColor: '#4B3FCF' }}
                    />
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                      En attente de confirmation...
                    </span>
                  </div>
                </div>
              )}

              {step === 'error' && (
                <div className="flex flex-col gap-3">
                  <div
                    className="rounded-xl px-4 py-3"
                    style={{ background: 'rgba(200,50,50,0.12)', border: '1px solid rgba(200,50,50,0.2)' }}
                  >
                    <p style={{ fontSize: 11, color: 'rgb(252,165,165)', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>{error}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => { navigator.clipboard.writeText(error); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
                      className="rounded-xl px-3 py-2 text-sm transition-all duration-150"
                      style={{ color: copied ? 'rgb(134,239,172)' : 'rgba(255,255,255,0.4)', border: `1px solid ${copied ? 'rgba(74,222,128,0.3)' : 'rgba(255,255,255,0.08)'}` }}
                    >
                      {copied ? 'Copié ✓' : 'Copier'}
                    </button>
                    <button
                      onClick={() => setStep('idle')}
                      className="flex-1 rounded-xl py-2 text-sm transition-all duration-150"
                      style={{ color: 'rgba(255,255,255,0.4)', border: '1px solid rgba(255,255,255,0.08)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(75,63,207,0.4)'; e.currentTarget.style.color = 'rgba(255,255,255,0.7)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = 'rgba(255,255,255,0.4)' }}
                    >
                      Réessayer
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AccountRow({
  acc, isActive, onSelect, onRemove, onHover, onLeave,
}: {
  acc: Account
  isActive: boolean
  onSelect: () => void
  onRemove: () => void
  onHover: () => void
  onLeave: () => void
}) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="flex items-center gap-3 rounded-xl p-3 transition-all duration-150"
      style={{
        background: isActive
          ? 'rgba(75,63,207,0.08)'
          : hovered ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${isActive ? 'rgba(75,63,207,0.35)' : hovered ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.06)'}`,
        boxShadow: isActive ? '0 0 24px rgba(75,63,207,0.1)' : 'none',
      }}
      onMouseEnter={() => { setHovered(true); onHover() }}
      onMouseLeave={() => { setHovered(false); onLeave() }}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        <img
          src={`https://mc-heads.net/avatar/${acc.uuid}/48`}
          alt={acc.username}
          className="rounded-lg"
          style={{ width: 44, height: 44, imageRendering: 'pixelated' }}
          onError={(e) => {
            e.currentTarget.style.display = 'none'
            const fb = e.currentTarget.nextElementSibling as HTMLElement | null
            if (fb) fb.style.display = 'flex'
          }}
        />
        <div
          className="hidden items-center justify-center rounded-lg font-black text-white"
          style={{ width: 44, height: 44, background: 'rgba(75,63,207,0.45)', fontFamily: 'monospace', fontSize: 18 }}
        >
          {acc.username[0].toUpperCase()}
        </div>
        {isActive && (
          <div
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2"
            style={{ background: '#22c55e', borderColor: '#09090D' }}
          />
        )}
      </div>

      {/* Info */}
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate font-semibold text-white" style={{ fontSize: 13 }}>{acc.username}</p>
        <p style={{ fontSize: 10, marginTop: 1, color: isActive ? 'rgba(74,222,128,0.7)' : 'rgba(255,255,255,0.3)' }}>
          {isActive ? '● Actif' : 'Compte sauvegardé'}
        </p>
      </div>

      {/* Actions */}
      <div className="flex flex-shrink-0 items-center gap-1.5">
        {isActive ? (
          <button
            onClick={onSelect}
            className="rounded-lg px-4 py-1.5 text-sm font-medium text-white transition-all duration-150"
            style={{ background: 'rgba(75,63,207,0.25)', border: '1px solid rgba(75,63,207,0.45)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(75,63,207,0.42)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(75,63,207,0.25)' }}
          >
            Jouer →
          </button>
        ) : (
          <button
            onClick={onSelect}
            className="rounded-lg px-3 py-1.5 text-sm transition-all duration-150"
            style={{ color: 'rgba(255,255,255,0.45)', border: '1px solid rgba(255,255,255,0.08)' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(75,63,207,0.45)'; e.currentTarget.style.color = 'rgba(255,255,255,0.9)' }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = 'rgba(255,255,255,0.45)' }}
          >
            Sélectionner
          </button>
        )}
        <button
          onClick={onRemove}
          className="flex h-7 w-7 items-center justify-center rounded-lg transition-all duration-150"
          style={{ color: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.05)', background: 'transparent' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'rgb(252,165,165)'; e.currentTarget.style.borderColor = 'rgba(200,50,50,0.3)'; e.currentTarget.style.background = 'rgba(200,50,50,0.08)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.2)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.05)'; e.currentTarget.style.background = 'transparent' }}
          title="Déconnecter"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 13, height: 13 }}>
            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
          </svg>
        </button>
      </div>
    </div>
  )
}

function AddRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl p-3 transition-all duration-200"
      style={{
        background: 'rgba(255,255,255,0.015)',
        border: '1.5px dashed rgba(255,255,255,0.08)',
        color: 'rgba(255,255,255,0.3)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(75,63,207,0.4)'
        e.currentTarget.style.color = 'rgba(140,130,240,0.8)'
        e.currentTarget.style.background = 'rgba(75,63,207,0.05)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
        e.currentTarget.style.color = 'rgba(255,255,255,0.3)'
        e.currentTarget.style.background = 'rgba(255,255,255,0.015)'
      }}
    >
      <div
        className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg"
        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
      </div>
      <div className="text-left">
        <p style={{ fontSize: 13, fontWeight: 600 }}>Ajouter un compte</p>
        <p style={{ fontSize: 10, marginTop: 2, color: 'rgba(255,255,255,0.2)' }}>Connexion via Microsoft</p>
      </div>
    </button>
  )
}
