import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { open } from '@tauri-apps/plugin-shell'
import { api } from '@/api/client'
import { useStore } from '@/stores/useStore'
import type { YuyuPlan } from '@/stores/useStore'
import { BETA_TEST } from '@/config/beta'

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    price: null,
    color: 'rgba(255,255,255,0.12)',
    borderColor: 'rgba(255,255,255,0.1)',
    badgeBg: 'rgba(255,255,255,0.08)',
    badgeColor: 'rgba(255,255,255,0.5)',
    glowColor: 'rgba(255,255,255,0.03)',
    features: [
      { label: 'Launcher & gestion des mods', ok: true },
      { label: '2 comptes Minecraft', ok: true },
      { label: 'Sync cloud', ok: false },
      { label: 'Comptes illimités', ok: false },
      { label: 'Stats & analytics', ok: false },
    ],
  },
  {
    id: 'premium',
    name: 'Premium',
    price: '7.99',
    color: '#818cf8',
    borderColor: 'rgba(129,140,248,0.35)',
    badgeBg: 'rgba(75,63,207,0.25)',
    badgeColor: '#818cf8',
    glowColor: 'rgba(75,63,207,0.08)',
    features: [
      { label: 'Tout le plan Free', ok: true },
      { label: 'Comptes Minecraft illimités', ok: true },
      { label: 'Sync cloud (3 saves)', ok: true },
      { label: 'Stats & analytics', ok: true },
      { label: 'Serveur en 1 clic', ok: false },
    ],
  },
  {
    id: 'ultimate',
    name: 'Ultimate',
    price: '15.99',
    color: '#f59e0b',
    borderColor: 'rgba(245,158,11,0.35)',
    badgeBg: 'rgba(245,158,11,0.15)',
    badgeColor: '#f59e0b',
    glowColor: 'rgba(245,158,11,0.06)',
    features: [
      { label: 'Tout le plan Premium', ok: true },
      { label: 'Sync cloud (10 saves)', ok: true },
      { label: 'Serveur Minecraft en 1 clic', ok: true },
      { label: 'Tunnel proxy & URL custom', ok: true },
      { label: 'Accès anticipé', ok: true },
    ],
  },
]

export default function Plans() {
  const navigate = useNavigate()
  const { yuyuPlanExpiresAt, yuyuUsername, isPremium, isUltimate, setYuyuPlan } = useStore()

  if (BETA_TEST) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4" style={{ background: '#09090D' }}>
        <div style={{ opacity: 0.15 }}>
          <svg viewBox="0 0 24 24" fill="white" width={48} height={48}><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" /></svg>
        </div>
        <p style={{ fontSize: 14, fontWeight: 700, color: 'rgba(255,255,255,0.5)' }}>Plans non disponibles en bêta</p>
        <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', textAlign: 'center', maxWidth: 280 }}>
          Le système d'abonnement sera accessible dans une prochaine version.
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

  const effectivePlan = isUltimate() ? 'ultimate' : isPremium() ? 'premium' : 'free'

  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [upgradeTarget, setUpgradeTarget] = useState<string | null>(null)
  const [checkoutState, setCheckoutState] = useState<'idle' | 'loading' | 'waiting' | 'success' | 'timeout' | 'error'>('idle')
  const [checkoutError, setCheckoutError] = useState<string | null>(null)

  const handleRefresh = async () => {
    setRefreshing(true)
    setRefreshMsg(null)
    try {
      const resp = await api.yuyu.refreshPlan()
      setYuyuPlan(resp.plan as YuyuPlan, resp.plan_expires_at)
      setRefreshMsg({ ok: true, text: `Plan mis à jour : ${resp.plan}` })
    } catch (e) {
      setRefreshMsg({ ok: false, text: 'Impossible de contacter le serveur' })
    } finally {
      setRefreshing(false)
      setTimeout(() => setRefreshMsg(null), 4000)
    }
  }

  const handleCheckout = async (planId: string) => {
    setCheckoutState('loading')
    setCheckoutError(null)
    try {
      if (import.meta.env.DEV) {
        const resp = await api.yuyu.devSimulatePayment(planId)
        setYuyuPlan(resp.plan as YuyuPlan, resp.plan_expires_at)
        setCheckoutState('success')
        setTimeout(() => { setUpgradeTarget(null); setCheckoutState('idle') }, 2500)
        return
      }
      const { checkout_url } = await api.yuyu.createCheckout(planId)
      await open(checkout_url)
      setCheckoutState('waiting')
      // Polling toutes les 3s pendant 60s max
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((r) => setTimeout(r, 3000))
        const resp = await api.yuyu.refreshPlan()
        if (resp.plan !== 'free') {
          setYuyuPlan(resp.plan as YuyuPlan, resp.plan_expires_at)
          setCheckoutState('success')
          setTimeout(() => { setUpgradeTarget(null); setCheckoutState('idle') }, 2500)
          return
        }
      }
      setCheckoutState('timeout')
    } catch (e) {
      setCheckoutError(String(e))
      setCheckoutState('error')
    }
  }

  return (
    <div
      className="flex h-full flex-col overflow-auto"
      style={{ background: '#09090D', color: 'white' }}
    >
      <div className="mx-auto w-full max-w-5xl px-6 py-10 flex flex-col gap-10">

        {/* Header */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => navigate('/home')}
            className="flex items-center gap-2 transition-colors duration-150"
            style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', fontWeight: 500 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.7)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.3)' }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14}>
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
            Retour
          </button>

          <div className="flex flex-col items-center gap-1">
            <h1 className="font-black text-white" style={{ fontSize: 30, letterSpacing: '-0.02em', textShadow: '0 0 40px rgba(75,63,207,0.5)' }}>
              Plans YuyuFrame
            </h1>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)' }}>
              Choisissez l'expérience qui vous correspond
            </p>
          </div>

          {/* Current plan badge + refresh */}
          <div style={{ width: 100 }} className="flex flex-col items-end gap-2">
            {yuyuUsername && (
              <>
                <div className="flex flex-col items-end gap-0.5">
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontWeight: 500 }}>Votre plan</span>
                  <PlanBadge plan={effectivePlan} />
                </div>
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="flex items-center gap-1.5 transition-colors duration-150"
                  style={{ fontSize: 10, color: refreshing ? 'rgba(255,255,255,0.2)' : 'rgba(75,63,207,0.7)', fontWeight: 600, cursor: refreshing ? 'not-allowed' : 'pointer' }}
                  onMouseEnter={(e) => { if (!refreshing) (e.currentTarget as HTMLElement).style.color = '#818cf8' }}
                  onMouseLeave={(e) => { if (!refreshing) (e.currentTarget as HTMLElement).style.color = 'rgba(75,63,207,0.7)' }}
                >
                  {refreshing ? (
                    <span className="h-3 w-3 animate-spin rounded-full border-2 flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.1)', borderTopColor: 'rgba(75,63,207,0.6)' }} />
                  ) : (
                    <svg viewBox="0 0 24 24" fill="currentColor" width={10} height={10}>
                      <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                    </svg>
                  )}
                  Rafraîchir
                </button>
              </>
            )}
          </div>
        </div>

        {/* Refresh feedback */}
        {refreshMsg && (
          <div
            className="flex items-center gap-2 rounded-xl px-4 py-2.5"
            style={{
              background: refreshMsg.ok ? 'rgba(74,222,128,0.07)' : 'rgba(200,50,50,0.1)',
              border: `1px solid ${refreshMsg.ok ? 'rgba(74,222,128,0.2)' : 'rgba(200,50,50,0.2)'}`,
            }}
          >
            <span style={{ fontSize: 12, color: refreshMsg.ok ? 'rgb(74,222,128)' : 'rgb(248,113,113)', fontWeight: 600 }}>
              {refreshMsg.text}
            </span>
          </div>
        )}

        {/* Plan expiry warning */}
        {yuyuPlanExpiresAt && effectivePlan !== 'free' && (
          <div
            className="flex items-center gap-3 rounded-2xl px-5 py-3"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}
          >
            <svg viewBox="0 0 24 24" fill="#f59e0b" width={16} height={16}>
              <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
            </svg>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
              Votre abonnement <span style={{ color: '#f59e0b', fontWeight: 600 }}>{effectivePlan}</span> expire le{' '}
              <span style={{ color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
                {new Date(yuyuPlanExpiresAt * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })}
              </span>.
            </p>
          </div>
        )}

        {/* Free notice banner */}
        <div
          className="flex items-center gap-3 rounded-2xl px-5 py-3"
          style={{ background: 'rgba(75,63,207,0.1)', border: '1px solid rgba(75,63,207,0.25)' }}
        >
          <svg viewBox="0 0 24 24" fill="#818cf8" width={16} height={16}>
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
          </svg>
          <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
            <span style={{ color: '#818cf8', fontWeight: 600 }}>Toutes les fonctionnalités sont gratuites pour l'instant.</span>{' '}
            YuyuFrame est en cours de développement — la facturation sera activée lors du lancement officiel.
          </p>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-3 gap-5">
          {PLANS.map((plan) => {
            const isCurrent = plan.id === effectivePlan
            return (
              <div
                key={plan.id}
                className="relative flex flex-col rounded-2xl overflow-hidden"
                style={{
                  background: `linear-gradient(145deg, rgba(255,255,255,0.03) 0%, ${plan.glowColor} 100%)`,
                  border: `1px solid ${isCurrent ? plan.borderColor : 'rgba(255,255,255,0.07)'}`,
                  boxShadow: isCurrent ? `0 0 0 1px ${plan.borderColor}, 0 8px 40px ${plan.glowColor}` : 'none',
                  transition: 'border-color 0.2s, box-shadow 0.2s',
                }}
              >
                {/* Top accent line */}
                {plan.price && (
                  <div className="h-0.5 w-full" style={{ background: `linear-gradient(90deg, transparent, ${plan.color}, transparent)` }} />
                )}

                {/* Current badge */}
                {isCurrent && (
                  <div
                    className="absolute right-3 top-3 rounded-full px-2 py-0.5"
                    style={{ background: plan.badgeBg, fontSize: 9, fontWeight: 700, color: plan.badgeColor, letterSpacing: '0.06em' }}
                  >
                    ACTUEL
                  </div>
                )}

                <div className="flex flex-col gap-6 p-6">
                  {/* Plan name & price */}
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <PlanIcon plan={plan.id} color={plan.color} />
                      <span className="font-bold" style={{ fontSize: 16, color: plan.price ? plan.color : 'rgba(255,255,255,0.7)' }}>
                        {plan.name}
                      </span>
                    </div>

                    {plan.price ? (
                      <div className="flex items-baseline gap-1">
                        <span className="font-black" style={{ fontSize: 32, color: 'white', letterSpacing: '-0.03em' }}>
                          {plan.price}€
                        </span>
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', fontWeight: 500 }}>/mois</span>
                        <span
                          className="ml-1 rounded-full px-1.5 py-0.5"
                          style={{ fontSize: 9, fontWeight: 700, color: '#4ade80', background: 'rgba(74,222,128,0.1)', letterSpacing: '0.05em' }}
                        >
                          GRATUIT
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-1">
                        <span className="font-black" style={{ fontSize: 32, color: 'white', letterSpacing: '-0.03em' }}>
                          0€
                        </span>
                        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', fontWeight: 500 }}>/mois</span>
                      </div>
                    )}
                  </div>

                  {/* Features */}
                  <div className="flex flex-col gap-2.5">
                    {plan.features.map((feat, i) => (
                      <div key={i} className="flex items-start gap-2.5">
                        <div className="mt-0.5 flex-shrink-0">
                          {feat.ok ? (
                            <svg viewBox="0 0 16 16" fill="none" width={14} height={14}>
                              <circle cx="8" cy="8" r="7" fill={plan.price ? plan.badgeBg : 'rgba(255,255,255,0.06)'} />
                              <path d="M4.5 8l2.5 2.5 4.5-5" stroke={plan.price ? plan.color : 'rgba(255,255,255,0.4)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 16 16" fill="none" width={14} height={14}>
                              <circle cx="8" cy="8" r="7" fill="rgba(255,255,255,0.03)" />
                              <path d="M5.5 10.5l5-5M10.5 10.5l-5-5" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                          )}
                        </div>
                        <span style={{ fontSize: 12, color: feat.ok ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.22)', lineHeight: 1.4 }}>
                          {feat.label}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* CTA */}
                  <button
                    className="w-full rounded-xl font-semibold transition-all duration-200 active:scale-95"
                    style={{
                      height: 40,
                      fontSize: 13,
                      background: isCurrent
                        ? (plan.price ? plan.badgeBg : 'rgba(255,255,255,0.06)')
                        : (plan.price ? plan.color : 'rgba(255,255,255,0.06)'),
                      color: isCurrent
                        ? (plan.price ? plan.color : 'rgba(255,255,255,0.4)')
                        : (plan.price ? '#09090D' : 'rgba(255,255,255,0.4)'),
                      border: isCurrent
                        ? `1px solid ${plan.price ? plan.borderColor : 'rgba(255,255,255,0.1)'}`
                        : 'none',
                      cursor: isCurrent ? 'default' : (plan.price ? 'pointer' : 'default'),
                      fontWeight: 700,
                    }}
                    disabled={isCurrent || !plan.price}
                    onClick={() => { if (!isCurrent && plan.price) setUpgradeTarget(plan.id) }}
                    onMouseEnter={(e) => {
                      if (!isCurrent && plan.price) {
                        (e.currentTarget as HTMLElement).style.filter = 'brightness(1.1)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.filter = ''
                    }}
                  >
                    {isCurrent ? 'Plan actuel' : plan.price ? `Passer à ${plan.name}` : 'Plan gratuit'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {/* Comparison table */}
        <div
          className="rounded-2xl overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <div className="px-6 py-4" style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.05em' }}>
              COMPARAISON DES QUOTAS
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
            {[
              { label: 'Comptes Minecraft', free: '2 max', premium: 'Illimités', ultimate: 'Illimités' },
              { label: 'Stats & analytics', free: 'Basiques', premium: 'Avancées', ultimate: 'Avancées' },
              { label: 'Instances locales', free: 'Illimitées', premium: 'Illimitées', ultimate: 'Illimitées' },
              { label: 'Instances synchronisées', free: '—', premium: '3 avec saves / 4 sans', ultimate: '10' },
              { label: 'Saves synchronisées (total)', free: '—', premium: '3', ultimate: '10' },
            ].map((row, i) => (
              <div key={i} className="grid grid-cols-4 px-6 py-3.5">
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', fontWeight: 500 }}>{row.label}</span>
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', textAlign: 'center' }}>{row.free}</span>
                <span style={{ fontSize: 12, color: '#818cf8', textAlign: 'center', fontWeight: 500 }}>{row.premium}</span>
                <span style={{ fontSize: 12, color: '#f59e0b', textAlign: 'center', fontWeight: 500 }}>{row.ultimate}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-4 px-6 py-2" style={{ background: 'rgba(255,255,255,0.02)', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.18)' }} />
            {['Free', 'Premium', 'Ultimate'].map((name, i) => (
              <span key={i} style={{ fontSize: 10, color: ['rgba(255,255,255,0.25)', '#818cf8', '#f59e0b'][i], textAlign: 'center', fontWeight: 700, letterSpacing: '0.06em' }}>
                {name.toUpperCase()}
              </span>
            ))}
          </div>
        </div>

        {/* Dev simulator — visible uniquement en mode développement Vite */}
        {import.meta.env.DEV && (
          <DevPaymentSimulator
            onSimulate={async (planId) => {
              const resp = await api.yuyu.devSimulatePayment(planId)
              setYuyuPlan(resp.plan as YuyuPlan, resp.plan_expires_at)
            }}
          />
        )}

        {/* Footer note */}
        <div className="text-center pb-4">
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', lineHeight: 1.6 }}>
            YuyuFrame est un projet open-source en cours de développement.<br />
            Les abonnements seront activés lors du lancement officiel. Aucune carte bancaire requise pour l'instant.
          </p>
        </div>

      </div>

      {/* Upgrade modal */}
      {upgradeTarget && (
        <UpgradeModal
          plan={upgradeTarget}
          checkoutState={checkoutState}
          checkoutError={checkoutError}
          onClose={() => { setUpgradeTarget(null); setCheckoutState('idle'); setCheckoutError(null) }}
          onCheckout={() => handleCheckout(upgradeTarget)}
          onRefresh={async () => {
            await handleRefresh()
            setCheckoutState('idle')
          }}
          refreshing={refreshing}
        />
      )}
    </div>
  )
}

// ── Upgrade modal ─────────────────────────────────────────────────────────────

type CheckoutState = 'idle' | 'loading' | 'waiting' | 'success' | 'timeout' | 'error'

function UpgradeModal({
  plan,
  checkoutState,
  checkoutError,
  onClose,
  onCheckout,
  onRefresh,
  refreshing,
}: {
  plan: string
  checkoutState: CheckoutState
  checkoutError: string | null
  onClose: () => void
  onCheckout: () => Promise<void>
  onRefresh: () => Promise<void>
  refreshing: boolean
}) {
  const planMeta = PLANS.find((p) => p.id === plan)!
  const busy = checkoutState === 'loading' || checkoutState === 'waiting'
  const accentColor = planMeta.color === '#818cf8' ? '#4B3FCF' : 'rgba(245,158,11,0.9)'
  const accentText = planMeta.color === '#818cf8' ? 'white' : '#09090D'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(6px)' }}
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex flex-col gap-6 rounded-2xl p-8 w-full max-w-sm relative"
        style={{
          background: '#111118',
          border: `1px solid ${planMeta.borderColor}`,
          boxShadow: `0 0 60px ${planMeta.glowColor}, 0 24px 48px rgba(0,0,0,0.6)`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close */}
        {!busy && (
          <button
            onClick={onClose}
            className="absolute right-4 top-4 flex items-center justify-center rounded-lg transition-all duration-150"
            style={{ width: 28, height: 28, color: 'rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.04)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.25)'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14}>
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}

        {/* Icon + title */}
        <div className="flex flex-col items-center gap-3 text-center">
          <div
            className="flex items-center justify-center rounded-2xl"
            style={{ width: 56, height: 56, background: planMeta.badgeBg, border: `1px solid ${planMeta.borderColor}` }}
          >
            {checkoutState === 'success' ? (
              <svg viewBox="0 0 24 24" fill="#4ade80" width={22} height={22}>
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
            ) : (
              <PlanIcon plan={plan} color={planMeta.color} />
            )}
          </div>
          <div>
            <h2 className="font-black text-white" style={{ fontSize: 20, letterSpacing: '-0.01em' }}>
              {checkoutState === 'success' ? 'Plan activé !' : `Plan ${planMeta.name}`}
            </h2>
            <p style={{ fontSize: 13, color: checkoutState === 'success' ? '#4ade80' : planMeta.color, fontWeight: 700, marginTop: 2 }}>
              {checkoutState === 'success' ? `Bienvenue sur ${planMeta.name}` : `${planMeta.price}€ / mois`}
            </p>
          </div>
        </div>

        {/* State-dependent body */}
        {checkoutState === 'idle' && (
          <div
            className="flex flex-col gap-2 rounded-xl p-4"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" fill={planMeta.color} width={14} height={14} style={{ flexShrink: 0 }}>
                <path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z" />
              </svg>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>
                Paiement sécurisé via Lemon Squeezy
              </span>
            </div>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>
              Vous allez être redirigé vers la page de paiement dans votre navigateur. Votre plan sera activé <span style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>automatiquement</span> après confirmation du paiement.
            </p>
          </div>
        )}

        {(checkoutState === 'waiting' || checkoutState === 'loading') && (
          <div
            className="flex flex-col items-center gap-3 rounded-xl p-5"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            <span className="h-8 w-8 animate-spin rounded-full border-2 flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.08)', borderTopColor: planMeta.color }} />
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', textAlign: 'center', lineHeight: 1.6 }}>
              {checkoutState === 'loading' ? 'Création de la session de paiement...' : 'En attente de confirmation du paiement...\nCette fenêtre se mettra à jour automatiquement.'}
            </p>
          </div>
        )}

        {checkoutState === 'success' && (
          <div
            className="flex flex-col items-center gap-2 rounded-xl p-4"
            style={{ background: 'rgba(74,222,128,0.05)', border: '1px solid rgba(74,222,128,0.2)' }}
          >
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', textAlign: 'center', lineHeight: 1.6 }}>
              Votre abonnement <span style={{ color: planMeta.color, fontWeight: 700 }}>{planMeta.name}</span> est maintenant actif. Cette fenêtre va se fermer automatiquement.
            </p>
          </div>
        )}

        {checkoutState === 'timeout' && (
          <div
            className="flex flex-col gap-2 rounded-xl p-4"
            style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}
          >
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" fill="#f59e0b" width={14} height={14} style={{ flexShrink: 0 }}>
                <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
              </svg>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>Paiement non détecté</span>
            </div>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.6 }}>
              Si vous avez finalisé le paiement, cliquez sur <span style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>Rafraîchir mon plan</span> pour vérifier manuellement.
            </p>
          </div>
        )}

        {checkoutState === 'error' && (
          <div
            className="flex flex-col gap-2 rounded-xl p-4"
            style={{ background: 'rgba(200,50,50,0.08)', border: '1px solid rgba(200,50,50,0.2)' }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: 'rgb(248,113,113)' }}>Erreur</span>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', lineHeight: 1.6, wordBreak: 'break-word' }}>
              {checkoutError ?? 'Une erreur inattendue est survenue.'}
            </p>
          </div>
        )}

        {/* Action buttons */}
        {checkoutState === 'idle' && (
          <button
            onClick={onCheckout}
            className="flex items-center justify-center gap-2 w-full rounded-xl font-bold transition-all duration-150 active:scale-95"
            style={{ height: 44, fontSize: 13, background: accentColor, color: accentText, boxShadow: `0 4px 20px ${planMeta.glowColor}` }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1.1)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.filter = '' }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14}>
              <path d="M19 19H5V8h14m-3-7v2H8V1H6v2H5c-1.11 0-2 .89-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5a2 2 0 00-2-2h-1V1m-1 11h-5v5h5v-5z" />
            </svg>
            Procéder au paiement
          </button>
        )}

        {(checkoutState === 'timeout' || checkoutState === 'error') && (
          <div className="flex flex-col gap-2">
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="flex items-center justify-center gap-2 w-full rounded-xl font-bold transition-all duration-150 active:scale-95"
              style={{
                height: 40, fontSize: 12,
                background: refreshing ? 'rgba(40,38,65,0.7)' : accentColor,
                color: refreshing ? 'rgba(255,255,255,0.3)' : accentText,
                cursor: refreshing ? 'not-allowed' : 'pointer',
              }}
            >
              {refreshing
                ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.1)', borderTopColor: 'rgba(255,255,255,0.5)' }} />
                : <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12}><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" /></svg>
              }
              {refreshing ? 'Vérification...' : 'Rafraîchir mon plan'}
            </button>
            {checkoutState === 'error' && (
              <button
                onClick={onCheckout}
                className="flex items-center justify-center gap-2 w-full rounded-xl font-semibold transition-all duration-150"
                style={{ height: 36, fontSize: 12, color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                Réessayer
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PlanBadge({ plan }: { plan: string }) {
  if (plan === 'ultimate') {
    return (
      <span
        className="rounded-full px-2 py-0.5"
        style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.15)', letterSpacing: '0.05em' }}
      >
        ULTIMATE
      </span>
    )
  }
  if (plan === 'premium') {
    return (
      <span
        className="rounded-full px-2 py-0.5"
        style={{ fontSize: 10, fontWeight: 700, color: '#818cf8', background: 'rgba(75,63,207,0.2)', letterSpacing: '0.05em' }}
      >
        PREMIUM
      </span>
    )
  }
  return (
    <span
      className="rounded-full px-2 py-0.5"
      style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.07)', letterSpacing: '0.05em' }}
    >
      FREE
    </span>
  )
}

function DevPaymentSimulator({ onSimulate }: { onSimulate: (plan: string) => Promise<void> }) {
  const [simulating, setSimulating] = useState(false)
  const [simMsg, setSimMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const run = async (plan: string) => {
    setSimulating(true)
    setSimMsg(null)
    try {
      await onSimulate(plan)
      setSimMsg({ ok: true, text: `✓ Plan ${plan} activé (simulation)` })
    } catch (e) {
      setSimMsg({ ok: false, text: String(e) })
    } finally {
      setSimulating(false)
      setTimeout(() => setSimMsg(null), 4000)
    }
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl p-5"
      style={{ background: 'rgba(255,200,0,0.04)', border: '1px dashed rgba(255,200,0,0.25)' }}
    >
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,200,0,0.6)', letterSpacing: '0.1em' }}>
          DEV ONLY
        </span>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>
          Simuler un paiement Lemon Squeezy
        </span>
      </div>
      <div className="flex gap-2">
        {['premium', 'ultimate'].map((plan) => (
          <button
            key={plan}
            disabled={simulating}
            onClick={() => run(plan)}
            className="rounded-lg px-3 py-1.5 font-semibold transition-all duration-150 active:scale-95"
            style={{
              fontSize: 11,
              background: plan === 'premium' ? 'rgba(129,140,248,0.12)' : 'rgba(245,158,11,0.12)',
              color: plan === 'premium' ? '#818cf8' : '#f59e0b',
              border: `1px solid ${plan === 'premium' ? 'rgba(129,140,248,0.25)' : 'rgba(245,158,11,0.25)'}`,
              opacity: simulating ? 0.5 : 1,
              cursor: simulating ? 'not-allowed' : 'pointer',
            }}
          >
            {plan}
          </button>
        ))}
        <button
          disabled={simulating}
          onClick={() => run('free')}
          className="rounded-lg px-3 py-1.5 font-semibold transition-all duration-150 active:scale-95"
          style={{
            fontSize: 11,
            background: 'rgba(255,255,255,0.05)',
            color: 'rgba(255,255,255,0.35)',
            border: '1px solid rgba(255,255,255,0.1)',
            opacity: simulating ? 0.5 : 1,
            cursor: simulating ? 'not-allowed' : 'pointer',
          }}
        >
          reset → free
        </button>
      </div>
      {simMsg && (
        <p style={{ fontSize: 11, color: simMsg.ok ? '#4ade80' : '#f87171', fontWeight: 600 }}>
          {simMsg.text}
        </p>
      )}
    </div>
  )
}

function PlanIcon({ plan, color }: { plan: string; color: string }) {
  if (plan === 'ultimate') {
    return (
      <svg viewBox="0 0 20 20" fill={color} width={16} height={16}>
        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
      </svg>
    )
  }
  if (plan === 'premium') {
    return (
      <svg viewBox="0 0 20 20" fill={color} width={16} height={16}>
        <path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm0 14a6 6 0 110-12 6 6 0 010 12zm-1-9h2v4h-2V7zm0 5h2v2h-2v-2z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 20 20" fill={color} width={16} height={16}>
      <path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm1 11H9v-2h2v2zm0-4H9V6h2v3z" />
    </svg>
  )
}
