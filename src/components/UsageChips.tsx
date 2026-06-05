/**
 * UsageChips — compact subscription usage indicators for the top bar.
 *
 * Shows remaining quota for connected Claude / ChatGPT / Copilot subscriptions
 * next to the workspace name. Data comes from the Pi OAuth tokens via the
 * main-process usage host (electron/services/usageHost.ts).
 */
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { ProviderUsage } from '../lib/ipc'

// Network sync is infrequent to avoid provider rate limits (Anthropic 429s on
// frequent polling). Between syncs the reset countdown is recomputed locally
// from each window's absolute resetAt, so the time-left still ticks down live.
const SYNC_MS = 5 * 60_000
const TICK_MS = 30_000

/** Format a remaining duration (ms) as a compact countdown e.g. "3h12m". */
function formatRemaining(ms: number): string {
  if (ms <= 0) return 'now'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return m > 0 ? `${h}h${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh > 0 ? `${d}d${rh}h` : `${d}d`
}

/** Live countdown from a window's absolute reset time, falling back to the
 *  server-computed description when no absolute timestamp is available. */
function liveReset(
  win: { resetAt?: string; resetDescription?: string },
  nowMs: number
): string | undefined {
  if (win.resetAt) {
    const t = Date.parse(win.resetAt)
    if (!Number.isNaN(t)) return formatRemaining(t - nowMs)
  }
  return win.resetDescription
}

/** Pick the most-constrained window (highest used percent) for the chip. */
function tightestWindow(usage: ProviderUsage) {
  if (usage.windows.length === 0) return undefined
  return usage.windows.reduce((max, w) => (w.usedPercent > max.usedPercent ? w : max))
}

function chipLabel(usage: ProviderUsage): string {
  if (usage.requestsRemaining !== undefined && usage.requestsEntitlement !== undefined) {
    return `${usage.requestsRemaining}/${usage.requestsEntitlement} left`
  }
  const win = tightestWindow(usage)
  if (!win) return usage.error ? '—' : '…'
  const remaining = Math.max(0, Math.round(100 - win.usedPercent))
  return `${remaining}%`
}

/** Reset countdown for the most-constrained window, e.g. "3h12m". */
function chipReset(usage: ProviderUsage, nowMs: number): string | undefined {
  const win = tightestWindow(usage)
  return win ? liveReset(win, nowMs) : undefined
}

function chipTitle(usage: ProviderUsage, nowMs: number): string {
  if (usage.error && usage.windows.length === 0) return `${usage.displayName}: ${usage.error}`
  const parts = usage.windows.map((w) => {
    const remaining = Math.max(0, Math.round(100 - w.usedPercent))
    const r = liveReset(w, nowMs)
    const reset = r ? ` · resets ${r}` : ''
    return `${w.label}: ${remaining}% left${reset}`
  })
  if (usage.stale) parts.push('(cached — last good sync)')
  if (usage.requestsRemaining !== undefined && usage.requestsEntitlement !== undefined) {
    parts.unshift(`${usage.requestsRemaining}/${usage.requestsEntitlement} premium requests left`)
  }
  return `${usage.displayName}\n${parts.join('\n') || 'no quota data'}`
}

/** Worst-case remaining percent → severity class for color. */
function severity(usage: ProviderUsage): 'ok' | 'warn' | 'crit' {
  const win = tightestWindow(usage)
  const remaining = win ? 100 - win.usedPercent : 100
  if (remaining <= 10) return 'crit'
  if (remaining <= 25) return 'warn'
  return 'ok'
}

export function UsageChips() {
  const [usage, setUsage] = createSignal<ProviderUsage[]>([])
  const [now, setNow] = createSignal(Date.now())
  let syncTimer: ReturnType<typeof setInterval> | undefined
  let tickTimer: ReturnType<typeof setInterval> | undefined

  const refresh = async () => {
    try {
      const data = await window.openpi.getProviderUsage()
      setUsage(data)
    } catch {
      // Leave previous value; transient failures are non-fatal.
    }
  }

  onMount(() => {
    void refresh()
    // Network sync every 5 min; local countdown re-render every 30s.
    syncTimer = setInterval(() => void refresh(), SYNC_MS)
    tickTimer = setInterval(() => setNow(Date.now()), TICK_MS)
  })
  onCleanup(() => {
    clearInterval(syncTimer)
    clearInterval(tickTimer)
  })

  return (
    <Show when={usage().length > 0}>
      <span class="topbar-usage no-drag">
        <For each={usage()}>
          {(u) => (
            <span class={`topbar-usage-chip is-${severity(u)}`} title={chipTitle(u, now())}>
              <span class="topbar-usage-name">{u.shortName}</span>
              <span class="topbar-usage-val">{chipLabel(u)}</span>
              <Show when={chipReset(u, now())}>
                {(reset) => <span class="topbar-usage-reset">↻ {reset()}</span>}
              </Show>
            </span>
          )}
        </For>
      </span>
    </Show>
  )
}
