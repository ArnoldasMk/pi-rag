import { BrowserWindow, session } from 'electron'

/**
 * In-app embedded AI web clients (ChatGPT, Claude.ai).
 *
 * Intentionally browser-login based: no API keys, no token reuse, no cookie
 * extraction. Each client gets its own persistent Electron partition so logins
 * stay local to pi-rag and survive restarts. These are plain web clients — not
 * agent providers — so they are reliable and low-maintenance.
 */

export type WebClientId = 'chatgpt' | 'claude'

interface WebClientConfig {
  url: string
  title: string
  partition: string
  /** First-party origins that should stay inside this window (incl. OAuth). */
  internalOrigins: string[]
}

const CLIENTS: Record<WebClientId, WebClientConfig> = {
  chatgpt: {
    url: 'https://chatgpt.com/',
    title: 'ChatGPT — Pi RAG',
    partition: 'persist:pi-rag-chatgpt',
    internalOrigins: ['https://chatgpt.com/', 'https://auth.openai.com/'],
  },
  claude: {
    url: 'https://claude.ai/',
    title: 'Claude — Pi RAG',
    partition: 'persist:pi-rag-claude',
    internalOrigins: [
      'https://claude.ai/',
      'https://www.claude.ai/',
      'https://auth.anthropic.com/',
      'https://accounts.anthropic.com/',
    ],
  },
}

const windows = new Map<WebClientId, BrowserWindow>()

export function openWebClient(id: WebClientId, parent?: BrowserWindow | null): void {
  const config = CLIENTS[id]
  if (!config) return

  const existing = windows.get(id)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }

  const ses = session.fromPartition(config.partition)

  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: config.title,
    parent: parent ?? undefined,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: config.partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: true,
    },
  })

  windows.set(id, win)

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => windows.delete(id))

  // Keep first-party navigation (and OAuth) inside the client window; send
  // any third-party links to the user's default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (config.internalOrigins.some((origin) => url.startsWith(origin))) {
      win.loadURL(url).catch(() => undefined)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  void ses.cookies.flushStore().finally(() => {
    void win.loadURL(config.url)
  })
}
