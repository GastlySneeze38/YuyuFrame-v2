import { useNavigate } from 'react-router-dom'
import { useStore } from '@/stores/useStore'

export default function Settings() {
  const navigate = useNavigate()
  const { brightness, setBrightness, defaultRam, setDefaultRam, closeOnLaunch, setCloseOnLaunch, instanceSyncMode, setInstanceSyncMode } = useStore()

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
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'rgba(255,255,255,0.7)'
            e.currentTarget.style.background = 'rgba(255,255,255,0.08)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'rgba(255,255,255,0.35)'
            e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
          }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 15, height: 15 }}>
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
        </button>

        <div style={{ width: 1, height: 28, background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

        <div>
          <h1 className="font-black text-white" style={{ fontSize: 16, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
            Paramètres
          </h1>
          <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 1 }}>
            Configuration de YuyuFrame
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">

          {/* Launcher */}
          <SCard
            title="Launcher"
            icon={
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                <path d="M8 5v14l11-7z" />
              </svg>
            }
          >
            <div className="flex flex-col gap-6">
              {/* RAM par défaut */}
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">RAM par défaut</p>
                    <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                      Valeur pré-sélectionnée à la création d'une instance
                    </p>
                  </div>
                  <span className="text-sm font-bold" style={{ color: '#7b72e9' }}>
                    {defaultRam >= 1024 ? `${(defaultRam / 1024).toFixed(defaultRam % 1024 === 0 ? 0 : 1)} Go` : `${defaultRam} Mo`}
                  </span>
                </div>
                <input
                  type="range"
                  min={1024} max={16384} step={512}
                  value={defaultRam}
                  onChange={(e) => setDefaultRam(Number(e.target.value))}
                  className="w-full"
                  style={{ accentColor: '#4B3FCF' }}
                />
                <div className="flex justify-between" style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>
                  <span>1 Go</span><span>4 Go</span><span>8 Go</span><span>12 Go</span><span>16 Go</span>
                </div>
              </div>

              <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

              {/* Fermer au lancement */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">Masquer au lancement</p>
                  <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                    Cache le launcher pendant que le jeu tourne
                  </p>
                </div>
                <button
                  onClick={() => setCloseOnLaunch(!closeOnLaunch)}
                  className="relative flex-shrink-0 rounded-full transition-all duration-200"
                  style={{
                    width: 44, height: 24,
                    background: closeOnLaunch ? 'rgba(75,63,207,0.8)' : 'rgba(255,255,255,0.1)',
                    border: `1px solid ${closeOnLaunch ? 'rgba(75,63,207,1)' : 'rgba(255,255,255,0.15)'}`,
                  }}
                >
                  <span
                    className="absolute top-0.5 rounded-full bg-white transition-all duration-200"
                    style={{
                      width: 18, height: 18,
                      left: closeOnLaunch ? 22 : 2,
                    }}
                  />
                </button>
              </div>

              <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

              {/* Sync instances au démarrage */}
              <div className="flex flex-col gap-3">
                <div>
                  <p className="text-sm font-medium text-white">Sync instances au démarrage</p>
                  <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                    Que faire si des dossiers d'instances ne correspondent pas à la DB
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { value: 'db_wins', label: 'Supprimer', desc: 'Efface les dossiers sans entrée en DB' },
                    { value: 'disk_wins', label: 'Importer', desc: 'Ajoute en DB les dossiers détectés' },
                  ] as const).map(({ value, label, desc }) => {
                    const active = instanceSyncMode === value
                    return (
                      <button
                        key={value}
                        onClick={() => setInstanceSyncMode(value)}
                        className="flex flex-col gap-1 rounded-xl p-3 text-left transition-all duration-150"
                        style={{
                          background: active ? 'rgba(75,63,207,0.2)' : 'rgba(255,255,255,0.03)',
                          border: `1px solid ${active ? 'rgba(75,63,207,0.55)' : 'rgba(255,255,255,0.07)'}`,
                        }}
                      >
                        <span className="font-semibold text-white" style={{ fontSize: 12 }}>{label}</span>
                        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', lineHeight: 1.4 }}>{desc}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </SCard>

          {/* Apparence */}
          <SCard
            title="Apparence"
            icon={
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z" />
              </svg>
            }
          >
            <div className="flex flex-col gap-6">
              {/* Mode d'affichage */}
              <div className="flex flex-col gap-3">
                <p className="text-sm font-medium text-white">Mode d'affichage</p>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { id: 'oled', label: 'OLED', desc: 'Luminosité standard', value: 100, icon: '◑' },
                    { id: 'dark', label: 'Dark', desc: 'Luminosité boostée', value: 200, icon: '☀' },
                  ] as const).map(({ id, label, desc, value, icon }) => {
                    const active = brightness === value
                    return (
                      <button
                        key={id}
                        onClick={() => setBrightness(value)}
                        className="flex flex-col gap-1 rounded-xl p-4 text-left transition-all duration-150"
                        style={{
                          background: active ? 'rgba(75,63,207,0.2)' : 'rgba(255,255,255,0.03)',
                          border: `1px solid ${active ? 'rgba(75,63,207,0.55)' : 'rgba(255,255,255,0.07)'}`,
                        }}
                      >
                        <span style={{ fontSize: 18, lineHeight: 1 }}>{icon}</span>
                        <span className="font-semibold text-white" style={{ fontSize: 13 }}>{label}</span>
                        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>{desc}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

              {/* Luminosité */}
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">Luminosité</p>
                    <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                      Ajuste finement la luminosité de l'interface
                    </p>
                  </div>
                  <span className="text-sm font-bold" style={{ color: '#7b72e9' }}>
                    {brightness}%
                  </span>
                </div>
                <input
                  type="range"
                  min={40} max={200} step={5}
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                  className="w-full"
                  style={{ accentColor: '#4B3FCF' }}
                />
                <div className="flex justify-between" style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>
                  <span>Sombre</span>
                  <span>OLED</span>
                  <span>Dark</span>
                </div>
              </div>
            </div>
          </SCard>

          {/* À propos */}
          <SCard
            title="À propos"
            icon={
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
              </svg>
            }
          >
            <div className="flex flex-col gap-3">
              <IRow label="Launcher" value="YuyuFrame v2.0" />
              <IRow label="Stack" value="Tauri · React · Rust" />
              <IRow label="Auteur" value="Ghasty" />
            </div>
          </SCard>

        </div>
      </div>
    </div>
  )
}

function SCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      className="rounded-2xl p-6"
      style={{
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      <div className="mb-5 flex items-center gap-3">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ background: 'rgba(75,63,207,0.2)', color: '#7b72e9' }}
        >
          {icon}
        </div>
        <h2 className="font-bold text-white" style={{ fontSize: 14, letterSpacing: '0.02em' }}>
          {title}
        </h2>
      </div>
      {children}
    </div>
  )
}


function IRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)' }}>{label}</span>
      <span className="font-medium text-white" style={{ fontSize: 13 }}>{value}</span>
    </div>
  )
}
