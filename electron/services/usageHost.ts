/**
 * usageHost.ts — Fetch subscription usage/quota for connected providers.
 *
 * Reads OAuth tokens from ~/.pi/agent/auth.json (written and refreshed by the
 * Pi SDK) and queries each provider's usage endpoint. Pure read-only; never
 * mutates auth state. Mirrors the endpoints used by the pi-usage extension.
 *
 * Supported subscriptions:
 *   - anthropic       → Claude Pro/Max     (api.anthropic.com/api/oauth/usage)
 *   - openai-codex    → ChatGPT Plus/Pro   (chatgpt.com/backend-api/wham/usage)
 *   - github-copilot  → Copilot            (api.github.com/copilot_internal/user)
 */

import fs from 'node:fs'
import path from 'node:path'
import { getAgentDir } from './shellEnv'

const API_TIMEOUT_MS = 5000

export type ProviderUsageId = 'anthropic' | 'codex' | 'copilot'

export interface UsageWindow {
  /** Short label e.g. "5h", "Week", "Month" */
  label: string
  /** 0–100 percent of the window consumed */
  usedPercent: number
  /** Human-friendly reset countdown e.g. "3h12m" (computed at fetch time) */
  resetDescription?: string
  /** Absolute reset time (ISO) so the UI can tick the countdown locally. */
  resetAt?: string
}

export interface ProviderUsage {
  id: ProviderUsageId
  displayName: string
  /** Short tag shown in the chip e.g. "Claude" */
  shortName: string
  connected: boolean
  windows: UsageWindow[]
  /** Copilot-style discrete request quota */
  requestsRemaining?: number
  requestsEntitlement?: number
  error?: string
  /** True when served from cache because the live fetch failed. */
  stale?: boolean
}

type AuthJson = Record<
  string,
  { access?: string; refresh?: string; accountId?: string; expires?: number | string } | undefined
>

function readAuthJson(): AuthJson {
  try {
    const authPath = path.join(getAgentDir(), 'auth.json')
    return JSON.parse(fs.readFileSync(authPath, 'utf-8')) as AuthJson
  } catch {
    return {}
  }
}

function formatReset(date: Date): string {
  const diffMs = date.getTime() - Date.now()
  if (diffMs < 0) return 'now'
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 60) return `${diffMins}m`
  const hours = Math.floor(diffMins / 60)
  const mins = diffMins % 60
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchAnthropic(auth: AuthJson): Promise<ProviderUsage> {
  const base: ProviderUsage = {
    id: 'anthropic',
    displayName: 'Claude Plan',
    shortName: 'Claude',
    connected: false,
    windows: [],
  }
  const token = auth.anthropic?.access
  if (!token) return base
  base.connected = true
  try {
    const res = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    })
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` }
    const data = (await res.json()) as {
      five_hour?: { utilization?: number; resets_at?: string }
      seven_day?: { utilization?: number; resets_at?: string }
    }
    const windows: UsageWindow[] = []
    if (data.five_hour?.utilization !== undefined) {
      const reset = data.five_hour.resets_at ? new Date(data.five_hour.resets_at) : undefined
      windows.push({
        label: '5h',
        usedPercent: data.five_hour.utilization,
        resetDescription: reset ? formatReset(reset) : undefined,
        resetAt: reset?.toISOString(),
      })
    }
    if (data.seven_day?.utilization !== undefined && data.seven_day !== null) {
      const reset = data.seven_day.resets_at ? new Date(data.seven_day.resets_at) : undefined
      windows.push({
        label: 'Week',
        usedPercent: data.seven_day.utilization,
        resetDescription: reset ? formatReset(reset) : undefined,
        resetAt: reset?.toISOString(),
      })
    }
    return { ...base, windows }
  } catch {
    return { ...base, error: 'fetch failed' }
  }
}

async function fetchCodex(auth: AuthJson): Promise<ProviderUsage> {
  const base: ProviderUsage = {
    id: 'codex',
    displayName: 'ChatGPT Plan',
    shortName: 'ChatGPT',
    connected: false,
    windows: [],
  }
  const entry = auth['openai-codex']
  const token = entry?.access
  if (!token) return base
  base.connected = true
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    if (entry?.accountId) headers['ChatGPT-Account-Id'] = entry.accountId
    const res = await fetchJson('https://chatgpt.com/backend-api/wham/usage', headers)
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` }
    const data = (await res.json()) as {
      rate_limit?: {
        primary_window?: { reset_at?: number; limit_window_seconds?: number; used_percent?: number }
        secondary_window?: {
          reset_at?: number
          limit_window_seconds?: number
          used_percent?: number
        }
      }
    }
    const windows: UsageWindow[] = []
    const pw = data.rate_limit?.primary_window
    if (pw) {
      const hours = Math.round((pw.limit_window_seconds || 10800) / 3600)
      const reset = pw.reset_at ? new Date(pw.reset_at * 1000) : undefined
      windows.push({
        label: `${hours}h`,
        usedPercent: pw.used_percent || 0,
        resetDescription: reset ? formatReset(reset) : undefined,
        resetAt: reset?.toISOString(),
      })
    }
    const sw = data.rate_limit?.secondary_window
    if (sw) {
      const hours = Math.round((sw.limit_window_seconds || 86400) / 3600)
      const label = hours >= 144 ? 'Week' : hours >= 24 ? 'Day' : `${hours}h`
      const reset = sw.reset_at ? new Date(sw.reset_at * 1000) : undefined
      windows.push({
        label,
        usedPercent: sw.used_percent || 0,
        resetDescription: reset ? formatReset(reset) : undefined,
        resetAt: reset?.toISOString(),
      })
    }
    return { ...base, windows }
  } catch {
    return { ...base, error: 'fetch failed' }
  }
}

async function fetchCopilot(auth: AuthJson): Promise<ProviderUsage> {
  const base: ProviderUsage = {
    id: 'copilot',
    displayName: 'Copilot Plan',
    shortName: 'Copilot',
    connected: false,
    windows: [],
  }
  const entry = auth['github-copilot']
  const token = entry?.refresh || entry?.access
  if (!token) return base
  base.connected = true
  try {
    const res = await fetchJson('https://api.github.com/copilot_internal/user', {
      'Editor-Version': 'vscode/1.96.2',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'X-Github-Api-Version': '2025-04-01',
      Accept: 'application/json',
      Authorization: `token ${token}`,
    })
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` }
    const data = (await res.json()) as {
      quota_reset_date_utc?: string
      quota_snapshots?: {
        premium_interactions?: {
          percent_remaining?: number
          remaining?: number
          entitlement?: number
        }
      }
    }
    const windows: UsageWindow[] = []
    const pi = data.quota_snapshots?.premium_interactions
    if (pi) {
      const reset = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined
      windows.push({
        label: 'Month',
        usedPercent: Math.max(0, 100 - (pi.percent_remaining || 0)),
        resetDescription: reset ? formatReset(reset) : undefined,
        resetAt: reset?.toISOString(),
      })
      return {
        ...base,
        windows,
        requestsRemaining: pi.remaining ?? undefined,
        requestsEntitlement: pi.entitlement ?? undefined,
      }
    }
    return { ...base, windows }
  } catch {
    return { ...base, error: 'fetch failed' }
  }
}

// ── Caching ────────────────────────────────────────────────────────────────────
// Network sync happens at most once per TTL. Repeated IPC calls inside the
// window are served from memory so we never hammer the provider usage endpoints
// (Anthropic in particular rate-limits aggressively → 429). The renderer ticks
// the reset countdown locally from each window's absolute resetAt, so the UI
// still feels live between syncs.
const SYNC_TTL_MS = 5 * 60 * 1000

let cachedResult: ProviderUsage[] | null = null
let cachedAt = 0
const lastGood = new Map<ProviderUsageId, ProviderUsage>()
let diskCacheLoaded = false

function usageCachePath(): string {
  return path.join(getAgentDir(), 'provider-usage-cache.json')
}

function loadDiskCache(): void {
  if (diskCacheLoaded) return
  diskCacheLoaded = true
  try {
    const raw = JSON.parse(fs.readFileSync(usageCachePath(), 'utf-8')) as {
      providers?: ProviderUsage[]
    }
    for (const usage of raw.providers ?? []) {
      if (usage.connected && !usage.error && usage.windows.length > 0) {
        lastGood.set(usage.id, usage)
      }
    }
  } catch {
    // no cache yet
  }
}

function saveDiskCache(): void {
  try {
    const providers = [...lastGood.values()].filter((u) => u.connected && u.windows.length > 0)
    fs.writeFileSync(
      usageCachePath(),
      JSON.stringify({ providers, updatedAt: Date.now() }, null, 2)
    )
  } catch {
    // best-effort; usage display must not break the app
  }
}

/**
 * Fetch usage for all subscription providers that have stored credentials.
 * Only connected providers are returned.
 *
 * - Served from the in-memory cache if the last sync is younger than SYNC_TTL_MS.
 * - On a failed live fetch (e.g. 429), falls back to the last good value for
 *   that provider, flagged `stale`, instead of blanking the indicator.
 *
 * Pass `force` to bypass the TTL (e.g. a manual refresh button).
 */
export async function getProviderUsage(force = false): Promise<ProviderUsage[]> {
  loadDiskCache()
  const now = Date.now()
  if (!force && cachedResult && now - cachedAt < SYNC_TTL_MS) {
    return cachedResult
  }

  const auth = readAuthJson()
  const results = await Promise.all([fetchAnthropic(auth), fetchCodex(auth), fetchCopilot(auth)])

  const merged = results.map((r) => {
    if (!r.connected) return r
    const ok = !r.error && r.windows.length > 0
    if (ok) {
      lastGood.set(r.id, r)
      return r
    }
    const good = lastGood.get(r.id)
    return good ? { ...good, stale: true } : r
  })

  const out = merged.filter((r) => r.connected)
  cachedResult = out
  cachedAt = now
  saveDiskCache()
  return out
}
