import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildKeybindingEntries,
  DEFAULT_KEYBINDINGS,
  eventMatchesBinding,
  findBinding,
  KEYBINDING_ACTION_IDS,
  KEYBINDING_CONFIG,
  KEYBINDINGS_PREF_KEY,
  loadCustomKeybindings,
  saveCustomKeybindings,
} from '../src/lib/keybindings'

const mockOpenPiPrefs = (initial: Record<string, string | null> = {}) => {
  const prefs = new Map<string, string | null>(Object.entries(initial))
  const getPref = vi.fn((key: string) => Promise.resolve(prefs.get(key) ?? null))
  const setPref = vi.fn((key: string, value: string) => {
    prefs.set(key, value)
    return Promise.resolve()
  })

  Object.defineProperty(window, 'openpi', {
    configurable: true,
    value: { getPref, setPref },
  })

  return { getPref, setPref, prefs }
}

describe('keybindings config', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('keeps action ids, config entries, and default entries in exact parity', () => {
    const actionIds = [...KEYBINDING_ACTION_IDS]
    const configIds = Object.keys(KEYBINDING_CONFIG)
    const defaultIds = DEFAULT_KEYBINDINGS.map((entry) => entry.id)

    expect(new Set(actionIds).size).toBe(actionIds.length)
    expect(configIds.sort()).toEqual([...actionIds].sort())
    expect(defaultIds).toEqual(actionIds)
    expect(DEFAULT_KEYBINDINGS).toHaveLength(actionIds.length)
  })

  it('builds one runtime entry for every configured action id', () => {
    const entries = buildKeybindingEntries({
      toggleSidebar: 'Alt+B',
      clearInput: 'Unassigned',
    })

    expect(entries.map((entry) => entry.id)).toEqual([...KEYBINDING_ACTION_IDS])
    expect(findBinding(entries, 'toggleSidebar')).toBe('Alt+B')
    expect(findBinding(entries, 'clearInput')).toBe('Unassigned')
    expect(entries.find((entry) => entry.id === 'toggleSidebar')?.isModified).toBe(true)
    expect(entries.find((entry) => entry.id === 'newSession')?.keys).toBe(
      KEYBINDING_CONFIG.newSession.defaultKeys
    )
  })

  it('matches keyboard events against configured bindings after normalization', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      shiftKey: true,
    })

    expect(eventMatchesBinding(event, 'Shift+Ctrl+B')).toBe(true)
    expect(eventMatchesBinding(event, 'Ctrl+Shift+B')).toBe(true)
    expect(eventMatchesBinding(event, 'Unassigned')).toBe(false)
  })

  it('loads only known persisted keybinding overrides', async () => {
    mockOpenPiPrefs({
      [KEYBINDINGS_PREF_KEY]: JSON.stringify({
        toggleSidebar: 'Ctrl+B',
        unknownAction: 'Cmd+U',
      }),
    })

    await expect(loadCustomKeybindings()).resolves.toEqual({
      toggleSidebar: 'Ctrl+B',
    })
  })

  it('sanitizes saved overrides and dispatches the sanitized change event', async () => {
    const { setPref } = mockOpenPiPrefs()
    const listener = vi.fn()
    window.addEventListener('openpi:keybindings-changed', listener)

    await saveCustomKeybindings({
      toggleSidebar: 'Ctrl+B',
      unknownAction: 'Cmd+U',
    } as Parameters<typeof saveCustomKeybindings>[0])

    expect(setPref).toHaveBeenCalledWith(
      KEYBINDINGS_PREF_KEY,
      JSON.stringify({ toggleSidebar: 'Ctrl+B' })
    )
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { toggleSidebar: 'Ctrl+B' } })
    )

    window.removeEventListener('openpi:keybindings-changed', listener)
  })
})
