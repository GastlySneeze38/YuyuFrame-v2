export interface ModpackHit {
  project_id: string
  slug: string
  title: string
  description: string
  author: string
  icon_url: string | null
  downloads: number
  follows: number
  categories: string[]
  date_modified: string
}

export interface ResolvedModpackFile {
  url: string
  filename: string
  versionId: string
  versionNumber: string
}

export async function searchModrinthModpacks(query: string): Promise<ModpackHit[]> {
  const params = new URLSearchParams({
    query,
    facets: JSON.stringify([['project_type:modpack']]),
    limit: '20',
  })
  const res = await fetch(`https://api.modrinth.com/v2/search?${params}`, {
    headers: { 'User-Agent': 'YuyuFrame/1.0' },
  })
  if (!res.ok) throw new Error(`Modrinth: ${res.status}`)
  const data = await res.json()
  return data.hits as ModpackHit[]
}

/// Résout la dernière version .mrpack disponible pour un modpack donné.
export async function resolveModpackFile(projectId: string): Promise<ResolvedModpackFile | null> {
  const res = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version`, {
    headers: { 'User-Agent': 'YuyuFrame/1.0' },
  })
  if (!res.ok) return null
  const versions = await res.json() as Array<{
    id: string
    version_number: string
    files: Array<{ url: string; filename: string; primary: boolean }>
  }>
  const version = versions[0]
  if (!version) return null
  const file = version.files.find((f) => f.primary) ?? version.files[0]
  if (!file) return null
  return { url: file.url, filename: file.filename, versionId: version.id, versionNumber: version.version_number }
}

export function formatRelativeDate(iso: string | null): string {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  const days = Math.floor(diffMs / 86_400_000)
  if (days <= 0) return "aujourd'hui"
  if (days === 1) return 'hier'
  if (days < 7) return `il y a ${days} jours`
  if (days < 30) return `il y a ${Math.floor(days / 7)} semaine(s)`
  if (days < 365) return `il y a ${Math.floor(days / 30)} mois`
  return `il y a ${Math.floor(days / 365)} an(s)`
}

export function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}
