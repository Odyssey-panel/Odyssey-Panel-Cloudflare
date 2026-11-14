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
}

/** Keys hidden from the settings GET response. */
export const REDACTED_KEYS: Set<keyof PanelSettings> = new Set([
  'adminPassword',
  'panelSecret',
])

export async function getSettings(): Promise<PanelSettings> {
  const rows = await db.setting.findMany()
  const map: Record<string, string> = { ...SETTINGS_DEFAULTS }
  for (const row of rows) map[row.key] = row.value
  return map as unknown as PanelSettings
}

export async function getSetting(key: keyof PanelSettings): Promise<string> {
  const row = await db.setting.findUnique({ where: { key } })
  return row?.value ?? SETTINGS_DEFAULTS[key]
}

export async function setSettings(patch: Partial<Record<keyof PanelSettings, string>>) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    await db.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    })
  }
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
