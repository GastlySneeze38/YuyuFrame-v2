import type { Loader } from '@/types'

/// Soit un slug Modrinth (résolu via l'API au moment de l'install), soit une
/// URL directe — utile pour un mod tout juste publié/pas encore indexé par
/// la recherche Modrinth, ou hébergé ailleurs.
export interface DirectModFile {
  url: string
  filename: string
}

export interface InstancePreset {
  id: string
  name: string
  description: string
  emoji: string
  mcVersion: string
  loader: Loader
  ramMb: number
  /// Slugs Modrinth (project slug ou id) ou fichiers en URL directe,
  /// installés automatiquement à la création.
  mods: (string | DirectModFile)[]
}

// ── Liste des presets — modifiable ici sans toucher au reste du code ───────────
// Pour ajouter un preset : copier un objet ci-dessous, changer les champs.
// `mods` attend des slugs Modrinth (visibles dans l'URL du mod, ex: modrinth.com/mod/<slug>).
export const INSTANCE_PRESETS: InstancePreset[] = [
  {
    id: 'vanilla-plus',
    name: 'Vanilla+',
    description: 'Qualité de vie minimale, fidèle au vanilla',
    emoji: '🌿',
    mcVersion: '1.21.11',
    loader: 'fabric',
    ramMb: 4096,
    mods: ['fabric-api', 'sodium', 'lithium', 'modmenu'],
  },
  {
    id: 'performance',
    name: 'Perf',
    description: 'FPS boost maximal, idéal PC modeste',
    emoji: '⚡',
    mcVersion: '1.21.11',
    loader: 'fabric',
    ramMb: 4096,
    mods: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'modmenu', 'Iris Shaders', 'boby'],
  },
  {
    id: 'performance-plus',
    name: 'Perf+',
    description: 'FPS boost maximal, idéal PC modeste',
    emoji: '⚡',
    mcVersion: '1.21.11',
    loader: 'fabric',
    ramMb: 4096,
    mods: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'modmenu', 'Iris Shaders', 'boby', 'voxy'],
  },
  {
    id: 'Confort',
    name: 'Confort',
    description: 'All the Mods you need',
    emoji: '',
    mcVersion: '1.21.11',
    loader: 'fabric',
    ramMb: 6144,
    mods: ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'modmenu', 'Iris Shaders', 'boby', 'voxy', 'Simple Voice Chat', 'Widget', 'wWaypoint', 'FullBright', 'Zoomify', 'Litematica'],
  },
]

// ── Preset PvP 1.8.9 — utilisé par le bouton dédié "Instance PvP" ─────────────
// Volontairement absent de INSTANCE_PRESETS : ce preset n'est jamais affiché
// dans la modale de création, il est installé silencieusement en un clic.
export const PVP_PRESET: InstancePreset = {
  id: 'pvp-1.8.9',
  name: 'PvP 1.8.9',
  description: 'Confort PvP 1.8.9',
  emoji: '⚔️',
  mcVersion: '1.8.9',
  loader: 'forge',
  ramMb: 4096,
  // Uniquement des mods nativement configurables depuis l'interface OneConfig
  // (apportée par "polysprint") — tout se règle dans le même menu façon Lunar.
  // Exclus volontairement : "hippo-keystrokes", "item-scroller", "minihud",
  // "neat" (mods Forge classiques, pas d'API OneConfig), "quickconfig"
  // (archivé, buggé) et "hitspan" (licence All-Rights-Reserved — pas
  // redistribuable/installable proprement, voir discussion licences).
  mods: [
    'polysprint',
    'essential',
    'overflowparticles',
    'rawinput',
    'legacy-chunk-borders-forge',
    'chat-oneconfig',
    'environment',
    'patcher', // PolyPatcher — optimisations (entity culling, rendu) en alternative légale à OptiFine
    'animatium-legacy', // OverflowAnimations — restaure les animations de combat 1.7 (blocage épée plus fluide)
    'borderlessfullscreen', // dérivé du mod de Sk1er (Lunar) — plein écran sans bordure façon Badlion/Lunar, plus fluide qu'un plein écran exclusif sur Windows moderne

    // YuyuPvP — notre propre mod (keystrokes, FPS, ping, FOV, hurt cam,
    // crosshair, teinte vie basse...). URL directe en attendant que le
    // projet soit indexé par la recherche Modrinth (juste publié).
    {
      url: 'https://cdn.modrinth.com/data/LF5EOXyf/versions/jw32eLZT/YuyuPvP-1.8.9-forge-0.1.0.jar?mr_download_reason=standalone',
      filename: 'YuyuPvP-1.8.9-forge-0.1.0.jar',
    },
  ],
}
