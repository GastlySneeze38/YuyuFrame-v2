import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { useStore } from '@/stores/useStore'
import type { Instance, Loader } from '@/types'
import { ModsContent, updateModsForNewVersion } from '@/pages/Mods'

const LOADERS: Loader[] = ['vanilla', 'fabric', 'forge']
const RAM_OPTIONS = [1024, 2048, 4096, 6144, 8192]

function formatRam(mb: number) {
  return mb >= 1024 ? `${mb / 1024} Go` : `${mb} Mo`
}

function loaderColor(loader: string) {
  if (loader === 'fabric') return '#b5a0ff'
  if (loader === 'forge') return '#f0a040'
  return 'rgba(255,255,255,0.4)'
}

// ── Shared field components ───────────────────────────────────────────────────

function NameInput({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter?: () => void }) {
  return (
    <input
      type="text"
      placeholder="Nom de l'instance..."
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
      className="w-full rounded-xl px-3 text-sm text-white outline-none"
      style={{ height: 40, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)' }}
      onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(75,63,207,0.6)' }}
      onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)' }}
      autoFocus
    />
  )
}

function RamPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600 }}>RAM</label>
      <div className="flex gap-1.5 mt-1">
        {RAM_OPTIONS.map((r) => (
          <button
            key={r}
            onClick={() => onChange(r)}
            className="rounded-xl text-xs font-semibold transition-all duration-150"
            style={{
              height: 34, padding: '0 10px',
              background: value === r ? 'rgba(75,63,207,0.35)' : 'rgba(0,0,0,0.35)',
              border: `1px solid ${value === r ? 'rgba(75,63,207,0.7)' : 'rgba(255,255,255,0.08)'}`,
              color: value === r ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
            }}
          >
            {formatRam(r)}
          </button>
        ))}
      </div>
    </div>
  )
}

function SubmitButton({ loading, label, loadingLabel, onClick }: { loading: boolean; label: string; loadingLabel: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="w-full font-bold text-white transition-all duration-200 active:scale-95"
      style={{
        height: 42, borderRadius: 12, fontSize: 13,
        background: loading ? 'rgba(40,38,65,0.7)' : '#4B3FCF',
        boxShadow: loading ? 'none' : '0 4px 20px rgba(75,63,207,0.35)',
        cursor: loading ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={(e) => { if (!loading) e.currentTarget.style.background = '#6155e8' }}
      onMouseLeave={(e) => { if (!loading) e.currentTarget.style.background = '#4B3FCF' }}
    >
      {loading ? loadingLabel : label}
    </button>
  )
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-6 flex flex-col gap-5"
        style={{ background: '#111118', border: '1px solid rgba(75,63,207,0.3)', boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}
      >
        <div className="flex items-center justify-between">
          <p className="font-bold text-white" style={{ fontSize: 15 }}>{title}</p>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg transition-all duration-150"
            style={{ color: 'rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.05)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.7)'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.3)'; e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14}>
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Create modal ──────────────────────────────────────────────────────────────

function CreateModal({
  versions,
  defaultRam,
  onClose,
  onCreate,
}: {
  versions: string[]
  defaultRam: number
  onClose: () => void
  onCreate: (instance: Instance) => void
}) {
  const [name, setName] = useState('')
  const [mcVersion, setMcVersion] = useState(versions[0] ?? '')
  const [loader, setLoader] = useState<Loader>('vanilla')
  const [ram, setRam] = useState(defaultRam)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (versions.length > 0 && !mcVersion) setMcVersion(versions[0])
  }, [versions])

  const handleCreate = async () => {
    if (!name.trim()) { setError('Nom requis'); return }
    if (!mcVersion) { setError('Sélectionne une version'); return }
    setLoading(true); setError('')
    try {
      const instance = await api.instances.create(name.trim(), mcVersion, loader, ram)
      onCreate(instance)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalShell title="Nouvelle instance" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <NameInput value={name} onChange={setName} onEnter={handleCreate} />

        <div className="flex gap-3">
          <div className="flex-1">
            <label style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600 }}>Version MC</label>
            <div className="relative mt-1">
              <select
                value={mcVersion}
                onChange={(e) => setMcVersion(e.target.value)}
                className="w-full appearance-none rounded-xl px-3 pr-7 text-sm font-medium text-white outline-none"
                style={{ height: 40, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                {versions.map((v) => (
                  <option key={v} value={v} style={{ background: '#111118' }}>{v}</option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                <svg viewBox="0 0 10 6" fill="white" width={10} height={6} style={{ opacity: 0.4 }}>
                  <path d="M0 0l5 6 5-6z" />
                </svg>
              </div>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600 }}>Loader</label>
            <div className="flex gap-1 mt-1">
              {LOADERS.map((l) => (
                <button
                  key={l}
                  onClick={() => setLoader(l)}
                  className="rounded-xl text-xs font-semibold transition-all duration-150"
                  style={{
                    height: 40, padding: '0 12px',
                    background: loader === l ? 'rgba(75,63,207,0.35)' : 'rgba(0,0,0,0.35)',
                    border: `1px solid ${loader === l ? 'rgba(75,63,207,0.7)' : 'rgba(255,255,255,0.08)'}`,
                    color: loader === l ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.35)',
                  }}
                >
                  {l.charAt(0).toUpperCase() + l.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <RamPicker value={ram} onChange={setRam} />

        {error && <p style={{ fontSize: 12, color: 'rgb(248,113,113)' }}>{error}</p>}

        <SubmitButton loading={loading} label="Créer l'instance" loadingLabel="Création..." onClick={handleCreate} />
      </div>
    </ModalShell>
  )
}

// ── Edit modal ────────────────────────────────────────────────────────────────

function EditModal({
  instance,
  versions,
  onClose,
  onUpdate,
}: {
  instance: Instance
  versions: string[]
  onClose: () => void
  onUpdate: (instance: Instance) => void
}) {
  const [name, setName] = useState(instance.name)
  const [mcVersion, setMcVersion] = useState(instance.mc_version)
  const [ram, setRam] = useState(instance.ram_mb)
  const [loading, setLoading] = useState(false)
  const [loadingLabel, setLoadingLabel] = useState('Enregistrement...')
  const [error, setError] = useState('')

  const handleSave = async () => {
    if (!name.trim()) { setError('Nom requis'); return }
    setLoading(true); setError(''); setLoadingLabel('Enregistrement...')
    try {
      const updated = await api.instances.update(instance.id, name.trim(), mcVersion, instance.loader, ram)
      if (mcVersion !== instance.mc_version) {
        setLoadingLabel('Mise à jour des mods...')
        await updateModsForNewVersion(instance.id, mcVersion, instance.loader)
      }
      onUpdate(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalShell title="Modifier l'instance" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <NameInput value={name} onChange={setName} onEnter={handleSave} />

        <div>
          <label style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600 }}>Version MC</label>
          <div className="relative mt-1">
            <select
              value={mcVersion}
              onChange={(e) => setMcVersion(e.target.value)}
              className="w-full appearance-none rounded-xl px-3 pr-7 text-sm font-medium text-white outline-none"
              style={{ height: 40, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              {versions.map((v) => (
                <option key={v} value={v} style={{ background: '#111118' }}>{v}</option>
              ))}
            </select>
            <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
              <svg viewBox="0 0 10 6" fill="white" width={10} height={6} style={{ opacity: 0.4 }}>
                <path d="M0 0l5 6 5-6z" />
              </svg>
            </div>
          </div>
        </div>

        <RamPicker value={ram} onChange={setRam} />

        {mcVersion !== instance.mc_version && (
          <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(75,63,207,0.08)', border: '1px solid rgba(75,63,207,0.25)' }}>
            <svg viewBox="0 0 24 24" fill="currentColor" width={13} height={13} style={{ color: 'rgba(120,110,230,0.7)', flexShrink: 0 }}>
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
            </svg>
            <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
              Les mods compatibles seront mis à jour pour <span style={{ color: 'rgba(120,110,230,0.9)', fontWeight: 600 }}>{mcVersion}</span>.
            </p>
          </div>
        )}

        {error && <p style={{ fontSize: 12, color: 'rgb(248,113,113)' }}>{error}</p>}
        <SubmitButton loading={loading} label="Enregistrer" loadingLabel={loadingLabel} onClick={handleSave} />
      </div>
    </ModalShell>
  )
}

// ── Duplicate modal ───────────────────────────────────────────────────────────

function DuplicateModal({
  source,
  versions,
  onClose,
  onDuplicate,
}: {
  source: Instance
  versions: string[]
  onClose: () => void
  onDuplicate: (instance: Instance) => void
}) {
  const [name, setName] = useState(`Copie de ${source.name}`)
  const [mcVersion, setMcVersion] = useState(source.mc_version)
  const [ram, setRam] = useState(source.ram_mb)
  const [loading, setLoading] = useState(false)
  const [loadingLabel, setLoadingLabel] = useState('Duplication...')
  const [error, setError] = useState('')

  const handleDuplicate = async () => {
    if (!name.trim()) { setError('Nom requis'); return }
    setLoading(true); setError(''); setLoadingLabel('Duplication...')
    try {
      const instance = await api.instances.duplicate(source.id, name.trim(), mcVersion, ram)
      if (mcVersion !== source.mc_version) {
        setLoadingLabel('Mise à jour des mods...')
        await updateModsForNewVersion(instance.id, mcVersion, source.loader)
      }
      onDuplicate(instance)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur')
    } finally {
      setLoading(false)
    }
  }

  return (
    <ModalShell title="Dupliquer l'instance" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <NameInput value={name} onChange={setName} onEnter={handleDuplicate} />

        <div>
          <label style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600 }}>Version MC</label>
          <div className="relative mt-1">
            <select
              value={mcVersion}
              onChange={(e) => setMcVersion(e.target.value)}
              className="w-full appearance-none rounded-xl px-3 pr-7 text-sm font-medium text-white outline-none"
              style={{ height: 40, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              {versions.map((v) => (
                <option key={v} value={v} style={{ background: '#111118' }}>{v}</option>
              ))}
            </select>
            <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
              <svg viewBox="0 0 10 6" fill="white" width={10} height={6} style={{ opacity: 0.4 }}>
                <path d="M0 0l5 6 5-6z" />
              </svg>
            </div>
          </div>
        </div>

        <RamPicker value={ram} onChange={setRam} />

        <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <svg viewBox="0 0 24 24" fill="currentColor" width={13} height={13} style={{ color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
          </svg>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
            Loader <span style={{ color: loaderColor(source.loader), fontWeight: 600 }}>{source.loader}</span> conservé —{' '}
            {mcVersion !== source.mc_version
              ? <>les mods compatibles seront mis à jour pour <span style={{ color: 'rgba(120,110,230,0.9)', fontWeight: 600 }}>{mcVersion}</span>.</>
              : 'les mods seront copiés.'}
          </p>
        </div>

        {error && <p style={{ fontSize: 12, color: 'rgb(248,113,113)' }}>{error}</p>}

        <SubmitButton loading={loading} label="Dupliquer" loadingLabel={loadingLabel} onClick={handleDuplicate} />
      </div>
    </ModalShell>
  )
}

// ── Action pill ───────────────────────────────────────────────────────────────

function ActionPill({ onClick, icon, label, danger }: { onClick: () => void; icon: ReactNode; label: string; danger?: boolean }) {
  const base = danger
    ? { color: 'rgba(248,113,113,0.7)', background: 'transparent' }
    : { color: 'rgba(255,255,255,0.35)', background: 'transparent' }
  const hover = danger
    ? { color: 'rgb(248,113,113)', background: 'rgba(200,50,50,0.15)' }
    : { color: 'rgba(255,255,255,0.85)', background: 'rgba(255,255,255,0.08)' }

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded-lg transition-all duration-150"
      style={{ ...base, fontSize: 11, fontWeight: 600, padding: '3px 8px' }}
      onMouseEnter={(e) => Object.assign(e.currentTarget.style, hover)}
      onMouseLeave={(e) => Object.assign(e.currentTarget.style, base)}
    >
      {icon}
      {label}
    </button>
  )
}

// ── Instance card ─────────────────────────────────────────────────────────────

function InstanceCard({
  instance,
  selected,
  onSelect,
  onToggleFavorite,
  onDelete,
  onEdit,
  onDuplicate,
}: {
  instance: Instance
  selected: boolean
  onSelect: () => void
  onToggleFavorite: () => void
  onDelete: () => void
  onEdit: () => void
  onDuplicate: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onSelect}
      className="flex flex-col rounded-2xl px-4 py-3.5 cursor-pointer transition-all duration-150 overflow-hidden"
      style={{
        background: selected ? 'rgba(75,63,207,0.18)' : hovered ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${selected ? 'rgba(75,63,207,0.55)' : 'rgba(255,255,255,0.06)'}`,
        boxShadow: selected ? '0 0 20px rgba(75,63,207,0.18)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setConfirm(false) }}
    >
      {/* Partie haute : icône + nom + infos */}
      <div className="flex items-center gap-3">
        <div
          className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{ width: 36, height: 36, background: selected ? 'rgba(75,63,207,0.3)' : 'rgba(255,255,255,0.05)', fontSize: 15 }}
        >
          🧱
        </div>

        <div className="flex flex-col flex-1 min-w-0">
          {/* Nom + étoile */}
          <div className="flex items-center gap-1">
            <p className="font-bold truncate flex-1 min-w-0" style={{ fontSize: 13, color: selected ? 'white' : 'rgba(255,255,255,0.85)' }}>
              {instance.name}
            </p>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleFavorite() }}
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg transition-all duration-150"
              title={instance.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
              style={{ color: instance.favorite ? '#facc15' : 'rgba(255,255,255,0.18)', background: 'transparent' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = instance.favorite ? '#fde047' : 'rgba(255,255,255,0.5)' }}
              onMouseLeave={(e) => { e.currentTarget.style.color = instance.favorite ? '#facc15' : 'rgba(255,255,255,0.18)' }}
            >
              <svg viewBox="0 0 24 24" fill={instance.favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={instance.favorite ? 0 : 1.8} width={13} height={13}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
              </svg>
            </button>
          </div>

          {/* Infos */}
          <div className="flex items-center gap-2 mt-0.5">
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{instance.mc_version}</span>
            <span style={{ fontSize: 10, color: loaderColor(instance.loader), fontWeight: 600 }}>{instance.loader}</span>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>{formatRam(instance.ram_mb)}</span>
          </div>
        </div>
      </div>

      {/* Ligne d'actions pleine largeur (hover) */}
      {(hovered || confirm) && (
        <div className="flex items-center justify-center gap-1.5 mt-2.5" onClick={(e) => e.stopPropagation()}>
          {confirm ? (
            <>
              <button onClick={() => onDelete()} style={{ fontSize: 11, fontWeight: 600, color: 'rgb(248,113,113)', background: 'rgba(200,50,50,0.15)', borderRadius: 7, padding: '3px 9px' }}>Supprimer</button>
              <button onClick={() => setConfirm(false)} style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.06)', borderRadius: 7, padding: '3px 9px' }}>Annuler</button>
            </>
          ) : (
            <>
              <ActionPill onClick={onEdit} icon={<svg viewBox="0 0 24 24" fill="currentColor" width={11} height={11}><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" /></svg>} label="Modifier" />
              <ActionPill onClick={onDuplicate} icon={<svg viewBox="0 0 24 24" fill="currentColor" width={11} height={11}><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" /></svg>} label="Dupliquer" />
              <ActionPill onClick={() => setConfirm(true)} icon={<svg viewBox="0 0 24 24" fill="currentColor" width={11} height={11}><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>} label="Supprimer" danger />
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Instances() {
  const navigate = useNavigate()
  const {
    versions, setVersions,
    instances, setInstances, addInstance, updateInstance, removeInstance,
    selectedInstanceId, setSelectedInstanceId,
    defaultRam,
  } = useStore()

  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [editTarget, setEditTarget] = useState<Instance | null>(null)
  const [duplicateSource, setDuplicateSource] = useState<Instance | null>(null)
  const [othersExpanded, setOthersExpanded] = useState(true)
  const loaded = useRef(false)

  const selectedInstance = instances.find((i) => i.id === selectedInstanceId) ?? null
  const favorites = instances.filter((i) => i.favorite)
  const others = instances.filter((i) => !i.favorite)

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true

    Promise.all([
      api.instances.list(),
      versions.length === 0 ? api.versions.list() : Promise.resolve(null),
    ]).then(([insts, vers]) => {
      setInstances(insts)
      if (vers) setVersions(vers)
      if (insts.some((i) => i.favorite)) setOthersExpanded(false)
    }).finally(() => setLoading(false))
  }, [])

  const releaseVersions = versions
    .filter((v) => v.version_type === 'release')
    .map((v) => v.id)

  const handleDelete = async (id: string) => {
    try {
      await api.instances.delete(id)
      removeInstance(id)
    } catch { /* ignore */ }
  }

  const handleToggleFavorite = async (id: string) => {
    try {
      const updated = await api.instances.toggleFavorite(id)
      updateInstance(updated)
    } catch { /* ignore */ }
  }

  function renderCard(inst: Instance) {
    return (
      <InstanceCard
        key={inst.id}
        instance={inst}
        selected={inst.id === selectedInstanceId}
        onSelect={() => setSelectedInstanceId(inst.id)}
        onToggleFavorite={() => handleToggleFavorite(inst.id)}
        onDelete={() => handleDelete(inst.id)}
        onEdit={() => setEditTarget(inst)}
        onDuplicate={() => setDuplicateSource(inst)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col" style={{ background: '#09090D', color: 'white' }}>

      {/* Header */}
      <div
        className="flex flex-shrink-0 items-center gap-3 px-5 py-3"
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

        <h1 className="font-black text-white" style={{ fontSize: 16, letterSpacing: '-0.01em' }}>Instances</h1>
      </div>

      {/* Body: sidebar + mods panel */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left sidebar — instance list */}
        <div
          className="flex flex-col overflow-hidden"
          style={{ width: '22%', minWidth: 320, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.06)' }}
        >
          {/* Scrollable list */}
          <div className="flex flex-1 flex-col overflow-y-auto p-3">
            {loading ? (
              <div className="flex h-40 items-center justify-center">
                <span className="h-7 w-7 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.08)', borderTopColor: 'rgba(75,63,207,0.8)' }} />
              </div>
            ) : instances.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2">
                <div style={{ fontSize: 32 }}>🧱</div>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', fontWeight: 600, textAlign: 'center' }}>Aucune instance</p>
              </div>
            ) : (
              <>
                {favorites.length > 0 && (
                  <div className="mb-1">
                    <p className="px-1 pb-1.5 text-xs font-semibold" style={{ color: '#facc15', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      ★ Favoris
                    </p>
                    <div className="flex flex-col gap-2">
                      {favorites.map(renderCard)}
                    </div>
                  </div>
                )}

                {others.length > 0 && (
                  <div>
                    <button
                      onClick={() => setOthersExpanded((v) => !v)}
                      className="flex w-full items-center gap-1.5 px-1 pb-1.5"
                    >
                      <svg
                        viewBox="0 0 24 24" fill="currentColor" width={10} height={10}
                        style={{ color: 'rgba(255,255,255,0.3)', transition: 'transform 0.15s', transform: othersExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      <p className="text-xs font-semibold" style={{ color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        Autres ({others.length})
                      </p>
                    </button>
                    {othersExpanded && (
                      <div className="flex flex-col gap-2">
                        {others.map(renderCard)}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Fixed bottom button */}
          <div className="flex-shrink-0 p-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <button
              onClick={() => setShowCreate(true)}
              className="w-full flex items-center justify-center gap-2 font-bold text-white transition-all duration-200 active:scale-95"
              style={{ height: 44, borderRadius: 12, fontSize: 13, background: '#4B3FCF', boxShadow: '0 4px 20px rgba(75,63,207,0.3)' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#6155e8' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = '#4B3FCF' }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width={15} height={15}>
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
              </svg>
              Nouvelle instance
            </button>
          </div>
        </div>

        {/* Right panel — mods */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {selectedInstance ? (
            <ModsContent key={`${selectedInstance.id}-${selectedInstance.mc_version}`} instance={selectedInstance} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <div style={{ fontSize: 32, opacity: 0.4 }}>←</div>
              <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.3)', fontWeight: 600 }}>
                Sélectionne une instance
              </p>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.15)' }}>
                Les mods s'afficheront ici
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateModal
          versions={releaseVersions}
          defaultRam={defaultRam}
          onClose={() => setShowCreate(false)}
          onCreate={(inst) => {
            addInstance(inst)
            setSelectedInstanceId(inst.id)
          }}
        />
      )}

      {editTarget && (
        <EditModal
          instance={editTarget}
          versions={releaseVersions}
          onClose={() => setEditTarget(null)}
          onUpdate={(updated) => {
            updateInstance(updated)
            setEditTarget(null)
          }}
        />
      )}

      {duplicateSource && (
        <DuplicateModal
          source={duplicateSource}
          versions={releaseVersions}
          onClose={() => setDuplicateSource(null)}
          onDuplicate={(inst) => {
            addInstance(inst)
            setSelectedInstanceId(inst.id)
            setDuplicateSource(null)
          }}
        />
      )}
    </div>
  )
}
