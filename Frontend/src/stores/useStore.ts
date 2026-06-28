import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Instance, Version, Account } from '@/types'

export type YuyuPlan = 'free' | 'premium' | 'ultimate'

interface Store {
  // ── YuyuFrame session (NOT persisted — requires password on each start) ──
  yuyuToken: string | null
  yuyuUsername: string | null
  yuyuPlan: YuyuPlan
  yuyuPlanExpiresAt: number | null
  setYuyuSession: (token: string, username: string, plan: YuyuPlan, planExpiresAt: number | null) => void
  setYuyuPlan: (plan: YuyuPlan, planExpiresAt: number | null) => void
  clearYuyuSession: () => void
  isPremium: () => boolean
  isUltimate: () => boolean

  // ── Active Minecraft account ───────────────────────────────────────────────
  username: string | null
  uuid: string | null
  setUser: (username: string, uuid: string) => void
  clearUser: () => void

  // ── Minecraft account list ─────────────────────────────────────────────────
  accounts: Account[]
  setAccounts: (accounts: Account[]) => void
  addAccount: (username: string, uuid: string) => void
  removeAccount: (uuid: string) => void
  switchAccount: (uuid: string) => void

  // ── Versions (for instance creation) ──────────────────────────────────────
  versions: Version[]
  setVersions: (v: Version[]) => void

  // ── Instances ─────────────────────────────────────────────────────────────
  instances: Instance[]
  setInstances: (instances: Instance[]) => void
  addInstance: (instance: Instance) => void
  updateInstance: (instance: Instance) => void
  removeInstance: (id: string) => void

  selectedInstanceId: string | null
  setSelectedInstanceId: (id: string | null) => void
  selectedInstance: () => Instance | null

  // ── Settings (persisted) ──────────────────────────────────────────────────
  defaultRam: number
  setDefaultRam: (r: number) => void

  closeOnLaunch: boolean
  setCloseOnLaunch: (v: boolean) => void

  p2pEnabled: boolean
  setP2pEnabled: (v: boolean) => void

  brightness: number
  setBrightness: (b: number) => void

  instanceSyncMode: 'db_wins' | 'disk_wins'
  setInstanceSyncMode: (mode: 'db_wins' | 'disk_wins') => void

  avoidBetaDependencies: boolean
  setAvoidBetaDependencies: (v: boolean) => void

  // ── Game state (par instance) ─────────────────────────────────────────────
  runningInstances: string[]
  isInstanceRunning: (id: string) => boolean
  setInstanceRunning: (id: string, running: boolean) => void
  /** true si au moins une instance tourne (rétro-compat) */
  gameRunning: boolean
  setGameRunning: (r: boolean) => void

  // ── Last session ───────────────────────────────────────────────────────────
  lastSession: { instanceName: string; at: string } | null
  setLastSession: (s: { instanceName: string; at: string }) => void
}

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      // YuyuFrame session
      yuyuToken: null,
      yuyuUsername: null,
      yuyuPlan: 'free',
      yuyuPlanExpiresAt: null,
      setYuyuSession: (token, username, plan, planExpiresAt) =>
        set({ yuyuToken: token, yuyuUsername: username, yuyuPlan: plan, yuyuPlanExpiresAt: planExpiresAt }),
      setYuyuPlan: (plan, planExpiresAt) =>
        set({ yuyuPlan: plan, yuyuPlanExpiresAt: planExpiresAt }),
      clearYuyuSession: () =>
        set({ yuyuToken: null, yuyuUsername: null, yuyuPlan: 'free', yuyuPlanExpiresAt: null, accounts: [], username: null, uuid: null }),
      isPremium: () => {
        const { yuyuPlan, yuyuPlanExpiresAt } = get()
        const active = yuyuPlan === 'premium' || yuyuPlan === 'ultimate'
        const notExpired = yuyuPlanExpiresAt === null || yuyuPlanExpiresAt > Date.now() / 1000
        return active && notExpired
      },
      isUltimate: () => {
        const { yuyuPlan, yuyuPlanExpiresAt } = get()
        const notExpired = yuyuPlanExpiresAt === null || yuyuPlanExpiresAt > Date.now() / 1000
        return yuyuPlan === 'ultimate' && notExpired
      },

      // Active MC account
      username: null,
      uuid: null,
      setUser: (username, uuid) => set({ username, uuid }),
      clearUser: () => set({ username: null, uuid: null }),

      // MC account list
      accounts: [],
      setAccounts: (accounts) => set({ accounts }),
      addAccount: (username, uuid) => {
        const accounts = get().accounts
        const idx = accounts.findIndex((a) => a.uuid === uuid)
        const unlimited = get().isPremium()
        const next =
          idx >= 0
            ? accounts.map((a, i) => (i === idx ? { username, uuid } : a))
            : unlimited || accounts.length < 2
            ? [...accounts, { username, uuid }]
            : accounts
        set({ accounts: next, username, uuid })
      },
      removeAccount: (targetUuid) => {
        const accounts = get().accounts.filter((a) => a.uuid !== targetUuid)
        if (get().uuid === targetUuid) {
          const other = accounts[0] ?? null
          set({ accounts, username: other?.username ?? null, uuid: other?.uuid ?? null })
        } else {
          set({ accounts })
        }
      },
      switchAccount: (targetUuid) => {
        const account = get().accounts.find((a) => a.uuid === targetUuid)
        if (account) set({ username: account.username, uuid: account.uuid })
      },

      // Versions
      versions: [],
      setVersions: (versions) => set({ versions }),

      // Instances
      instances: [],
      setInstances: (instances) => set({ instances }),
      addInstance: (instance) => set((s) => ({ instances: [...s.instances, instance] })),
      updateInstance: (instance) =>
        set((s) => ({
          instances: s.instances.map((i) => (i.id === instance.id ? instance : i)),
        })),
      removeInstance: (id) =>
        set((s) => ({
          instances: s.instances.filter((i) => i.id !== id),
          selectedInstanceId: s.selectedInstanceId === id ? null : s.selectedInstanceId,
        })),

      selectedInstanceId: null,
      setSelectedInstanceId: (id) => set({ selectedInstanceId: id }),
      selectedInstance: () => {
        const { instances, selectedInstanceId } = get()
        return instances.find((i) => i.id === selectedInstanceId) ?? null
      },

      // Settings
      defaultRam: 4096,
      setDefaultRam: (defaultRam) => set({ defaultRam }),

      closeOnLaunch: false,
      setCloseOnLaunch: (closeOnLaunch) => set({ closeOnLaunch }),

      p2pEnabled: false,
      setP2pEnabled: (p2pEnabled) => set({ p2pEnabled }),

      brightness: 100,
      setBrightness: (brightness) => set({ brightness }),

      instanceSyncMode: 'db_wins',
      setInstanceSyncMode: (instanceSyncMode) => set({ instanceSyncMode }),

      avoidBetaDependencies: true,
      setAvoidBetaDependencies: (avoidBetaDependencies) => set({ avoidBetaDependencies }),

      // Game (multi-instance)
      runningInstances: [],
      isInstanceRunning: (id) => get().runningInstances.includes(id),
      setInstanceRunning: (id, running) =>
        set((s) => ({
          runningInstances: running
            ? s.runningInstances.includes(id) ? s.runningInstances : [...s.runningInstances, id]
            : s.runningInstances.filter((x) => x !== id),
          gameRunning: running ? true : s.runningInstances.filter((x) => x !== id).length > 0,
        })),
      gameRunning: false,
      setGameRunning: (gameRunning) => set({ gameRunning }),

      // Last session
      lastSession: null,
      setLastSession: (lastSession) => set({ lastSession }),
    }),
    {
      name: 'yuyuframe-store',
      partialize: (s) => ({
        selectedInstanceId: s.selectedInstanceId,
        defaultRam: s.defaultRam,
        closeOnLaunch: s.closeOnLaunch,
        p2pEnabled: s.p2pEnabled,
        brightness: s.brightness,
        instanceSyncMode: s.instanceSyncMode,
        avoidBetaDependencies: s.avoidBetaDependencies,
        username: s.username,
        uuid: s.uuid,
        lastSession: s.lastSession,
      }),
    }
  )
)
