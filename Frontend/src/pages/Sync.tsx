import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listen } from '@tauri-apps/api/event'
import { api } from '@/api/client'
import { useStore } from '@/stores/useStore'
import type { Instance, SaveInfo, SyncInstance, SyncProgress } from '@/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(ts: number) {
  return new Date(ts * 1000).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`
}

function loaderColor(loader: string) {
  if (loader === 'fabric') return '#b5a0ff'
  if (loader === 'forge') return '#f0a040'
  return 'rgba(255,255,255,0.4)'
}

function timeAgo(ts: number) {
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return 'à l\'instant'
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)}h`
  return `il y a ${Math.floor(diff / 86400)}j`
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ progress }: { progress: SyncProgress }) {
  const color = progress.phase === 'done' ? '#4ade80' : '#4B3FCF'
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>
          {progress.label}
        </span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {progress.percent}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${progress.percent}%`, background: color }}
        />
      </div>
    </div>
  )
}

// ── Cloud content summary ─────────────────────────────────────────────────────

function CloudContentSummary({ cloudEntry }: { cloudEntry: SyncInstance }) {
  const chips = [
    { label: 'mods/', icon: '📦' },
    { label: 'config/', icon: '⚙️' },
    ...cloudEntry.save_names.map((n) => ({ label: n, icon: '💾' })),
  ]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Contenu dans le cloud
        </span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>
          {formatDate(cloudEntry.updated_at)}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <div
            key={chip.label}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <span style={{ fontSize: 11 }}>{chip.icon}</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', fontWeight: 500 }}>{chip.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Save selector ─────────────────────────────────────────────────────────────

function SaveSelector({
  saves,
  selected,
  maxSaves,
  disabled,
  onToggle,
  onSelectAll,
}: {
  saves: SaveInfo[]
  selected: Set<string>
  maxSaves: number
  disabled: boolean
  onToggle: (name: string) => void
  onSelectAll: () => void
}) {
  if (saves.length === 0) {
    return (
      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.22)' }}>
        Aucune save — mods/ et config/ seront synchronisés
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Saves à inclure
        </span>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 10, color: selected.size >= maxSaves ? 'rgba(255,180,0,0.7)' : 'rgba(255,255,255,0.2)' }}>
            {selected.size}/{maxSaves}
          </span>
          {saves.length > 1 && (
            <button
              onClick={onSelectAll}
              disabled={disabled}
              style={{ fontSize: 10, color: 'rgba(75,63,207,0.8)', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' }}
              onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.color = '#818cf8' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(75,63,207,0.8)' }}
            >
              {selected.size === Math.min(saves.length, maxSaves) ? 'Tout désélectionner' : 'Tout sélectionner'}
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        {saves.map((save) => {
          const isSelected = selected.has(save.name)
          const limitReached = !isSelected && selected.size >= maxSaves
          const isInCloud = false // could be extended later
          return (
            <button
              key={save.name}
              onClick={() => onToggle(save.name)}
              disabled={limitReached || disabled}
              className="flex items-center gap-2.5 w-full rounded-xl px-3 py-2 text-left transition-all duration-150"
              style={{
                background: isSelected ? 'rgba(75,63,207,0.14)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${isSelected ? 'rgba(75,63,207,0.32)' : 'rgba(255,255,255,0.06)'}`,
                opacity: limitReached ? 0.4 : 1,
                cursor: (limitReached || disabled) ? 'not-allowed' : 'pointer',
              }}
            >
              <div
                className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded"
                style={{
                  background: isSelected ? '#4B3FCF' : 'rgba(255,255,255,0.06)',
                  border: `1.5px solid ${isSelected ? '#4B3FCF' : 'rgba(255,255,255,0.14)'}`,
                }}
              >
                {isSelected && (
                  <svg viewBox="0 0 12 10" fill="white" width={8} height={6}>
                    <path d="M1 5l3.5 3.5L11 1" stroke="white" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate" style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>
                  {save.name}
                </p>
                <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 1 }}>
                  {formatDate(save.updated_at)} · {formatBytes(save.size_bytes)}
                </p>
              </div>
              {isInCloud && (
                <span style={{ fontSize: 9, color: 'rgba(74,222,128,0.6)', fontWeight: 700, letterSpacing: '0.05em', flexShrink: 0 }}>CLOUD</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Instance sync card ────────────────────────────────────────────────────────

interface InstanceSyncCardProps {
  instance: Instance
  cloudEntry: SyncInstance | undefined
  maxSaves: number
  onCloudUpdate: (updated: SyncInstance) => void
  onCloudDelete: (id: number) => void
}

function InstanceSyncCard({
  instance, cloudEntry, maxSaves, onCloudUpdate, onCloudDelete,
}: InstanceSyncCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [saves, setSaves] = useState<SaveInfo[]>([])
  const [selectedSaves, setSelectedSaves] = useState<Set<string>>(new Set())
  const [savesLoaded, setSavesLoaded] = useState(false)
  const [savesLoading, setSavesLoading] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const unlistenRef = useRef<(() => void) | null>(null)

  const busy = pushing || pulling || deleting
  const hasSynced = !!cloudEntry?.has_data

  // Load saves when first expanded
  useEffect(() => {
    if (!expanded || savesLoaded) return
    setSavesLoading(true)
    api.sync.listSaves(instance.id)
      .then((list) => {
        setSaves(list)
        setSavesLoaded(true)
        // Pre-select saves already in cloud, or the most recent ones
        const inCloud = new Set(cloudEntry?.save_names ?? [])
        const toSelect = list
          .filter((s) => inCloud.has(s.name))
          .map((s) => s.name)
        const auto = toSelect.length > 0
          ? toSelect.slice(0, maxSaves)
          : list.slice(0, maxSaves).map((s) => s.name)
        setSelectedSaves(new Set(auto))
      })
      .catch(() => setSavesLoaded(true))
      .finally(() => setSavesLoading(false))
  }, [expanded])

  const toggleSave = (name: string) => {
    setSelectedSaves((prev) => {
      const next = new Set(prev)
      if (next.has(name)) { next.delete(name) }
      else if (next.size < maxSaves) { next.add(name) }
      return next
    })
  }

  const handleSelectAll = () => {
    if (selectedSaves.size === Math.min(saves.length, maxSaves)) {
      setSelectedSaves(new Set())
    } else {
      setSelectedSaves(new Set(saves.slice(0, maxSaves).map((s) => s.name)))
    }
  }

  const flash = (msg: string) => {
    setSuccess(msg)
    setTimeout(() => setSuccess(''), 3500)
  }

  const handlePush = async () => {
    setPushing(true)
    setError('')
    setProgress({ phase: 'resolving_mods', percent: 0, label: 'Démarrage...' })

    const unlisten = await listen<SyncProgress>('sync_progress', (ev) => {
      setProgress(ev.payload)
    })
    unlistenRef.current = unlisten

    try {
      const updated = await api.sync.push(instance.id, Array.from(selectedSaves))
      onCloudUpdate(updated)
      flash('Sauvegardé dans le cloud !')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      unlisten()
      unlistenRef.current = null
      setTimeout(() => setProgress(null), 1200)
      setPushing(false)
    }
  }

  const handlePull = async () => {
    if (!cloudEntry) return
    setPulling(true)
    setError('')
    setProgress({ phase: 'downloading', percent: 0, label: 'Démarrage de la restauration...' })

    const unlisten = await listen<SyncProgress>('sync_progress', (ev) => {
      setProgress(ev.payload)
    })
    unlistenRef.current = unlisten

    try {
      await api.sync.pull(cloudEntry.id, instance.id)
      flash('Données restaurées !')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      unlisten()
      unlistenRef.current = null
      setTimeout(() => setProgress(null), 1200)
      setPulling(false)
    }
  }

  const handleDelete = async () => {
    if (!cloudEntry) return
    setDeleting(true)
    setError('')
    try {
      await api.sync.delete(cloudEntry.id)
      onCloudDelete(cloudEntry.id)
      setExpanded(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div
      className="rounded-2xl overflow-hidden transition-all duration-200"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${expanded ? 'rgba(75,63,207,0.35)' : 'rgba(255,255,255,0.07)'}`,
      }}
    >
      {/* ── Header row ── */}
      <button
        className="flex items-center gap-3 w-full px-4 py-3 text-left"
        onClick={() => { if (!busy) setExpanded((v) => !v) }}
        disabled={busy}
        style={{ cursor: busy ? 'not-allowed' : 'pointer' }}
      >
        <div
          className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{ width: 36, height: 36, background: hasSynced ? 'rgba(75,63,207,0.12)' : 'rgba(255,255,255,0.05)', fontSize: 15 }}
        >
          🧱
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-bold truncate" style={{ fontSize: 13, color: 'rgba(255,255,255,0.88)' }}>
              {instance.name}
            </p>
            <span style={{
              fontSize: 10, fontWeight: 700,
              color: loaderColor(instance.loader),
              background: 'rgba(255,255,255,0.05)',
              padding: '1px 6px', borderRadius: 4, flexShrink: 0,
            }}>
              {instance.mc_version}
            </span>
          </div>
          <p style={{ fontSize: 11, marginTop: 2 }}>
            {hasSynced
              ? <span style={{ color: 'rgba(74,222,128,0.7)' }}>
                  ✓ Sauvegardé {timeAgo(cloudEntry!.updated_at)}
                  {cloudEntry!.save_names.length > 0 && (
                    <span style={{ color: 'rgba(255,255,255,0.2)', marginLeft: 6 }}>
                      · {cloudEntry!.save_names.length} save{cloudEntry!.save_names.length > 1 ? 's' : ''}
                    </span>
                  )}
                </span>
              : <span style={{ color: 'rgba(255,255,255,0.22)' }}>Jamais sauvegardé</span>
            }
          </p>
        </div>

        {/* Chevron */}
        <div
          className="flex items-center justify-center flex-shrink-0 rounded-lg transition-all duration-200"
          style={{
            width: 28, height: 28,
            background: expanded ? 'rgba(75,63,207,0.2)' : 'rgba(255,255,255,0.04)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width={13} height={13} style={{ color: expanded ? 'rgba(180,170,255,0.8)' : 'rgba(255,255,255,0.3)' }}>
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </div>
      </button>

      {/* ── Expanded panel ── */}
      {expanded && (
        <div
          className="flex flex-col gap-4 px-4 pb-4"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 16 }}
        >
          {/* Cloud content */}
          {hasSynced && cloudEntry && (
            <>
              <CloudContentSummary cloudEntry={cloudEntry} />
              <div className="h-px" style={{ background: 'rgba(255,255,255,0.05)' }} />
            </>
          )}

          {/* Save selector */}
          {savesLoading ? (
            <div className="flex items-center gap-2 py-1">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.08)', borderTopColor: 'rgba(75,63,207,0.8)' }} />
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)' }}>Chargement des saves...</span>
            </div>
          ) : (
            <SaveSelector
              saves={saves}
              selected={selectedSaves}
              maxSaves={maxSaves}
              disabled={pushing}
              onToggle={toggleSave}
              onSelectAll={handleSelectAll}
            />
          )}

          {/* Progress */}
          {progress && (
            <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(75,63,207,0.08)', border: '1px solid rgba(75,63,207,0.2)' }}>
              <ProgressBar progress={progress} />
            </div>
          )}

          {/* Error */}
          {error && <p style={{ fontSize: 12, color: 'rgb(248,113,113)' }}>{error}</p>}

          {/* Action buttons */}
          <div className="flex gap-2">
            {/* Restore */}
            {hasSynced && (
              <button
                onClick={handlePull}
                disabled={busy}
                className="flex items-center justify-center gap-1.5 font-semibold transition-all duration-150"
                style={{
                  flex: 1, height: 38, borderRadius: 10, fontSize: 12,
                  background: 'rgba(255,255,255,0.05)',
                  color: busy ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.55)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
                onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = 'rgba(255,255,255,0.09)' }}
                onMouseLeave={(e) => { if (!busy) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
              >
                {pulling
                  ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
                  : <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12} style={{ transform: 'rotate(180deg)', flexShrink: 0 }}><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" /></svg>
                }
                Restaurer
              </button>
            )}

            {/* Push */}
            <button
              onClick={handlePush}
              disabled={pushing || savesLoading}
              className="flex items-center justify-center gap-1.5 font-bold text-white transition-all duration-150 active:scale-95"
              style={{
                flex: hasSynced ? 2 : 1, height: 38, borderRadius: 10, fontSize: 12,
                background: (pushing || savesLoading) ? 'rgba(40,38,65,0.7)' : '#4B3FCF',
                boxShadow: (pushing || savesLoading) ? 'none' : '0 4px 16px rgba(75,63,207,0.28)',
                cursor: (pushing || savesLoading) ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={(e) => { if (!pushing && !savesLoading) e.currentTarget.style.background = '#6155e8' }}
              onMouseLeave={(e) => { if (!pushing && !savesLoading) e.currentTarget.style.background = '#4B3FCF' }}
            >
              {pushing
                ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
                : <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12} style={{ flexShrink: 0 }}><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" /></svg>
              }
              {pushing
                ? 'Sauvegarde...'
                : hasSynced
                  ? `Mettre à jour${selectedSaves.size > 0 ? ` (${selectedSaves.size} save${selectedSaves.size > 1 ? 's' : ''})` : ''}`
                  : `Sauvegarder${selectedSaves.size > 0 ? ` (${selectedSaves.size} save${selectedSaves.size > 1 ? 's' : ''})` : ''}`
              }
            </button>

            {/* Delete cloud */}
            {cloudEntry && (
              <button
                onClick={handleDelete}
                disabled={busy}
                title="Supprimer la sauvegarde cloud"
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl transition-all duration-150"
                style={{ color: 'rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.04)', cursor: busy ? 'not-allowed' : 'pointer' }}
                onMouseEnter={(e) => { if (!busy) { e.currentTarget.style.color = 'rgb(248,113,113)'; e.currentTarget.style.background = 'rgba(200,50,50,0.12)' } }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.18)'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
              >
                {deleting
                  ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.15)', borderTopColor: 'rgb(248,113,113)' }} />
                  : <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14}><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>
                }
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Success toast ── */}
      {success && (
        <div
          className="flex items-center gap-2 px-4 py-2"
          style={{ borderTop: '1px solid rgba(74,222,128,0.12)', background: 'rgba(74,222,128,0.05)' }}
        >
          <svg viewBox="0 0 24 24" fill="rgb(74,222,128)" width={12} height={12}>
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
          </svg>
          <p style={{ fontSize: 11, color: 'rgb(74,222,128)', fontWeight: 600 }}>{success}</p>
        </div>
      )}
    </div>
  )
}

// ── Orphan cloud card ─────────────────────────────────────────────────────────

function OrphanCloudCard({ ci, onRestore, onDelete }: {
  ci: SyncInstance
  onRestore: (ci: SyncInstance) => Promise<void>
  onDelete: (id: number) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const busy = restoring || deleting

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <button
        className="flex items-center gap-3 w-full px-4 py-3 text-left"
        onClick={() => setExpanded((v) => !v)}
        style={{ cursor: 'pointer' }}
      >
        <div
          className="flex items-center justify-center rounded-xl flex-shrink-0"
          style={{ width: 36, height: 36, background: 'rgba(255,255,255,0.04)', fontSize: 15, opacity: 0.7 }}
        >
          ☁️
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate" style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
            {ci.instance_name}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <span style={{ fontSize: 11, color: loaderColor(ci.loader), fontWeight: 600 }}>{ci.loader}</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)' }}>{ci.mc_version}</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.15)' }}>{formatDate(ci.updated_at)}</span>
          </div>
        </div>
        <div
          className="flex items-center justify-center flex-shrink-0 rounded-lg transition-all duration-200"
          style={{
            width: 28, height: 28,
            background: 'rgba(255,255,255,0.04)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          <svg viewBox="0 0 24 24" fill="rgba(255,255,255,0.25)" width={13} height={13}>
            <path d="M7 10l5 5 5-5z" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div
          className="flex flex-col gap-3 px-4 pb-4"
          style={{ borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 14 }}
        >
          <CloudContentSummary cloudEntry={ci} />

          <div className="flex gap-2">
            {ci.has_data && (
              <button
                onClick={async () => { setRestoring(true); await onRestore(ci); setRestoring(false) }}
                disabled={busy}
                className="flex items-center justify-center gap-1.5 font-semibold transition-all duration-150"
                style={{
                  flex: 2, height: 36, borderRadius: 10, fontSize: 12,
                  background: 'rgba(74,222,128,0.1)',
                  color: busy ? 'rgba(255,255,255,0.2)' : 'rgba(74,222,128,0.85)',
                  border: '1px solid rgba(74,222,128,0.18)',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
                onMouseEnter={(e) => { if (!busy) e.currentTarget.style.background = 'rgba(74,222,128,0.18)' }}
                onMouseLeave={(e) => { if (!busy) e.currentTarget.style.background = 'rgba(74,222,128,0.1)' }}
              >
                {restoring
                  ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
                  : <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12} style={{ transform: 'rotate(180deg)', flexShrink: 0 }}><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" /></svg>
                }
                Télécharger l'instance
              </button>
            )}
            <button
              onClick={async () => { setDeleting(true); await onDelete(ci.id); setDeleting(false) }}
              disabled={busy}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl transition-all duration-150"
              style={{ color: 'rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.04)', cursor: busy ? 'not-allowed' : 'pointer' }}
              onMouseEnter={(e) => { if (!busy) { e.currentTarget.style.color = 'rgb(248,113,113)'; e.currentTarget.style.background = 'rgba(200,50,50,0.12)' } }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.18)'; e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
            >
              {deleting
                ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.15)', borderTopColor: 'rgb(248,113,113)' }} />
                : <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14}><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" /></svg>
              }
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sync content ──────────────────────────────────────────────────────────────

function SyncContent() {
  const { instances, yuyuToken, isUltimate, addInstance } = useStore()
  const userIsUltimate = isUltimate()
  const QUOTA_SAVES = userIsUltimate ? 10 : 3

  const [cloudInstances, setCloudInstances] = useState<SyncInstance[]>([])
  const [cloudLoading, setCloudLoading] = useState(false)
  const [error, setError] = useState('')
  const cloudLoaded = useRef(false)

  useEffect(() => {
    if (!yuyuToken || cloudLoaded.current) return
    cloudLoaded.current = true
    setCloudLoading(true)
    api.sync.list()
      .then(setCloudInstances)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setCloudLoading(false))
  }, [yuyuToken])

  const totalCloudSaves = cloudInstances.reduce((sum, ci) => sum + ci.save_count, 0)

  const maxSavesForInstance = (inst: Instance) => {
    const cloudEntry = cloudInstances.find((ci) => ci.instance_name === inst.name)
    const ownedSaves = cloudEntry?.save_count ?? 0
    return Math.max(0, Math.min(QUOTA_SAVES, QUOTA_SAVES - totalCloudSaves + ownedSaves))
  }

  const handleCloudUpdate = (updated: SyncInstance) => {
    setCloudInstances((prev) => {
      const idx = prev.findIndex((ci) => ci.id === updated.id)
      return idx >= 0
        ? prev.map((ci, i) => (i === idx ? updated : ci))
        : [updated, ...prev]
    })
  }

  const handleCloudDelete = (id: number) => {
    setCloudInstances((prev) => prev.filter((ci) => ci.id !== id))
  }

  const handleRestore = async (ci: SyncInstance) => {
    try {
      const newInstance = await api.instances.create(ci.instance_name, ci.mc_version, ci.loader, ci.ram_mb)
      addInstance(newInstance)
      await api.sync.pull(ci.id, newInstance.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const orphanCloud = cloudInstances.filter(
    (ci) => !instances.some((i) => i.name === ci.instance_name)
  )

  if (cloudLoading) {
    return (
      <div className="flex justify-center py-8">
        <span className="h-5 w-5 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.08)', borderTopColor: 'rgba(75,63,207,0.8)' }} />
      </div>
    )
  }

  if (instances.length === 0 && orphanCloud.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8">
        <div style={{ fontSize: 24, opacity: 0.18 }}>🧱</div>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.2)', textAlign: 'center' }}>
          Crée une instance pour commencer<br />à synchroniser.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <p style={{ fontSize: 12, color: 'rgb(248,113,113)', paddingBottom: 4 }}>{error}</p>}

      {/* Local instances */}
      {instances.map((inst) => (
        <InstanceSyncCard
          key={inst.id}
          instance={inst}
          cloudEntry={cloudInstances.find((ci) => ci.instance_name === inst.name)}
          maxSaves={maxSavesForInstance(inst)}
          onCloudUpdate={handleCloudUpdate}
          onCloudDelete={handleCloudDelete}
        />
      ))}

      {/* Orphan cloud entries */}
      {orphanCloud.length > 0 && (
        <div className="flex flex-col gap-2 mt-2">
          <p style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Dans le cloud · sans instance locale
          </p>
          {orphanCloud.map((ci) => (
            <OrphanCloudCard
              key={ci.id}
              ci={ci}
              onRestore={handleRestore}
              onDelete={async (id) => handleCloudDelete(id)}
            />
          ))}
        </div>
      )}

      <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.1)', textAlign: 'center', marginTop: 4 }}>
        mods/ + config/ + saves sélectionnées · {QUOTA_SAVES} saves max · Premium
      </p>
    </div>
  )
}

// ── Premium gate ──────────────────────────────────────────────────────────────

function SyncPremiumGate() {
  const navigate = useNavigate()
  return (
    <div
      className="flex flex-col items-center gap-6 rounded-2xl py-12 px-8 text-center"
      style={{ background: 'rgba(75,63,207,0.06)', border: '1px solid rgba(75,63,207,0.2)' }}
    >
      <div
        className="flex items-center justify-center rounded-2xl"
        style={{ width: 56, height: 56, background: 'rgba(75,63,207,0.15)', border: '1px solid rgba(129,140,248,0.3)' }}
      >
        <svg viewBox="0 0 24 24" fill="#818cf8" width={24} height={24}>
          <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
        </svg>
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="font-black text-white" style={{ fontSize: 18, letterSpacing: '-0.01em' }}>
          Fonctionnalité Premium
        </h2>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', maxWidth: 360, lineHeight: 1.6 }}>
          La synchronisation multi-PC est réservée aux abonnés Premium et Ultimate.
        </p>
      </div>
      <div
        className="flex flex-col gap-2 rounded-xl p-4 text-left"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', width: '100%', maxWidth: 320 }}
      >
        {[
          'Sync mods, configs & saves entre tes PCs',
          'Jusqu\'à 3 saves cloud (10 en Ultimate)',
          'Détail de ce qui est sauvegardé par instance',
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
        onClick={() => navigate('/plans')}
        className="flex items-center gap-2 rounded-xl font-bold transition-all duration-150 active:scale-95"
        style={{ height: 40, paddingLeft: 24, paddingRight: 24, fontSize: 13, background: '#4B3FCF', color: 'white', boxShadow: '0 4px 20px rgba(75,63,207,0.4)' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#6155e8' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#4B3FCF' }}
      >
        <svg viewBox="0 0 20 20" fill="#f59e0b" width={13} height={13}>
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
        Voir les plans
      </button>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Sync() {
  const navigate = useNavigate()
  const { yuyuToken, isPremium, yuyuPlan } = useStore()

  const planLabel = yuyuPlan === 'ultimate' ? 'ULTIMATE' : 'PREMIUM'
  const planColor = yuyuPlan === 'ultimate'
    ? { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' }
    : { color: '#818cf8', bg: 'rgba(75,63,207,0.18)' }

  return (
    <div className="flex h-full flex-col" style={{ background: '#09090D', color: 'white' }}>
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
        <h1 className="font-black text-white" style={{ fontSize: 16, letterSpacing: '-0.01em' }}>
          Synchronisation
        </h1>
        {yuyuToken && isPremium() && (
          <span style={{ fontSize: 10, fontWeight: 700, color: planColor.color, background: planColor.bg, padding: '2px 8px', borderRadius: 6, letterSpacing: '0.05em' }}>
            {planLabel}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {!yuyuToken ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10">
            <div style={{ fontSize: 28, opacity: 0.2 }}>🔒</div>
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', fontWeight: 600, textAlign: 'center' }}>
              Connecte-toi à YuyuFrame<br />pour synchroniser tes instances
            </p>
          </div>
        ) : !isPremium() ? (
          <SyncPremiumGate />
        ) : (
          <SyncContent />
        )}
      </div>
    </div>
  )
}
