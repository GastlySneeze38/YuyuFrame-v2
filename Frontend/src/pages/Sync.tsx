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

// ── Save toggle button ────────────────────────────────────────────────────────

function SaveToggle({
  save,
  selected,
  disabled,
  onToggle,
}: {
  save: SaveInfo
  selected: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 text-left transition-all duration-150"
      style={{
        background: selected ? 'rgba(75,63,207,0.18)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${selected ? 'rgba(75,63,207,0.45)' : 'rgba(255,255,255,0.07)'}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled && !selected) e.currentTarget.style.background = 'rgba(255,255,255,0.07)' }}
      onMouseLeave={(e) => { if (!disabled && !selected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
    >
      {/* Checkbox */}
      <div
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md transition-all duration-150"
        style={{
          background: selected ? '#4B3FCF' : 'rgba(255,255,255,0.06)',
          border: `1.5px solid ${selected ? '#4B3FCF' : 'rgba(255,255,255,0.15)'}`,
        }}
      >
        {selected && (
          <svg viewBox="0 0 12 10" fill="white" width={10} height={8}>
            <path d="M1 5l3.5 3.5L11 1" stroke="white" strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      {/* Save icon */}
      <div style={{ fontSize: 16, flexShrink: 0 }}>💾</div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="font-semibold truncate" style={{ fontSize: 12, color: 'rgba(255,255,255,0.9)' }}>
          {save.name}
        </p>
        <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 1 }}>
          {formatDate(save.updated_at)} · {formatBytes(save.size_bytes)}
        </p>
      </div>
    </button>
  )
}

// ── Instances sync card ───────────────────────────────────────────────────────

function InstancesSyncCard() {
  const { instances, yuyuToken, isPremium, isUltimate, addInstance } = useStore()
  const userIsPremium = isPremium()
  const userIsUltimate = isUltimate()

  // Quotas selon le plan (identiques au serveur)
  const QUOTA_SAVES     = userIsUltimate ? 10 : 3
  const QUOTA_INST_WITH = userIsUltimate ? 10 : 3
  const QUOTA_INST_WITHOUT = userIsUltimate ? 10 : 4

  const [cloudInstances, setCloudInstances] = useState<SyncInstance[]>([])
  const [cloudLoading, setCloudLoading] = useState(false)

  const [selectedLocalId, setSelectedLocalId] = useState<string>('')
  const [saves, setSaves] = useState<SaveInfo[]>([])
  const [savesLoading, setSavesLoading] = useState(false)
  const [selectedSaves, setSelectedSaves] = useState<Set<string>>(new Set())

  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [pushing, setPushing] = useState(false)
  const [pullingId, setPullingId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const unlistenRef = useRef<(() => void) | null>(null)
  const cloudLoaded = useRef(false)

  const selectedLocal: Instance | undefined = instances.find((i) => i.id === selectedLocalId)

  // ── Quota computation ────────────────────────────────────────────────────────
  const totalCloudSaves = cloudInstances.reduce((sum, ci) => sum + ci.save_count, 0)
  const existingCloudEntry = selectedLocal
    ? cloudInstances.find((ci) => ci.instance_name === selectedLocal.name)
    : undefined
  const isNewEntry = !existingCloudEntry

  // How many save slots this instance currently "owns" in the cloud
  const ownedSaves = existingCloudEntry?.save_count ?? 0
  // Max saves sélectionnables pour ce push (plafonné par le quota global du plan)
  const MAX_SAVES = Math.min(QUOTA_SAVES, QUOTA_SAVES - totalCloudSaves + ownedSaves)

  // After push: projected totals
  const projectedTotalSaves = totalCloudSaves - ownedSaves + selectedSaves.size
  const projectedInstances = isNewEntry ? cloudInstances.length + 1 : cloudInstances.length
  const projectedMaxInstances = projectedTotalSaves > 0 ? QUOTA_INST_WITH : QUOTA_INST_WITHOUT

  const quotaError: string | null = (() => {
    if (!selectedLocalId) return null
    if (projectedTotalSaves > QUOTA_SAVES)
      return `Quota de saves dépassé : ${projectedTotalSaves}/${QUOTA_SAVES}`
    if (isNewEntry && projectedInstances > projectedMaxInstances)
      return `Quota d'instances atteint : ${cloudInstances.length}/${projectedMaxInstances}`
    return null
  })()

  // Init instance selection
  useEffect(() => {
    if (instances.length > 0 && !selectedLocalId) {
      setSelectedLocalId(instances[0].id)
    }
  }, [instances])

  // Load cloud list once
  useEffect(() => {
    if (!yuyuToken || cloudLoaded.current) return
    cloudLoaded.current = true
    setCloudLoading(true)
    api.sync.list()
      .then(setCloudInstances)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setCloudLoading(false))
  }, [yuyuToken])

  // Load saves when instance changes
  useEffect(() => {
    if (!selectedLocalId) return
    setSaves([])
    setSelectedSaves(new Set())
    setSavesLoading(true)
    api.sync.listSaves(selectedLocalId)
      .then((list) => {
        setSaves(list)
        // Auto-sélectionne les 3 saves les plus récentes
        const auto = new Set(list.slice(0, MAX_SAVES).map((s) => s.name))
        setSelectedSaves(auto)
      })
      .catch(() => setSaves([]))
      .finally(() => setSavesLoading(false))
  }, [selectedLocalId])

  const toggleSave = (name: string) => {
    setSelectedSaves((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        if (next.size >= MAX_SAVES) return prev // limite atteinte
        next.add(name)
      }
      return next
    })
  }

  const notify = (msg: string) => {
    setSuccess(msg)
    setTimeout(() => setSuccess(''), 4000)
  }

  const handlePush = async () => {
    if (!selectedLocalId) return
    setPushing(true)
    setError('')
    setProgress({ phase: 'compressing', percent: 0, label: 'Démarrage...' })

    // Écoute les événements de progression
    const unlisten = await listen<SyncProgress>('sync_progress', (ev) => {
      setProgress(ev.payload)
    })
    unlistenRef.current = unlisten

    try {
      const updated = await api.sync.push(selectedLocalId, Array.from(selectedSaves))
      setCloudInstances((prev) => {
        const idx = prev.findIndex((ci) => ci.id === updated.id)
        return idx >= 0
          ? prev.map((ci, i) => (i === idx ? updated : ci))
          : [updated, ...prev]
      })
      notify('Instance synchronisée vers le cloud !')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      unlisten()
      unlistenRef.current = null
      setTimeout(() => setProgress(null), 1200)
      setPushing(false)
    }
  }

  const handlePull = async (syncId: number) => {
    if (!selectedLocalId) return
    setPullingId(syncId)
    setError('')
    try {
      await api.sync.pull(syncId, selectedLocalId)
      notify('Données tirées dans l\'instance locale !')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPullingId(null)
    }
  }

  const handleDelete = async (syncId: number) => {
    setDeletingId(syncId)
    setError('')
    try {
      await api.sync.delete(syncId)
      setCloudInstances((prev) => prev.filter((ci) => ci.id !== syncId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }

  const handleRestore = async (ci: SyncInstance) => {
    setPullingId(ci.id)
    setError('')
    try {
      const newInstance = await api.instances.create(ci.instance_name, ci.mc_version, ci.loader, ci.ram_mb)
      addInstance(newInstance)
      await api.sync.pull(ci.id, newInstance.id)
      setSelectedLocalId(newInstance.id)
      notify(`Instance "${ci.instance_name}" restaurée depuis le cloud !`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPullingId(null)
    }
  }

  if (!yuyuToken) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10">
        <div style={{ fontSize: 28, opacity: 0.25 }}>🔒</div>
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', fontWeight: 600, textAlign: 'center' }}>
          Connecte-toi à YuyuFrame<br />pour synchroniser tes instances
        </p>
      </div>
    )
  }

  if (!userIsPremium) {
    return <SyncPremiumGate />
  }

  const cloudForSelected = selectedLocal
    ? cloudInstances.find((ci) => ci.instance_name === selectedLocal.name)
    : undefined

  return (
    <div className="flex flex-col gap-6">

      {/* ── Section push ── */}
      <div className="flex flex-col gap-4">

        {/* Instance selector */}
        <div className="flex flex-col gap-2">
          <label style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Instance locale
          </label>
          {instances.length === 0 ? (
            <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.25)' }}>Aucune instance locale</p>
          ) : (
            <div className="relative">
              <select
                value={selectedLocalId}
                onChange={(e) => setSelectedLocalId(e.target.value)}
                disabled={pushing}
                className="w-full appearance-none rounded-xl px-3 pr-8 font-medium text-white outline-none"
                style={{ height: 42, fontSize: 13, background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                {instances.map((inst) => (
                  <option key={inst.id} value={inst.id} style={{ background: '#111118' }}>
                    {inst.name} — {inst.mc_version} ({inst.loader})
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                <svg viewBox="0 0 10 6" fill="white" width={10} height={6} style={{ opacity: 0.4 }}>
                  <path d="M0 0l5 6 5-6z" />
                </svg>
              </div>
            </div>
          )}

          {/* Statut de sync */}
          {selectedLocal && cloudForSelected && (
            <p style={{ fontSize: 11, color: 'rgba(74,222,128,0.8)', paddingLeft: 2 }}>
              Dernière sync : {formatDate(cloudForSelected.updated_at)}
            </p>
          )}
        </div>

        {/* Sélection des saves */}
        {selectedLocalId && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Saves à synchroniser
              </label>
              <div className="flex items-center gap-2">
                {saves.length > 0 && (
                  <span style={{ fontSize: 10, color: selectedSaves.size >= MAX_SAVES ? 'rgba(255,180,0,0.7)' : 'rgba(255,255,255,0.2)' }}>
                    {selectedSaves.size}/{MAX_SAVES} sélectionnée{selectedSaves.size > 1 ? 's' : ''}
                  </span>
                )}
                {saves.length > 1 && (
                  <button
                    onClick={() => {
                      if (selectedSaves.size === Math.min(saves.length, MAX_SAVES)) {
                        setSelectedSaves(new Set())
                      } else {
                        setSelectedSaves(new Set(saves.slice(0, MAX_SAVES).map((s) => s.name)))
                      }
                    }}
                    disabled={pushing}
                    style={{ fontSize: 10, color: 'rgba(75,63,207,0.8)', fontWeight: 600, cursor: 'pointer' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#818cf8' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'rgba(75,63,207,0.8)' }}
                  >
                    {selectedSaves.size === Math.min(saves.length, MAX_SAVES) ? 'Tout désélectionner' : 'Tout sélectionner'}
                  </button>
                )}
              </div>
            </div>

            {savesLoading ? (
              <div className="flex items-center gap-2 py-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.08)', borderTopColor: 'rgba(75,63,207,0.8)' }} />
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)' }}>Chargement des saves...</span>
              </div>
            ) : saves.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ fontSize: 13, opacity: 0.4 }}>💾</span>
                <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.2)' }}>Aucune save — seul config/ sera synchronisé</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {saves.map((save) => {
                  const isSelected = selectedSaves.has(save.name)
                  const limitReached = !isSelected && selectedSaves.size >= MAX_SAVES
                  return (
                    <SaveToggle
                      key={save.name}
                      save={save}
                      selected={isSelected}
                      disabled={pushing || limitReached}
                      onToggle={() => toggleSave(save.name)}
                    />
                  )
                })}
                {selectedSaves.size >= MAX_SAVES && saves.length > MAX_SAVES && (
                  <p style={{ fontSize: 10, color: 'rgba(255,180,0,0.6)', paddingLeft: 2 }}>
                    Maximum {MAX_SAVES} saves par synchronisation
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Barre de progression */}
        {progress && (
          <div className="rounded-xl px-4 py-3" style={{ background: 'rgba(75,63,207,0.08)', border: '1px solid rgba(75,63,207,0.2)' }}>
            <ProgressBar progress={progress} />
          </div>
        )}

        {/* Feedback */}
        {success && !progress && (
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl" style={{ background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.18)' }}>
            <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14} style={{ color: 'rgb(74,222,128)', flexShrink: 0 }}>
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
            </svg>
            <p style={{ fontSize: 12, color: 'rgb(74,222,128)', fontWeight: 600 }}>{success}</p>
          </div>
        )}
        {error && (
          <p style={{ fontSize: 12, color: 'rgb(248,113,113)', paddingLeft: 2 }}>{error}</p>
        )}

        {/* Quota error */}
        {quotaError && !pushing && (
          <p style={{ fontSize: 12, color: 'rgba(255,180,0,0.8)', paddingLeft: 2 }}>{quotaError}</p>
        )}

        {/* Bouton push */}
        {instances.length > 0 && (
          <button
            onClick={handlePush}
            disabled={pushing || !selectedLocalId || !!quotaError}
            className="flex items-center justify-center gap-2 w-full font-bold text-white transition-all duration-150 active:scale-95"
            style={{
              height: 44, borderRadius: 12, fontSize: 13,
              background: (pushing || quotaError) ? 'rgba(40,38,65,0.7)' : '#4B3FCF',
              boxShadow: (pushing || quotaError) ? 'none' : '0 4px 20px rgba(75,63,207,0.32)',
              cursor: (pushing || !selectedLocalId || !!quotaError) ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => { if (!pushing && !quotaError) e.currentTarget.style.background = '#6155e8' }}
            onMouseLeave={(e) => { if (!pushing && !quotaError) e.currentTarget.style.background = (pushing || quotaError) ? 'rgba(40,38,65,0.7)' : '#4B3FCF' }}
          >
            {pushing ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14}>
                <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" />
              </svg>
            )}
            {pushing ? 'Synchronisation...' : `Pousser${selectedSaves.size > 0 ? ` (config + ${selectedSaves.size} save${selectedSaves.size > 1 ? 's' : ''})` : ' (config seulement)'}`}
          </button>
        )}
      </div>

      {/* ── Séparateur ── */}
      <div className="h-px" style={{ background: 'rgba(255,255,255,0.06)' }} />

      {/* ── Section cloud ── */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <label style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Cloud
          </label>
          {cloudInstances.length > 0 && (
            <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>
              {cloudInstances.length} instance{cloudInstances.length > 1 ? 's' : ''}
              {selectedLocal && ' · tirer dans "' + selectedLocal.name + '"'}
            </p>
          )}
        </div>

        {cloudLoading ? (
          <div className="flex justify-center py-6">
            <span className="h-6 w-6 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.08)', borderTopColor: 'rgba(75,63,207,0.8)' }} />
          </div>
        ) : cloudInstances.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6">
            <div style={{ fontSize: 24, opacity: 0.2 }}>☁️</div>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.2)', textAlign: 'center' }}>
              Aucune instance dans le cloud.<br />Pousse une instance pour commencer.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {cloudInstances.map((ci) => {
              const isForSelected = selectedLocal?.name === ci.instance_name
              const isPulling = pullingId === ci.id
              const isDeleting = deletingId === ci.id
              const hasLocalMatch = instances.some((i) => i.name === ci.instance_name)
              const canRestore = !hasLocalMatch && ci.has_data
              return (
                <div
                  key={ci.id}
                  className="flex items-center gap-3 rounded-2xl px-4 py-3"
                  style={{
                    background: isForSelected ? 'rgba(75,63,207,0.1)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${isForSelected ? 'rgba(75,63,207,0.28)' : 'rgba(255,255,255,0.07)'}`,
                  }}
                >
                  <div
                    className="flex items-center justify-center rounded-xl flex-shrink-0"
                    style={{ width: 36, height: 36, background: isForSelected ? 'rgba(75,63,207,0.22)' : 'rgba(255,255,255,0.05)', fontSize: 15 }}
                  >
                    🧱
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-bold truncate" style={{ fontSize: 13, color: 'rgba(255,255,255,0.88)' }}>
                        {ci.instance_name}
                      </p>
                      {isForSelected && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#818cf8', background: 'rgba(75,63,207,0.2)', padding: '1px 6px', borderRadius: 4, letterSpacing: '0.05em', flexShrink: 0 }}>
                          SÉLECTIONNÉE
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span style={{ fontSize: 11, color: loaderColor(ci.loader), fontWeight: 600 }}>{ci.loader}</span>
                      <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.22)' }}>{ci.mc_version}</span>
                      {ci.has_data
                        ? <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.18)' }}>{formatDate(ci.updated_at)}</span>
                        : <span style={{ fontSize: 11, color: 'rgba(255,180,0,0.45)' }}>Pas de données</span>
                      }
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {canRestore ? (
                      <button
                        onClick={() => handleRestore(ci)}
                        disabled={isPulling || pushing}
                        title="Créer l'instance localement et tirer les données"
                        className="flex items-center gap-1.5 font-semibold transition-all duration-150"
                        style={{
                          height: 30, padding: '0 12px', borderRadius: 9, fontSize: 12,
                          background: isPulling ? 'rgba(40,38,65,0.7)' : 'rgba(74,222,128,0.12)',
                          color: (isPulling || pushing) ? 'rgba(255,255,255,0.2)' : 'rgba(74,222,128,0.85)',
                          cursor: (isPulling || pushing) ? 'not-allowed' : 'pointer',
                          border: '1px solid rgba(74,222,128,0.2)',
                        }}
                        onMouseEnter={(e) => { if (!isPulling && !pushing) e.currentTarget.style.background = 'rgba(74,222,128,0.2)' }}
                        onMouseLeave={(e) => { if (!isPulling && !pushing) e.currentTarget.style.background = 'rgba(74,222,128,0.12)' }}
                      >
                        {isPulling
                          ? <span className="h-3 w-3 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
                          : <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12}><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" style={{ transform: 'scaleY(-1)', transformOrigin: 'center' }} /></svg>
                        }
                        Restaurer
                      </button>
                    ) : (
                    <button
                      onClick={() => handlePull(ci.id)}
                      disabled={isPulling || !ci.has_data || !selectedLocalId || pushing}
                      title={!selectedLocalId ? 'Sélectionne une instance locale' : ci.has_data ? `Tirer dans "${selectedLocal?.name}"` : 'Aucune donnée'}
                      className="flex items-center gap-1.5 font-semibold transition-all duration-150"
                      style={{
                        height: 30, padding: '0 12px', borderRadius: 9, fontSize: 12,
                        background: isPulling ? 'rgba(40,38,65,0.7)' : 'rgba(75,63,207,0.16)',
                        color: (ci.has_data && selectedLocalId && !pushing) ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)',
                        cursor: (isPulling || !ci.has_data || !selectedLocalId || pushing) ? 'not-allowed' : 'pointer',
                        border: '1px solid rgba(75,63,207,0.2)',
                      }}
                      onMouseEnter={(e) => { if (ci.has_data && selectedLocalId && !isPulling && !pushing) e.currentTarget.style.background = 'rgba(75,63,207,0.3)' }}
                      onMouseLeave={(e) => { if (ci.has_data && selectedLocalId && !isPulling && !pushing) e.currentTarget.style.background = 'rgba(75,63,207,0.16)' }}
                    >
                      {isPulling
                        ? <span className="h-3 w-3 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.2)', borderTopColor: 'white' }} />
                        : <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12}><path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z" style={{ transform: 'scaleY(-1)', transformOrigin: 'center' }} /></svg>
                      }
                      Tirer
                    </button>
                    )}

                    <button
                      onClick={() => handleDelete(ci.id)}
                      disabled={isDeleting || pushing}
                      title="Supprimer ce sync cloud"
                      className="flex h-8 w-8 items-center justify-center rounded-xl transition-all duration-150"
                      style={{ color: 'rgba(255,255,255,0.18)', background: 'transparent', cursor: (isDeleting || pushing) ? 'not-allowed' : 'pointer' }}
                      onMouseEnter={(e) => { if (!isDeleting && !pushing) { e.currentTarget.style.color = 'rgb(248,113,113)'; e.currentTarget.style.background = 'rgba(200,50,50,0.12)' } }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.18)'; e.currentTarget.style.background = 'transparent' }}
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor" width={15} height={15}>
                        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                      </svg>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.1)', textAlign: 'center' }}>
        mods/ + config/ + saves sélectionnées (3 max) · Premium
      </p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Sync() {
  const navigate = useNavigate()
  const { yuyuPlan } = useStore()
  const planLabel = yuyuPlan === 'ultimate' ? 'ULTIMATE' : 'PREMIUM'
  const planColor = yuyuPlan === 'ultimate' ? { color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' } : { color: '#818cf8', bg: 'rgba(75,63,207,0.18)' }

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

        <h1 className="font-black text-white" style={{ fontSize: 16, letterSpacing: '-0.01em' }}>
          Synchronisation
        </h1>

        <span style={{ fontSize: 10, fontWeight: 700, color: planColor.color, background: planColor.bg, padding: '2px 8px', borderRadius: 6, letterSpacing: '0.05em' }}>
          {planLabel}
        </span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5">
        <div
          className="rounded-2xl p-5"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          {/* Card header */}
          <div className="flex items-center gap-3 mb-5">
            <div
              className="flex items-center justify-center rounded-xl flex-shrink-0"
              style={{ width: 40, height: 40, background: 'rgba(75,63,207,0.18)', border: '1px solid rgba(75,63,207,0.3)', fontSize: 18 }}
            >
              ☁️
            </div>
            <div>
              <p className="font-bold text-white" style={{ fontSize: 14 }}>Instances</p>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 1 }}>
                Choisis les saves à synchroniser entre tes PCs
              </p>
            </div>
          </div>

          <InstancesSyncCard />
        </div>
      </div>
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
          'Sync configs & saves entre tes PCs',
          'Jusqu\'à 3 saves cloud (10 en Ultimate)',
          'Restauration en 1 clic',
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
