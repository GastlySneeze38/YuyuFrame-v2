import { getCurrentWindow } from '@tauri-apps/api/window'
import { useStore } from '@/stores/useStore'

const win = getCurrentWindow()

export function TitleBar() {
  const { theme, toggleTheme, username } = useStore()

  const minimize = () => win.minimize()
  const maximize = () => win.toggleMaximize()
  const close = () => win.close()

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 flex-shrink-0 items-center justify-between px-4"
      style={{ background: '#09090D', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2">
        <div className="h-3.5 w-3.5 rounded-sm" style={{ background: '#4B3FCF' }} />
        <span className="text-xs font-bold tracking-widest" style={{ color: 'rgba(255,255,255,0.5)', letterSpacing: '0.2em' }}>
          YUYUFRAME
        </span>
      </div>

      {/* Center: user info + theme toggle */}
      <div className="flex items-center gap-3">
        {username && (
          <span className="text-xs" style={{ color: 'rgba(255,255,255,0.28)' }}>
            {username}
          </span>
        )}
      </div>

      {/* Window controls */}
      <div className="flex items-center gap-0.5">
        {/* Minimize */}
        <button
          onClick={minimize}
          className="flex h-7 w-7 items-center justify-center rounded transition-all duration-150"
          style={{ color: 'rgba(190,70,70,0.45)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(180,60,60,0.18)'
            e.currentTarget.style.color = 'rgba(220,90,90,0.85)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = 'rgba(190,70,70,0.45)'
          }}
        >
          <svg width="10" height="2" viewBox="0 0 10 2" fill="currentColor">
            <rect width="10" height="1.5" y="0.25" />
          </svg>
        </button>
        {/* Maximize */}
        <button
          onClick={maximize}
          className="flex h-7 w-7 items-center justify-center rounded transition-all duration-150"
          style={{ color: 'rgba(255,255,255,0.18)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.07)'
            e.currentTarget.style.color = 'rgba(255,255,255,0.45)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = 'rgba(255,255,255,0.18)'
          }}
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="8" height="8" />
          </svg>
        </button>
        {/* Close */}
        <button
          onClick={close}
          className="flex h-7 w-7 items-center justify-center rounded transition-all duration-150"
          style={{ color: 'rgba(225,60,60,0.65)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(220,45,45,0.22)'
            e.currentTarget.style.color = 'rgb(245,80,80)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = 'rgba(225,60,60,0.65)'
          }}
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="0.5" y1="0.5" x2="8.5" y2="8.5" />
            <line x1="8.5" y1="0.5" x2="0.5" y2="8.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
