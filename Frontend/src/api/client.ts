import { invoke } from '@tauri-apps/api/core'
import type { AuthStatus, DeviceAuthResponse, Instance, Mod, ModpackMeta, PollResponse, SaveInfo, StatsData, SyncInstance, Version } from '@/types'

// ── Types ────────────────────────────────────────────────────────────────────

export interface YuyuStatusResp {
  has_account: boolean
}

export interface YuyuLoginResp {
  token: string
  username: string
  plan: string
  plan_expires_at: number | null
  accounts: McAccountInfo[]
}

export interface YuyuPlanResp {
  plan: string
  plan_expires_at: number | null
}

export interface YuyuCheckoutResp {
  checkout_url: string
}

export interface McAccountInfo {
  mc_username: string
  mc_uuid: string
  is_active: boolean
}

// ── API ──────────────────────────────────────────────────────────────────────

export const api = {
  versions: {
    list: () => invoke<Version[]>('list_versions'),
  },

  instances: {
    list: () => invoke<Instance[]>('instance_list'),
    create: (name: string, mc_version: string, loader: string, ram_mb: number, description?: string) =>
      invoke<Instance>('instance_create', { name, mcVersion: mc_version, loader, ramMb: ram_mb, description }),
    delete: (id: string) => invoke<void>('instance_delete', { id }),
    update: (id: string, name: string, mc_version: string, loader: string, ram_mb: number, description?: string) =>
      invoke<Instance>('instance_update', { id, name, mcVersion: mc_version, loader, ramMb: ram_mb, description }),
    duplicate: (sourceId: string, name: string, mc_version: string, ram_mb: number) =>
      invoke<Instance>('instance_duplicate', { sourceId, name, mcVersion: mc_version, ramMb: ram_mb }),
    toggleFavorite: (id: string) => invoke<Instance>('instance_toggle_favorite', { id }),
    startupSync: (mode: string) => invoke<void>('instance_startup_sync', { mode }),
  },

  yuyu: {
    status: () => invoke<YuyuStatusResp>('yuyu_status'),
    register: (username: string, password: string) =>
      invoke<YuyuLoginResp>('yuyu_register', { username, password }),
    login: (username: string, password: string) =>
      invoke<YuyuLoginResp>('yuyu_login', { username, password }),
    logout: () => invoke<void>('yuyu_logout'),
    refreshPlan: () => invoke<YuyuPlanResp>('yuyu_refresh_plan'),
    createCheckout: (plan: string) =>
      invoke<YuyuCheckoutResp>('yuyu_create_checkout', { plan }),
    devSimulatePayment: (plan: string) =>
      invoke<YuyuPlanResp>('yuyu_dev_simulate_payment', { plan }),
  },

  auth: {
    status: () => invoke<AuthStatus>('auth_status'),
    startDevice: () => invoke<DeviceAuthResponse>('auth_start_device'),
    poll: () => invoke<PollResponse>('auth_poll'),
    logout: () => invoke<void>('auth_logout'),
  },

  mc: {
    accounts: () => invoke<McAccountInfo[]>('mc_list_accounts'),
    switch: (uuid: string) => invoke<McAccountInfo>('mc_switch', { uuid }),
    delete: (uuid: string) => invoke<void>('mc_delete', { uuid }),
  },

  launch: {
    start: (instanceId: string, avoidBeta = true) =>
      invoke<void>('launch_game', { instanceId, avoidBeta }),
    startP2p: (instanceId: string, avoidBeta = true) =>
      invoke<void>('launch_game', { instanceId, p2p: true, avoidBeta }),
    reloadAgent: () =>
      invoke<void>('reload_agent'),
  },

  sync: {
    list: () => invoke<SyncInstance[]>('sync_list_instances'),
    listSaves: (instanceId: string) =>
      invoke<SaveInfo[]>('sync_list_saves', { instanceId }),
    push: (instanceId: string, saveNames: string[]) =>
      invoke<SyncInstance>('sync_push_instance', { instanceId, saveNames }),
    pull: (syncId: number, instanceId: string) =>
      invoke<void>('sync_pull_instance', { syncId, instanceId }),
    delete: (syncId: number) =>
      invoke<void>('sync_delete_instance', { syncId }),
  },

  stats: {
    get: () => invoke<StatsData>('stats_get'),
  },

  mods: {
    list: (instanceId: string) => invoke<Mod[]>('mods_list', { instanceId }),
    toggle: (instanceId: string, name: string) =>
      invoke<Mod>('mods_toggle', { instanceId, name }),
    delete: (instanceId: string, name: string) =>
      invoke<void>('mods_delete', { instanceId, name }),
    install: (instanceId: string, url: string, filename: string) =>
      invoke<Mod>('mods_install', { instanceId, url, filename }),

    upload: async (instanceId: string, file: File): Promise<Mod> => {
      const data = Array.from(new Uint8Array(await file.arrayBuffer()))
      return invoke<Mod>('mods_upload', { instanceId, filename: file.name, data })
    },

    icon: (instanceId: string, name: string) =>
      invoke<string>('mod_icon', { instanceId, name }),

    importOptifine: (instanceId: string) =>
      invoke<Mod>('mods_import_optifine', { instanceId }),

    checkUpdateSafety: (
      instanceId: string,
      mcVersion: string,
      loader: string,
      candidates: Array<{ name: string; newVersion: string }>,
    ) => invoke<Array<{ name: string; safe: boolean; blockedBy: string[] }>>(
      'mods_check_update_safety', { instanceId, mcVersion, loader, candidates },
    ),
  },

  modpacks: {
    fetchIndex: (fileUrl: string) =>
      invoke<{ mc_version: string | null; loader: string }>('modpack_fetch_index', { fileUrl }),
    install: (input: {
      instanceId: string
      fileUrl: string
      projectId: string
      versionId: string
      name: string
      author: string
      summary: string
      iconUrl: string | null
      versionNumber: string
      downloads: number
      dateModified: string | null
      categories: string[]
    }) => invoke<ModpackMeta>('modpack_install', { input }),
    getMeta: (instanceId: string) => invoke<ModpackMeta | null>('modpack_get_meta', { instanceId }),
    remove: (instanceId: string) => invoke<void>('modpack_remove', { instanceId }),
    renameFile: (instanceId: string, oldName: string, newName: string) =>
      invoke<ModpackMeta | null>('modpack_rename_file', { instanceId, oldName, newName }),
  },
}
