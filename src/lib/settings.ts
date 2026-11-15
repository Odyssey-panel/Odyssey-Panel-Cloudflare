import { db } from '@/lib/db'

export type PanelSettings = {
  adminPassword: string
  panelSecret: string
  publicUrl: string
  lastOrigin: string
  /** JSON map of ISP anti-censorship preset overrides (src/lib/isps.ts) */
  ispPresets: string
  /** Base URL of the deployed edge tunnel worker (VLESS over WS). */
  tunnelUrl: string
  /** Secret ws path segment served by the tunnel worker. */
  tunnelPath: string
  /** Optional comma-separated PROXY_IP relays passed to the tunnel worker. */
  tunnelProxyIp: string
  /** Tunnel content policy: block ad/tracker domains ("1"/"0"). */
  tunnelBlockAds: string
  /** Tunnel content policy: block adult domains ("1"/"0"). */
  tunnelBlockPorn: string
  /** Extra comma-separated domain suffixes to always block in the tunnel. */
  tunnelBlockExtra: string
  /** Optional clean/best Cloudflare edge IP (or host) that new configs dial
   *  directly instead of the tunnel hostname — SNI/Host stay the tunnel host.
   *  The single biggest real-throughput lever on ISPs with bad anycast routing. */
  tunnelCleanIp: string
}

/** Source of truth for defaults — missing DB rows fall back to these. */
export const SETTINGS_DEFAULTS: Record<keyof PanelSettings, string> = {
  adminPassword: '',
  panelSecret: 'insecure-dev-secret',
  publicUrl: '',
  lastOrigin: '',
  ispPresets: '',
  tunnelUrl: '',
  tunnelPath: '',
  tunnelProxyIp: '',
  tunnelBlockAds: '',
  tunnelBlockPorn: '',
  tunnelBlockExtra: '',
  tunnelCleanIp: '',
}

/** Keys hidden from the settings GET response. */
export const REDACTED_KEYS: Set<keyof PanelSettings> = new Set([
  'adminPassword',
  'panelSecret',
])

// ────────────────────────────────────────────────────────────────────────────
// In-isolate settings cache — SPEED.
// Every admin request used to pay 1-2 extra D1 round trips just to read
// settings (session HMAC needs panelSecret, captureOrigin needs publicUrl).
// Settings change rarely, so a short-TTL isolate cache turns those reads into
// memory hits. Writes invalidate immediately (same isolate); other isolates
// converge within the TTL — a 10s window for a rarely-changed row is fine.
// ────────────────────────────────────────────────────────────────────────────
const SETTINGS_TTL_MS = 10_000
let settingsCache: { at: number; map: Record<string, string> } | null = null

/** Drop the cached copy (call after writing settings outside setSettings). */
export function invalidateSettingsCache() {
  settingsCache = null
}

export async function getSettings(): Promise<PanelSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
    return { ...SETTINGS_DEFAULTS, ...settingsCache.map } as unknown as PanelSettings
  }
  const rows = await db.setting.findMany()
  const map: Record<string, string> = {}
  for (const row of rows) map[row.key] = row.value
  settingsCache = { at: Date.now(), map }
  return { ...SETTINGS_DEFAULTS, ...map } as unknown as PanelSettings
}

export async function getSetting(key: keyof PanelSettings): Promise<string> {
  const s = await getSettings()
  return s[key]
}

export async function setSettings(patch: Partial<Record<keyof PanelSettings, string>>) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as Array<[string, string]>
  if (entries.length) {
    // parallel upserts — one round-trip wave instead of N sequential ones
    await Promise.all(
      entries.map(([key, value]) =>
        db.setting.upsert({ where: { key }, update: { value }, create: { key, value } }),
      ),
    )
  }
  settingsCache = null
}

export function redactSettings(s: PanelSettings) {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(s)) {
    out[k] = REDACTED_KEYS.has(k as keyof PanelSettings) ? '' : v
  }
  return out
}

/** Best known public base URL of the panel (no trailing slash). */
export async function getBaseUrl(): Promise<string> {
  const { publicUrl, lastOrigin } = await getSettings()
  const env = process.env.PANEL_PUBLIC_URL || ''
  const url = publicUrl || lastOrigin || env
  return url.replace(/\/+$/, '')
}
