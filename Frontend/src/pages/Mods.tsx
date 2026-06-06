import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { useStore } from '@/stores/useStore'
import type { Instance, Mod } from '@/types'

// ── Types internes ───────────────────────────────────────────────────────────

interface ModrinthInfo {
  version: string
  modrinthName: string
  projectId: string
}

interface ModUpdate {
  mod: Mod
  modrinthName: string
  currentVersion: string
  newVersion: string
  fileUrl: string
  filename: string
}

// ── Modrinth types ────────────────────────────────────────────────────────────

interface ModrinthHit {
  project_id: string
  slug: string
  title: string
  description: string
  icon_url: string | null
  downloads: number
  categories: string[]
}

interface ModrinthVersion {
  files: Array<{ url: string; filename: string; primary: boolean }>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function displayName(name: string): string {
  return name.replace(/\.jar(\.disabled)?$/, '')
}


async function fetchVersionsByHash(sha1s: string[]): Promise<Record<string, ModrinthInfo>> {
  const hashes = sha1s.filter(Boolean)
  if (hashes.length === 0) return {}
  try {
    const res = await fetch('https://api.modrinth.com/v2/version_files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'YuyuFrame/1.0' },
      body: JSON.stringify({ hashes, algorithm: 'sha1' }),
    })
    if (!res.ok) return {}
    const versionData = await res.json() as Record<string, { version_number: string; project_id: string }>

    // Batch-fetch project titles
    const projectIds = [...new Set(Object.values(versionData).map((v) => v.project_id))]
    const projectNames: Record<string, string> = {}
    if (projectIds.length > 0) {
      const pRes = await fetch(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`,
        { headers: { 'User-Agent': 'YuyuFrame/1.0' } },
      )
      if (pRes.ok) {
        const projects = await pRes.json() as Array<{ id: string; title: string }>
        projects.forEach((p) => { projectNames[p.id] = p.title })
      }
    }

    const out: Record<string, ModrinthInfo> = {}
    for (const [hash, info] of Object.entries(versionData)) {
      out[hash] = { version: info.version_number, modrinthName: projectNames[info.project_id] ?? '', projectId: info.project_id }
    }
    return out
  } catch {
    return {}
  }
}

async function checkForUpdates(
  mods: Mod[],
  versionData: Record<string, ModrinthInfo>,
  mcVersion: string,
  loader: string,
): Promise<ModUpdate[]> {
  const eligible = mods.filter((m) => m.sha1)
  if (eligible.length === 0) return []
  try {
    const body: Record<string, unknown> = {
      hashes: eligible.map((m) => m.sha1),
      algorithm: 'sha1',
      game_versions: [mcVersion],
    }
    if (loader !== 'vanilla') body.loaders = [loader]
    const res = await fetch('https://api.modrinth.com/v2/version_files/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'YuyuFrame/1.0' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return []
    const data = await res.json() as Record<string, {
      version_number: string
      files: Array<{ url: string; filename: string; primary: boolean; hashes?: { sha1?: string } }>
    }>
    const updates: ModUpdate[] = []
    for (const mod of eligible) {
      const latest = data[mod.sha1]
      if (!latest) continue
      const primary = latest.files.find((f) => f.primary) ?? latest.files[0]
      if (!primary) continue
      if (primary.hashes?.sha1 === mod.sha1) continue // déjà à jour
      updates.push({
        mod,
        modrinthName: versionData[mod.sha1]?.modrinthName || '',
        currentVersion: versionData[mod.sha1]?.version || '',
        newVersion: latest.version_number,
        fileUrl: primary.url,
        filename: primary.filename,
      })
    }
    return updates
  } catch {
    return []
  }
}

export async function updateModsForNewVersion(
  instanceId: string,
  mcVersion: string,
  loader: string,
): Promise<void> {
  try {
    const mods = await api.mods.list(instanceId)
    if (mods.length === 0) return
    const infoMap = await fetchVersionsByHash(mods.map((m) => m.sha1))
    for (const mod of mods) {
      const info = infoMap[mod.sha1]
      // Mod inconnu de Modrinth (custom/privé) → on ne touche pas
      if (!info?.projectId) continue
      try {
        const params = new URLSearchParams()
        params.set('game_versions', JSON.stringify([mcVersion]))
        if (loader !== 'vanilla') params.set('loaders', JSON.stringify([loader]))
        const res = await fetch(
          `https://api.modrinth.com/v2/project/${info.projectId}/version?${params}`,
          { headers: { 'User-Agent': 'YuyuFrame/1.0' } },
        )
        if (!res.ok) {
          // Erreur réseau → désactiver par précaution si le mod est actif
          if (mod.enabled) await api.mods.toggle(instanceId, mod.name).catch(() => {})
          continue
        }
        const versions = await res.json() as Array<{ files: Array<{ url: string; filename: string; primary: boolean }> }>
        if (!versions.length) {
          // Aucune version compatible → désactiver (ne pas crasher le jeu)
          if (mod.enabled) await api.mods.toggle(instanceId, mod.name).catch(() => {})
          continue
        }
        const file = versions[0].files.find((f) => f.primary) ?? versions[0].files[0]
        if (!file) {
          if (mod.enabled) await api.mods.toggle(instanceId, mod.name).catch(() => {})
          continue
        }
        const newMod = await api.mods.install(instanceId, file.url, file.filename)
        if (newMod.name !== mod.name) {
          await api.mods.delete(instanceId, mod.name).catch(() => {})
        }
      } catch {
        // Erreur inattendue → désactiver par sécurité
        if (mod.enabled) await api.mods.toggle(instanceId, mod.name).catch(() => {})
      }
    }
  } catch { /* ignore */ }
}

async function fetchModrinthSearch(
  query: string,
  gameVersion: string,
  loader: string,
): Promise<ModrinthHit[]> {
  const isPlugin = loader === 'vanilla'
  const facets: string[][] = [[`project_type:${isPlugin ? 'plugin' : 'mod'}`]]
  if (gameVersion) facets.push([`versions:${gameVersion}`])
  if (!isPlugin) facets.push([`categories:${loader}`])

  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    limit: '20',
  })

  const res = await fetch(`https://api.modrinth.com/v2/search?${params}`, {
    headers: { 'User-Agent': 'YuyuFrame/1.0' },
  })
  if (!res.ok) throw new Error(`Modrinth: ${res.status}`)
  const data = await res.json()
  return data.hits as ModrinthHit[]
}

async function fetchLatestVersion(
  slug: string,
  gameVersion: string,
  loader: string,
): Promise<ModrinthVersion | null> {
  const params = new URLSearchParams()
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]))
  if (loader && loader !== 'vanilla') params.set('loaders', JSON.stringify([loader]))

  const res = await fetch(
    `https://api.modrinth.com/v2/project/${slug}/version?${params}`,
    { headers: { 'User-Agent': 'YuyuFrame/1.0' } },
  )
  if (!res.ok) return null
  const versions: ModrinthVersion[] = await res.json()
  return versions[0] ?? null
}

type Tab = 'installed' | 'browse'

// Cache module-level : évite de rappeler Modrinth à chaque ouverture du panel
const _modrinthCache: Record<string, {
  versionMap: Record<string, ModrinthInfo>
  updates: ModUpdate[]
}> = {}

// Cache icônes module-level — clé : "instanceId/modDisplayName"
const _iconCache: Record<string, string | null> = {}

// ── ModsContent — embeddable in any page ──────────────────────────────────────

export function ModsContent({ instance }: { instance: Instance }) {
  const instanceId = instance.id
  const mcVersion = instance.mc_version
  const loader = instance.loader
  const isPlugin = loader === 'vanilla'

  const [tab, setTab] = useState<Tab>('installed')
  const [mods, setMods] = useState<Mod[]>([])
  const [loadingMods, setLoadingMods] = useState(true)
  const [modsError, setModsError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [versionMap, setVersionMap] = useState<Record<string, ModrinthInfo>>({})
  const [updates, setUpdates] = useState<ModUpdate[]>([])
  const [updatingMods, setUpdatingMods] = useState<Set<string>>(new Set())
  const [updatingAll, setUpdatingAll] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const mergeVersions = (fetched: Record<string, ModrinthInfo>) =>
    setVersionMap((prev) => ({ ...prev, ...fetched }))

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModrinthHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [installing, setInstalling] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [modSearch, setModSearch] = useState('')
  const [logoCache, setLogoCache] = useState<Record<string, string | null>>({})

  useEffect(() => {
    if (mods.length === 0) return
    const fromCache: Record<string, string | null> = {}
    const missing: Mod[] = []

    for (const mod of mods) {
      const key = displayName(mod.name)
      const cacheKey = `${instanceId}/${key}`
      if (cacheKey in _iconCache) {
        fromCache[key] = _iconCache[cacheKey]
      } else {
        missing.push(mod)
      }
    }

    if (Object.keys(fromCache).length > 0)
      setLogoCache((prev) => ({ ...prev, ...fromCache }))

    missing.forEach(async (mod) => {
      const key = displayName(mod.name)
      const cacheKey = `${instanceId}/${key}`
      try {
        const dataUrl = await api.mods.icon(instanceId, mod.name)
        _iconCache[cacheKey] = dataUrl
        setLogoCache((prev) => ({ ...prev, [key]: dataUrl }))
      } catch {
        _iconCache[cacheKey] = null
        setLogoCache((prev) => ({ ...prev, [key]: null }))
      }
    })
  }, [mods])

  const loadMods = async () => {
    if (!instanceId) return
    setLoadingMods(true)
    setModsError('')
    try {
      const loaded = await api.mods.list(instanceId)
      setMods(loaded)
      const cached = _modrinthCache[instanceId]
      if (cached) {
        setVersionMap(cached.versionMap)
        setUpdates(cached.updates)
      } else {
        fetchVersionsByHash(loaded.map((m) => m.sha1)).then((vd) => {
          mergeVersions(vd)
          checkForUpdates(loaded, vd, mcVersion, loader).then((upd) => {
            setUpdates(upd)
            _modrinthCache[instanceId] = { versionMap: vd, updates: upd }
          })
        })
      }
    } catch {
      setModsError('Impossible de charger les mods')
    } finally {
      setLoadingMods(false)
    }
  }

  useEffect(() => { setVersionMap({}); setUpdates([]); loadMods() }, [instanceId])

  useEffect(() => {
    if (tab === 'browse' && results.length === 0 && !searching) {
      runSearch(query)
    }
  }, [tab])

  const handleToggle = async (mod: Mod) => {
    try {
      const updated = await api.mods.toggle(instanceId, mod.name)
      setMods((prev) => prev.map((m) => m.name === mod.name ? updated : m))
    } catch { /* ignore */ }
  }

  const handleDelete = async (name: string) => {
    try {
      await api.mods.delete(instanceId, name)
      setMods((prev) => prev.filter((m) => m.name !== name))
      delete _modrinthCache[instanceId]
    } catch { /* ignore */ }
  }

  const handleUpdateMod = async (update: ModUpdate) => {
    setUpdatingMods((prev) => new Set([...prev, update.mod.sha1]))
    try {
      const newMod = await api.mods.install(instanceId, update.fileUrl, update.filename)
      if (newMod.name !== update.mod.name) {
        await api.mods.delete(instanceId, update.mod.name).catch(() => {})
        setMods((prev) =>
          [...prev.filter((m) => m.name !== update.mod.name), newMod]
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
        )
      } else {
        setMods((prev) => prev.map((m) => m.name === update.mod.name ? newMod : m))
      }
      setUpdates((prev) => prev.filter((u) => u.mod.sha1 !== update.mod.sha1))
      fetchVersionsByHash([newMod.sha1]).then(mergeVersions)
      delete _modrinthCache[instanceId]
    } catch { /* ignore */ }
    finally {
      setUpdatingMods((prev) => { const s = new Set(prev); s.delete(update.mod.sha1); return s })
    }
  }

  const handleUpdateAll = async () => {
    if (updatingAll) return
    setUpdatingAll(true)
    const pending = [...updates]
    for (const update of pending) await handleUpdateMod(update)
    setUpdatingAll(false)
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const newMod = await api.mods.upload(instanceId, file)
      setMods((prev) =>
        [...prev.filter((m) => m.name !== newMod.name), newMod]
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      )
      fetchVersionsByHash([newMod.sha1]).then(mergeVersions)
      delete _modrinthCache[instanceId]
    } catch {
      setModsError("Erreur lors de l'import")
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const runSearch = async (q: string) => {
    setSearching(true)
    setSearchError('')
    try {
      setResults(await fetchModrinthSearch(q, mcVersion, loader))
    } catch {
      setSearchError('Impossible de joindre Modrinth')
    } finally {
      setSearching(false)
    }
  }

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value
    setQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(q), 450)
  }

  const isInstalled = (slug: string) =>
    mods.some((m) => displayName(m.name).toLowerCase().includes(slug.toLowerCase()))

  const handleInstall = async (hit: ModrinthHit) => {
    setInstalling(hit.project_id)
    try {
      const version = await fetchLatestVersion(hit.slug, mcVersion, loader)
      if (!version) throw new Error('Aucune version compatible')
      const file = version.files.find((f) => f.primary) ?? version.files[0]
      if (!file) throw new Error('Aucun fichier disponible')
      const newMod = await api.mods.install(instanceId, file.url, file.filename)
      setMods((prev) =>
        [...prev.filter((m) => m.name !== newMod.name), newMod]
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      )
      fetchVersionsByHash([newMod.sha1]).then(mergeVersions)
      delete _modrinthCache[instanceId]
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : 'Erreur installation')
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Sub-header: 3 zones — gauche/centre/droite */}
      <div
        className="flex flex-shrink-0 items-center px-6 py-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
      >
        {/* Gauche : tab Installés + badge mises à jour */}
        <div className="flex flex-1 items-center gap-1">
          <button
            onClick={() => setTab('installed')}
            className="rounded-lg px-4 py-1.5 text-xs font-semibold transition-all duration-150"
            style={{
              background: tab === 'installed' ? 'rgba(75,63,207,0.25)' : 'transparent',
              color: tab === 'installed' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.35)',
              border: `1px solid ${tab === 'installed' ? 'rgba(75,63,207,0.5)' : 'transparent'}`,
            }}
          >
            {`Installés (${mods.length})`}
          </button>
          {tab === 'installed' && updates.length > 0 && (
            <button
              onClick={handleUpdateAll}
              disabled={updatingAll}
              title="Tout mettre à jour"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold transition-all duration-150"
              style={{
                background: updatingAll ? 'rgba(255,255,255,0.04)' : 'rgba(250,204,21,0.12)',
                color: updatingAll ? 'rgba(255,255,255,0.25)' : 'rgba(250,204,21,0.9)',
                border: '1px solid rgba(250,204,21,0.28)',
                cursor: updatingAll ? 'not-allowed' : 'pointer',
              }}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width={11} height={11}>
                <path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z" />
              </svg>
              {updatingAll ? '...' : updates.length}
            </button>
          )}
        </div>

        {/* Centre : boutons d'ajout groupés */}
        <div className="flex items-center" style={{ border: '1px solid rgba(75,63,207,0.35)', borderRadius: 10, overflow: 'hidden' }}>
          <button
            onClick={() => setTab('browse')}
            className="flex items-center gap-1.5 font-semibold transition-all duration-150"
            style={{
              height: 32, paddingLeft: 14, paddingRight: 14, fontSize: 12, border: 'none',
              borderRight: '1px solid rgba(75,63,207,0.35)',
              background: tab === 'browse' ? 'rgba(75,63,207,0.25)' : 'transparent',
              color: tab === 'browse' ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.55)',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => { if (tab !== 'browse') e.currentTarget.style.background = 'rgba(75,63,207,0.12)' }}
            onMouseLeave={(e) => { if (tab !== 'browse') e.currentTarget.style.background = 'transparent' }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width={13} height={13}>
              <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
            </svg>
            {isPlugin ? 'Parcourir les plugins' : 'Parcourir Modrinth'}
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 font-semibold transition-all duration-150 active:scale-95"
            style={{
              height: 32, paddingLeft: 14, paddingRight: 14, fontSize: 12, border: 'none',
              background: uploading ? 'rgba(40,38,65,0.7)' : 'rgba(75,63,207,0.3)',
              color: uploading ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.85)',
              cursor: uploading ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => { if (!uploading) e.currentTarget.style.background = 'rgba(75,63,207,0.5)' }}
            onMouseLeave={(e) => { if (!uploading) e.currentTarget.style.background = uploading ? 'rgba(40,38,65,0.7)' : 'rgba(75,63,207,0.3)' }}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width={13} height={13}>
              <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
            </svg>
            {uploading ? 'Import...' : isPlugin ? 'Importer un plugin' : 'Importer un mod'}
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept=".jar" className="hidden" onChange={handleFileChange} />

        {/* Droite : informations de l'instance */}
        <div className="flex flex-1 justify-end">
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>
            {instance.name} · {mcVersion} · {loader}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-3">
        {tab === 'installed' ? (
          <InstalledTab
            mods={mods}
            loading={loadingMods}
            error={modsError}
            isPlugin={isPlugin}
            modSearch={modSearch}
            onModSearch={setModSearch}
            logoCache={logoCache}
            versionMap={versionMap}
            updates={updates}
            updatingMods={updatingMods}
            updatingAll={updatingAll}
            onReload={loadMods}
            onToggle={handleToggle}
            onDelete={handleDelete}
            onUpdateMod={handleUpdateMod}
          />
        ) : (
          <BrowseTab
            query={query}
            results={results}
            searching={searching}
            error={searchError}
            installing={installing}
            isInstalled={isInstalled}
            isPlugin={isPlugin}
            onQueryChange={handleQueryChange}
            onInstall={handleInstall}
          />
        )}
      </div>
    </div>
  )
}

// ── Standalone page (kept for /mods route) ────────────────────────────────────

export default function Mods() {
  const navigate = useNavigate()
  const { selectedInstance } = useStore()
  const instance = selectedInstance()

  if (!instance) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4" style={{ background: '#09090D', color: 'white' }}>
        <div style={{ fontSize: 36 }}>🧱</div>
        <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.4)', fontWeight: 600 }}>Aucune instance sélectionnée</p>
        <button
          onClick={() => navigate('/instances')}
          className="font-semibold transition-all duration-200 active:scale-95"
          style={{ height: 38, padding: '0 20px', borderRadius: 10, fontSize: 13, background: '#4B3FCF', color: 'white' }}
        >
          Gérer les instances
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col" style={{ background: '#09090D', color: 'white' }}>
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
        <h1 className="font-black text-white" style={{ fontSize: 18, letterSpacing: '-0.01em' }}>Mods</h1>
      </div>
      <ModsContent instance={instance} />
    </div>
  )
}

// ── Installed tab ─────────────────────────────────────────────────────────────

function InstalledTab({
  mods, loading, error, isPlugin, modSearch, onModSearch, logoCache, versionMap,
  updates, updatingMods, updatingAll, onReload, onToggle, onDelete, onUpdateMod,
}: {
  mods: Mod[]
  loading: boolean
  error: string
  isPlugin: boolean
  modSearch: string
  onModSearch: (v: string) => void
  logoCache: Record<string, string | null>
  versionMap: Record<string, ModrinthInfo>
  updates: ModUpdate[]
  updatingMods: Set<string>
  updatingAll: boolean
  onReload: () => void
  onToggle: (mod: Mod) => void
  onDelete: (name: string) => void
  onUpdateMod: (u: ModUpdate) => void
}) {
  if (loading) return <Spinner />
  if (error) return <ErrorState message={error} onRetry={onReload} />

  const filtered = mods.filter((m) =>
    displayName(m.name).toLowerCase().includes(modSearch.toLowerCase()),
  )

  const hdr: React.CSSProperties = { fontSize: 10, color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', letterSpacing: '0.09em', fontWeight: 600 }

  return (
    <div>
      {/* Barre de recherche */}
      {mods.length > 0 && (
        <div className="relative mb-3">
          <svg viewBox="0 0 24 24" fill="currentColor" width={14} height={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'rgba(255,255,255,0.3)' }}>
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <input
            type="text"
            placeholder="Filtrer les mods..."
            value={modSearch}
            onChange={(e) => onModSearch(e.target.value)}
            className="w-full rounded-xl pl-8 pr-4 text-sm text-white outline-none"
            style={{ height: 36, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
            onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(75,63,207,0.6)' }}
            onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
          />
        </div>
      )}

      {/* États vides */}
      {filtered.length === 0 && mods.length === 0 && (
        <EmptyState
          icon={<PlugIcon size={28} color="rgba(75,63,207,0.55)" />}
          title={isPlugin ? 'Aucun plugin installé' : 'Aucun mod installé'}
          subtitle={isPlugin
            ? 'Importez un .jar ou parcourez les plugins'
            : 'Cliquez sur "Importer un mod" ou parcourez Modrinth'}
        />
      )}
      {filtered.length === 0 && mods.length > 0 && (
        <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)', textAlign: 'center', marginTop: 32 }}>
          Aucun mod ne correspond à « {modSearch} »
        </p>
      )}

      {/* En-tête tableur — structure DOM identique au ModRow pour alignement parfait */}
      {filtered.length > 0 && (
        <div
          className="flex items-center rounded-2xl px-4 py-1.5"
          style={{ position: 'sticky', top: -12, zIndex: 10, background: '#09090D', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 8 }}
        >
          <div className="flex items-center gap-3 min-w-0" style={{ flex: 1 }}>
            <div style={{ width: 36, flexShrink: 0 }} />
            <div className="min-w-0 flex-1"><span style={hdr}>Mod</span></div>
          </div>
          <div style={{ flexShrink: 0, width: 110, textAlign: 'center', padding: '0 8px' }}>
            <span style={hdr}>Version</span>
          </div>
          <div className="flex items-center justify-end gap-2" style={{ flex: 1 }}>
            <span style={hdr}>Action</span>
          </div>
        </div>
      )}

      {/* Liste des mods */}
      <div className="flex flex-col gap-2">
        {filtered.map((mod) => {
          const update = updates.find((u) => u.mod.sha1 === mod.sha1) ?? null
          return (
            <ModRow
              key={mod.name}
              mod={mod}
              version={versionMap[mod.sha1]?.version ?? null}
              modrinthName={versionMap[mod.sha1]?.modrinthName || null}
              update={update}
              updating={updatingMods.has(mod.sha1) || updatingAll}
              logoUrl={logoCache[displayName(mod.name)] ?? null}
              onToggle={() => onToggle(mod)}
              onDelete={() => onDelete(mod.name)}
              onUpdate={() => update && onUpdateMod(update)}
            />
          )
        })}
      </div>
    </div>
  )
}

// ── Browse tab ────────────────────────────────────────────────────────────────

function BrowseTab({
  query, results, searching, error, installing, isInstalled, isPlugin,
  onQueryChange, onInstall,
}: {
  query: string
  results: ModrinthHit[]
  searching: boolean
  error: string
  installing: string | null
  isInstalled: (slug: string) => boolean
  isPlugin: boolean
  onQueryChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onInstall: (hit: ModrinthHit) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <svg viewBox="0 0 24 24" fill="currentColor" width={15} height={15}
          className="absolute left-3 top-1/2 -translate-y-1/2"
          style={{ color: 'rgba(255,255,255,0.3)', pointerEvents: 'none' }}>
          <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
        </svg>
        <input
          type="text"
          placeholder={isPlugin ? 'Rechercher un plugin...' : 'Rechercher un mod...'}
          value={query}
          onChange={onQueryChange}
          className="w-full rounded-xl pl-9 pr-4 text-sm text-white outline-none"
          style={{ height: 40, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
          onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(75,63,207,0.6)' }}
          onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
        />
        {searching && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin rounded-full border-2"
            style={{ borderColor: 'rgba(255,255,255,0.1)', borderTopColor: 'rgba(75,63,207,0.8)' }} />
        )}
      </div>

      {error && <p style={{ fontSize: 12, color: 'rgb(248,113,113)' }}>{error}</p>}

      {!searching && results.length === 0 && !error && (
        <EmptyState
          icon={<SearchIcon size={28} color="rgba(255,255,255,0.15)" />}
          title="Aucun résultat"
          subtitle={isPlugin
            ? 'Essayez un autre terme de recherche'
            : 'Essayez un autre terme ou changez la version MC'}
        />
      )}

      <div className="flex flex-col gap-2">
        {results.map((hit) => (
          <ModrinthCard
            key={hit.project_id}
            hit={hit}
            installed={isInstalled(hit.slug)}
            loading={installing === hit.project_id}
            onInstall={() => onInstall(hit)}
          />
        ))}
      </div>
    </div>
  )
}

// ── Mod row ───────────────────────────────────────────────────────────────────

function ModRow({ mod, version, modrinthName, update, updating, logoUrl, onToggle, onDelete, onUpdate }: {
  mod: Mod
  version: string | null
  modrinthName: string | null
  update: ModUpdate | null
  updating: boolean
  logoUrl: string | null
  onToggle: () => void
  onDelete: () => void
  onUpdate: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  return (
    <div
      className="flex items-center rounded-2xl px-4 py-3 transition-all duration-150"
      style={{ background: mod.enabled ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.018)', border: '1px solid rgba(255,255,255,0.06)', opacity: mod.enabled ? 1 : 0.6 }}
    >
      {/* Section gauche : icône + nom (flex-1) */}
      <div className="flex items-center gap-3 min-w-0" style={{ flex: 1 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, overflow: 'hidden', background: mod.enabled ? 'rgba(75,63,207,0.15)' : 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {logoUrl
            ? <img src={logoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <PlugIcon size={18} color={mod.enabled ? 'rgba(120,110,230,0.8)' : 'rgba(255,255,255,0.2)'} />
          }
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold" style={{ fontSize: 13, color: mod.enabled ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.4)' }}>
            {modrinthName || displayName(mod.name)}
          </p>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.22)', marginTop: 1 }}>{formatSize(mod.size)}</p>
        </div>
      </div>

      {/* Section centre : version (vraiment au milieu car flanquée de 2 flex-1) */}
      <div style={{ flexShrink: 0, width: 110, textAlign: 'center', padding: '0 8px' }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: version ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.15)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
          {version ?? '—'}
        </span>
      </div>

      {/* Section droite : actions (flex-1, alignées à droite) */}
      <div className="flex items-center justify-end gap-2" style={{ flex: 1 }}>
        {update && (
          <button
            onClick={onUpdate}
            disabled={updating}
            title={`Mettre à jour → ${update.newVersion}`}
            className="flex h-7 flex-shrink-0 items-center gap-1 rounded-lg px-2 transition-all duration-150"
            style={{
              fontSize: 10, fontWeight: 700,
              background: updating ? 'rgba(255,255,255,0.04)' : 'rgba(250,204,21,0.12)',
              border: '1px solid rgba(250,204,21,0.28)',
              color: updating ? 'rgba(255,255,255,0.2)' : 'rgba(250,204,21,0.85)',
              cursor: updating ? 'not-allowed' : 'pointer',
            }}
          >
            {updating ? (
              <span className="h-3 w-3 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.1)', borderTopColor: 'rgba(250,204,21,0.6)' }} />
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor" width={10} height={10}>
                <path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z" />
              </svg>
            )}
            {update.newVersion}
          </button>
        )}
        <button onClick={onToggle} title={mod.enabled ? 'Désactiver' : 'Activer'}
          className="relative flex-shrink-0"
          style={{ width: 40, height: 22, borderRadius: 11, background: mod.enabled ? '#4B3FCF' : 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer' }}>
          <span className="absolute transition-all duration-200" style={{ top: 3, left: mod.enabled ? 21 : 3, width: 16, height: 16, borderRadius: '50%', background: 'white', boxShadow: '0 1px 4px rgba(0,0,0,0.4)' }} />
        </button>
        {confirm ? (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={() => { onDelete(); setConfirm(false) }} style={{ fontSize: 10, fontWeight: 600, color: 'rgb(248,113,113)', background: 'rgba(200,50,50,0.15)', borderRadius: 7, padding: '3px 7px' }}>Suppr.</button>
            <button onClick={() => setConfirm(false)} style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.06)', borderRadius: 7, padding: '3px 7px' }}>Ann.</button>
          </div>
        ) : (
          <button onClick={() => setConfirm(true)}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl transition-all duration-150"
            style={{ color: 'rgba(255,255,255,0.2)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'rgb(248,113,113)'; e.currentTarget.style.background = 'rgba(200,50,50,0.12)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.2)'; e.currentTarget.style.background = 'transparent' }}>
            <svg viewBox="0 0 24 24" fill="currentColor" width={16} height={16}>
              <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

// ── Modrinth card ─────────────────────────────────────────────────────────────

function ModrinthCard({ hit, installed, loading, onInstall }: {
  hit: ModrinthHit; installed: boolean; loading: boolean; onInstall: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0, overflow: 'hidden', background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {hit.icon_url ? (
          <img src={hit.icon_url} alt={hit.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <PlugIcon size={20} color="rgba(255,255,255,0.2)" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-white" style={{ fontSize: 13 }}>{hit.title}</p>
        <p className="truncate" style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>{hit.description}</p>
        <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', marginTop: 3 }}>{formatDownloads(hit.downloads)} téléchargements</p>
      </div>
      <button
        onClick={onInstall}
        disabled={installed || loading}
        className="flex-shrink-0 flex items-center gap-1.5 rounded-xl font-semibold transition-all duration-150 active:scale-95"
        style={{
          height: 32, paddingLeft: 14, paddingRight: 14, fontSize: 12,
          background: installed ? 'rgba(255,255,255,0.05)' : loading ? 'rgba(40,38,65,0.7)' : 'rgba(75,63,207,0.3)',
          border: `1px solid ${installed ? 'rgba(255,255,255,0.08)' : 'rgba(75,63,207,0.5)'}`,
          color: installed ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.85)',
          cursor: installed || loading ? 'not-allowed' : 'pointer',
        }}
        onMouseEnter={(e) => { if (!installed && !loading) e.currentTarget.style.background = 'rgba(75,63,207,0.5)' }}
        onMouseLeave={(e) => { if (!installed && !loading) e.currentTarget.style.background = 'rgba(75,63,207,0.3)' }}
      >
        {loading ? (
          <span className="h-3 w-3 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.15)', borderTopColor: 'white' }} />
        ) : installed ? '✓ Installé' : 'Installer'}
      </button>
    </div>
  )
}

// ── Shared small components ───────────────────────────────────────────────────

function Spinner() {
  return (
    <div className="flex h-40 items-center justify-center">
      <span className="h-8 w-8 animate-spin rounded-full border-2" style={{ borderColor: 'rgba(255,255,255,0.08)', borderTopColor: 'rgba(75,63,207,0.8)' }} />
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-3">
      <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>{message}</span>
      <button onClick={onRetry} style={{ fontSize: 12, color: '#7872e8', textDecoration: 'underline' }}>Réessayer</button>
    </div>
  )
}

function EmptyState({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-4">
      <div style={{ width: 56, height: 56, borderRadius: 16, background: 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {icon}
      </div>
      <div className="text-center">
        <p className="font-semibold" style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14 }}>{title}</p>
        <p style={{ color: 'rgba(255,255,255,0.2)', fontSize: 12, marginTop: 4 }}>{subtitle}</p>
      </div>
    </div>
  )
}

function PlugIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg viewBox="0 0 24 24" fill={color} width={size} height={size}>
      <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z" />
    </svg>
  )
}

function SearchIcon({ size, color }: { size: number; color: string }) {
  return (
    <svg viewBox="0 0 24 24" fill={color} width={size} height={size}>
      <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
    </svg>
  )
}
