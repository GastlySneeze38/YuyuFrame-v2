import { useEffect } from 'react'
import { Navigate, Route, Routes, useNavigate, useLocation } from 'react-router-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { TitleBar } from '@/components/TitleBar'
import Login from '@/pages/Login'
import Home from '@/pages/Home'
import Instances from '@/pages/Instances'
import Mods from '@/pages/Mods'
import Settings from '@/pages/Settings'
import Information from '@/pages/Information'
import YuyuLogin from '@/pages/YuyuLogin'
import Console from '@/pages/Console'
import Sync from '@/pages/Sync'
import Plans from '@/pages/Plans'
import Stats from '@/pages/Stats'
import Server from '@/pages/Server'
import { useStore } from '@/stores/useStore'
import { api } from '@/api/client'

const isConsoleWindow = getCurrentWindow().label.startsWith('mc-console-')

function AuthGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { yuyuToken } = useStore()

  useEffect(() => {
    if (!yuyuToken && pathname !== '/yuyu') {
      navigate('/yuyu', { replace: true })
    }
  }, [yuyuToken, pathname])

  return <>{children}</>
}

export default function App() {
  const { brightness, instanceSyncMode, setInstances } = useStore()

  useEffect(() => {
    if (isConsoleWindow) return
    api.instances.startupSync(instanceSyncMode)
      .then(() => api.instances.list())
      .then(setInstances)
      .catch(() => {})
  }, [])

  if (isConsoleWindow) {
    return <Console />
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-primary">
      <TitleBar />
      <div className="flex-1 overflow-hidden" style={{ filter: `brightness(${brightness / 100})` }}>
        <Routes>
          {/* YuyuFrame account gate — always accessible */}
          <Route path="/yuyu" element={<YuyuLogin />} />

          {/* Protected routes */}
          <Route
            path="/*"
            element={
              <AuthGuard>
                <Routes>
                  <Route path="/" element={<Navigate to="/home" replace />} />
                  <Route path="/home" element={<Home />} />
                  <Route path="/login" element={<Login />} />
                  <Route path="/instances" element={<Instances />} />
                  <Route path="/mods" element={<Mods />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/information" element={<Information />} />
                  <Route path="/sync" element={<Sync />} />
                  <Route path="/plans" element={<Plans />} />
                  <Route path="/stats" element={<Stats />} />
                  <Route path="/server" element={<Server />} />
                </Routes>
              </AuthGuard>
            }
          />
        </Routes>
      </div>
    </div>
  )
}
