import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/inter.css'
import './styles/app.css'
import './styles/summary.css'
import { LOCALE_STORAGE_KEY, UI_STORAGE_KEY } from './lib/runtime'
import { installViewportSizing } from './lib/viewport'

installViewportSizing()

async function start(): Promise<void> {
  if (import.meta.env.MODE === 'demo') {
    localStorage.removeItem(UI_STORAGE_KEY)
    localStorage.removeItem(LOCALE_STORAGE_KEY)
    const { installDemoRuntime } = await import('./demo/runtime')
    await installDemoRuntime()
  }

  const sharePage = location.pathname.startsWith('/s/')
  if (!sharePage)
    void import('./features/shell/AppShell')

  const [{ App }, i18n, session] = await Promise.all([
    import('./App'),
    import('./lib/i18n'),
    import('./store/session'),
  ])
  performance.mark('inkstone:modules-ready')
  if (!sharePage)
    void session.useSession.getState().load()
  await i18n.initI18n()
  performance.mark('inkstone:i18n-ready')
  const container = document.getElementById('root')
  if (!container) throw new Error(i18n.t("app.missing_root_mount_point"))
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void start()
