import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getName, getVersion, getTauriVersion } from '@tauri-apps/api/app'

interface AppInfo {
  name: string
  version: string
  tauriVersion: string
}

const FEATURES = [
  'Lancer Minecraft avec plusieurs instances indépendantes',
  'Installer et gérer des mods via Modrinth ou en .jar',
  'Authentification Microsoft & gestion de comptes',
  'Téléchargement automatique de Minecraft et des loaders',
]

export default function Information() {
  const navigate = useNavigate()
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    Promise.all([getName(), getVersion(), getTauriVersion()])
      .then(([name, version, tauriVersion]) => setInfo({ name, version, tauriVersion }))
      .catch(() => setInfo({ name: 'YuyuFrame', version: '—', tauriVersion: '—' }))
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: '#09090D', color: 'white' }}>

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
        <h1 className="font-black text-white" style={{ fontSize: 18, letterSpacing: '-0.01em' }}>Informations</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">

          {/* Branding */}
          <div
            className="flex flex-col items-center gap-3 rounded-2xl px-6 py-8 text-center"
            style={{ background: 'rgba(75,63,207,0.08)', border: '1px solid rgba(75,63,207,0.2)' }}
          >
            <div
              className="flex items-center justify-center rounded-2xl font-black text-white"
              style={{ width: 72, height: 72, background: 'rgba(75,63,207,0.25)', fontSize: 32, fontFamily: 'monospace', boxShadow: '0 0 40px rgba(75,63,207,0.3)' }}
            >
              Y
            </div>
            <div>
              <h2 className="font-black text-white" style={{ fontSize: 28, letterSpacing: '-0.02em', textShadow: '0 0 32px rgba(75,63,207,0.5)' }}>
                YuyuFrame
              </h2>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                Le launcher Minecraft open-source
              </p>
            </div>
            {info && (
              <div className="flex items-center gap-2 mt-1">
                <span
                  style={{ fontSize: 12, fontWeight: 700, color: 'rgba(120,110,230,0.9)', background: 'rgba(75,63,207,0.2)', border: '1px solid rgba(75,63,207,0.35)', borderRadius: 8, padding: '3px 10px' }}
                >
                  v{info.version}
                </span>
              </div>
            )}
          </div>

          {/* Version détails */}
          {info && (
            <Section title="Version">
              <InfoRow label="Application" value={`${info.name} v${info.version}`} />
              <InfoRow label="Tauri" value={`v${info.tauriVersion}`} />
              <InfoRow label="Plateforme" value="Windows" />
            </Section>
          )}

          {/* Fonctionnalités */}
          <Section title="Fonctionnalités">
            <div className="flex flex-col gap-2">
              {FEATURES.map((f) => (
                <div
                  key={f}
                  className="flex items-center gap-3 rounded-xl px-4 py-3"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'rgba(75,63,207,0.8)', flexShrink: 0 }} />
                  <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>{f}</span>
                </div>
              ))}
            </div>
          </Section>

          {/* Auteur */}
          <Section title="Développeur">
            <InfoRow label="Auteur" value="Ghasty" />
            <InfoRow label="Licence" value="Open-source" />
            <InfoRow label="Dépôt" value="github.com/Ghasty/YuyuFrame" dim />
          </Section>

          {/* Mentions légales */}
          <Section title="Mentions légales">
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', lineHeight: 1.7 }}>
              YuyuFrame est un launcher non-officiel et n'est pas affilié à Mojang Studios ou Microsoft.
              Minecraft est une marque déposée de Microsoft Corporation.
            </p>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.18)', marginTop: 8 }}>
              © 2025 YuyuFrame — Tous droits réservés
            </p>
          </Section>

        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        {title}
      </h3>
      {children}
    </div>
  )
}

function InfoRow({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div
      className="flex items-center justify-between rounded-xl px-4 py-3"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: dim ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.75)' }}>{value}</span>
    </div>
  )
}
