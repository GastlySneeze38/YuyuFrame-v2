import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { useStore } from '@/stores/useStore'
import type { StatsData } from '@/types'

function loaderColor(loader: string) {
  if (loader === 'fabric') return '#b5a0ff'
  if (loader === 'forge') return '#f0a040'
  return 'rgba(255,255,255,0.4)'
}

function fmtDuration(secs: number): string {
  if (secs < 60) return '< 1 min'
  if (secs < 3600) return `${Math.floor(secs / 60)} min`
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function fmtDate(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

// Generate last N days as YYYY-MM-DD strings
function last14Days(): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (13 - i))
    return d.toISOString().split('T')[0]
  })
}

function dayLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('fr-FR', { weekday: 'short' }).slice(0, 2)
}

export default function Stats() {
  const navigate = useNavigate()
  const { isPremium, yuyuPlan } = useStore()
  const premium = isPremium()
  const planLabel = yuyuPlan === 'ultimate' ? 'ULTIMATE' : 'PREMIUM'
  const planColor = yuyuPlan === 'ultimate' ? { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' } : { color: '#818cf8', bg: 'rgba(75,63,207,0.18)' }

  const [stats, setStats] = useState<StatsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.stats.get()
      .then(setStats)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  const days = last14Days()
  const dailyMap = new Map(stats?.daily.map((d) => [d.date, d.secs]) ?? [])
  const maxDaySecs = Math.max(...days.map((d) => dailyMap.get(d) ?? 0), 1)

  const maxInstanceSecs = Math.max(...(stats?.per_instance.map((i) => i.total_secs) ?? []), 1)

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

        <h1 className="font-black text-white" style={{ fontSize: 16, letterSpacing: '-0.01em' }}>
          Stats & Analytics
        </h1>

        <span style={{ fontSize: 10, fontWeight: 700, color: planColor.color, background: planColor.bg, padding: '2px 8px', borderRadius: 6, letterSpacing: '0.05em' }}>
          {planLabel}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-8 flex flex-col gap-8">

        {/* Premium gate */}
        {!premium ? (
          <PremiumGate onUpgrade={() => navigate('/plans')} />
        ) : loading ? (
          <div className="flex items-center justify-center py-20">
            <span className="h-8 w-8 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.08)', borderTopColor: '#818cf8' }} />
          </div>
        ) : error ? (
          <div className="rounded-2xl px-5 py-4" style={{ background: 'rgba(200,50,50,0.08)', border: '1px solid rgba(200,50,50,0.2)' }}>
            <p style={{ fontSize: 13, color: 'rgb(248,113,113)' }}>{error}</p>
          </div>
        ) : stats && (
          <>
            {/* Top stat cards */}
            <div className="grid grid-cols-3 gap-4">
              <StatCard
                label="Temps de jeu total"
                value={fmtDuration(stats.total_secs)}
                sub={stats.total_sessions === 0 ? 'Aucune session' : `${stats.total_sessions} session${stats.total_sessions > 1 ? 's' : ''}`}
                color="#818cf8"
              />
              <StatCard
                label="Moyenne par session"
                value={stats.total_sessions > 0 ? fmtDuration(Math.round(stats.total_secs / stats.total_sessions)) : '—'}
                sub="Durée moyenne"
                color="#818cf8"
              />
              <StatCard
                label="Modpack favori"
                value={stats.per_instance[0]?.instance_name ?? '—'}
                sub={stats.per_instance[0] ? fmtDuration(stats.per_instance[0].total_secs) : 'Aucune donnée'}
                color="#f59e0b"
              />
            </div>

            {/* 14-day activity */}
            <div className="rounded-2xl p-6 flex flex-col gap-4" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.08em' }}>ACTIVITÉ — 14 DERNIERS JOURS</span>
              <div className="flex items-end gap-1.5" style={{ height: 80 }}>
                {days.map((day) => {
                  const secs = dailyMap.get(day) ?? 0
                  const heightPct = secs > 0 ? Math.max(8, Math.round((secs / maxDaySecs) * 100)) : 0
                  const isToday = day === new Date().toISOString().split('T')[0]
                  return (
                    <div key={day} className="flex flex-1 flex-col items-center gap-1" title={secs > 0 ? `${day}: ${fmtDuration(secs)}` : day}>
                      <div className="w-full flex items-end" style={{ height: 64 }}>
                        <div
                          className="w-full rounded-sm transition-all duration-300"
                          style={{
                            height: `${heightPct}%`,
                            minHeight: secs > 0 ? 4 : 0,
                            background: isToday
                              ? 'linear-gradient(180deg, #818cf8, rgba(75,63,207,0.6))'
                              : secs > 0
                              ? 'rgba(129,140,248,0.45)'
                              : 'rgba(255,255,255,0.04)',
                          }}
                        />
                      </div>
                      <span style={{ fontSize: 8, color: isToday ? '#818cf8' : 'rgba(255,255,255,0.2)', fontWeight: isToday ? 700 : 400 }}>
                        {dayLabel(day)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Bottom two columns */}
            <div className="grid grid-cols-2 gap-5">

              {/* Per-instance breakdown */}
              <div className="rounded-2xl p-6 flex flex-col gap-4" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.08em' }}>PAR MODPACK</span>
                {stats.per_instance.length === 0 ? (
                  <EmptyState label="Aucune session enregistrée" />
                ) : (
                  <div className="flex flex-col gap-4">
                    {stats.per_instance.map((inst) => (
                      <div key={inst.instance_id} className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>{inst.instance_name}</span>
                            <span style={{ fontSize: 9, fontWeight: 700, color: loaderColor(inst.loader) }}>{inst.loader}</span>
                            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)' }}>{inst.mc_version}</span>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 600, color: '#818cf8' }}>{fmtDuration(inst.total_secs)}</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.round((inst.total_secs / maxInstanceSecs) * 100)}%`,
                              background: 'linear-gradient(90deg, rgba(75,63,207,0.8), #818cf8)',
                              transition: 'width 0.4s ease',
                            }}
                          />
                        </div>
                        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>
                          {inst.sessions} session{inst.sessions > 1 ? 's' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Recent sessions */}
              <div className="rounded-2xl p-6 flex flex-col gap-4" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.08em' }}>SESSIONS RÉCENTES</span>
                {stats.recent_sessions.length === 0 ? (
                  <EmptyState label="Aucune session enregistrée" />
                ) : (
                  <div className="flex flex-col gap-2 overflow-auto" style={{ maxHeight: 280 }}>
                    {stats.recent_sessions.map((s, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between rounded-xl px-3 py-2.5"
                        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}
                      >
                        <div className="flex flex-col gap-0.5">
                          <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.75)' }}>{s.instance_name}</span>
                          <div className="flex items-center gap-1.5">
                            <span style={{ fontSize: 9, color: loaderColor(s.loader), fontWeight: 700 }}>{s.loader}</span>
                            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>·</span>
                            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>{fmtDate(s.started_at)} à {fmtTime(s.started_at)}</span>
                          </div>
                        </div>
                        <span
                          className="rounded-lg px-2 py-0.5"
                          style={{ fontSize: 11, fontWeight: 700, color: '#818cf8', background: 'rgba(75,63,207,0.15)', flexShrink: 0 }}
                        >
                          {fmtDuration(s.duration_secs)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          </>
        )}
      </div>
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-2xl p-5"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}
    >
      <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.35)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</span>
      <span className="font-black" style={{ fontSize: 26, color, letterSpacing: '-0.02em', lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{sub}</span>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 gap-2">
      <svg viewBox="0 0 24 24" fill="rgba(255,255,255,0.1)" width={28} height={28}>
        <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z" />
      </svg>
      <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)' }}>{label}</span>
      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.15)' }}>Lance une partie pour commencer</span>
    </div>
  )
}

function PremiumGate({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-6 rounded-2xl py-16 px-8 text-center"
      style={{ background: 'rgba(75,63,207,0.06)', border: '1px solid rgba(75,63,207,0.2)' }}
    >
      <div
        className="flex items-center justify-center rounded-2xl"
        style={{ width: 64, height: 64, background: 'rgba(75,63,207,0.15)', border: '1px solid rgba(129,140,248,0.3)' }}
      >
        <svg viewBox="0 0 24 24" fill="#818cf8" width={28} height={28}>
          <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
        </svg>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="font-black text-white" style={{ fontSize: 22, letterSpacing: '-0.01em' }}>
          Fonctionnalité Premium
        </h2>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', maxWidth: 420, lineHeight: 1.6 }}>
          Les stats & analytics détaillées sont réservées aux abonnés Premium et Ultimate.
        </p>
      </div>

      <div
        className="flex flex-col gap-2 rounded-xl p-4 text-left"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', width: '100%', maxWidth: 360 }}
      >
        {[
          'Temps de jeu total & par modpack',
          'Historique des 20 dernières sessions',
          'Activité sur les 14 derniers jours',
          'Modpack et session favorites',
        ].map((feat) => (
          <div key={feat} className="flex items-center gap-2.5">
            <svg viewBox="0 0 16 16" fill="none" width={14} height={14}>
              <circle cx="8" cy="8" r="7" fill="rgba(75,63,207,0.25)" />
              <path d="M4.5 8l2.5 2.5 4.5-5" stroke="#818cf8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{feat}</span>
          </div>
        ))}
      </div>

      <button
        onClick={onUpgrade}
        className="flex items-center gap-2 rounded-xl font-bold transition-all duration-150 active:scale-95"
        style={{ height: 44, paddingLeft: 28, paddingRight: 28, fontSize: 13, background: '#4B3FCF', color: 'white', boxShadow: '0 4px 20px rgba(75,63,207,0.4)' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#6155e8' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#4B3FCF' }}
      >
        <svg viewBox="0 0 20 20" fill="#f59e0b" width={14} height={14}>
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
        Voir les plans
      </button>
    </div>
  )
}
