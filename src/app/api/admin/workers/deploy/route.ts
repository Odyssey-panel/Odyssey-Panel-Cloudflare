import { db } from '@/lib/db'
import { requireAuth, jsonSafe } from '@/lib/auth'
import { workerCodeFor, blockFlagsFor } from '@/lib/worker-kit'
import { setSettings, getSetting } from '@/lib/settings'

export const runtime = 'nodejs'

const CF_API = 'https://api.cloudflare.com/client/v4'
/** Compat date for the deployed tunnel worker (cloudflare:sockets ready). */
const TUNNEL_COMPAT_DATE = '2025-11-01'

type CfError = { errors?: { code: number; message: string }[]; messages?: unknown[] }

async function cfFetch(path: string, apiToken: string, init?: RequestInit) {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiToken}`, ...(init?.headers || {}) },
  })
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown } & CfError
  if (!res.ok || json.success === false) {
    const msg =
      json.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ||
      `Cloudflare API HTTP ${res.status}`
    throw new Error(msg)
  }
  return json.result
}

/**
 * One-click deploy of the vless-over-WebSocket tunnel worker.
 *
 * Body: { apiToken, accountId?, name? }
 *  - apiToken: a Cloudflare API token with Workers Scripts:Edit permission.
 *    Used once in-memory to call the Cloudflare API — never stored in D1.
 *  - accountId: optional; when omitted the first account on the token wins.
 *  - name: worker name (default "odyssey-tunnel").
 *
 * Flow: resolve account → ensure workers.dev subdomain → upload the module
 * worker → enable the workers.dev route → register the URL in the panel.
 */
export async function POST(req: Request) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized

  const body = (await req.json().catch(() => ({}))) as {
    apiToken?: string
    accountId?: string
    name?: string
  }
  const apiToken = (body.apiToken || '').trim()
  const name = ((body.name || 'odyssey-tunnel').trim() || 'odyssey-tunnel')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 58) || 'odyssey-tunnel'
  if (!apiToken) return Response.json({ error: 'API token required' }, { status: 400 })

  try {
    // 1) Resolve the account (first account on the token, unless provided)
    let accountId = (body.accountId || '').trim()
    if (!accountId) {
      const accounts = (await cfFetch('/accounts?per_page=1', apiToken)) as { id: string; name: string }[]
      if (!Array.isArray(accounts) || !accounts[0]?.id) {
        return Response.json({ error: 'No Cloudflare account found for this token' }, { status: 400 })
      }
      accountId = accounts[0].id
    }

    // 2) Ensure the workers.dev subdomain exists and is enabled
    let subdomain = ''
    try {
      const sub = (await cfFetch(`/accounts/${accountId}/workers/subdomain`, apiToken)) as {
        subdomain?: string
        enabled?: boolean
      }
      subdomain = sub?.subdomain || ''
      if (subdomain && sub?.enabled === false) {
        await cfFetch(`/accounts/${accountId}/workers/subdomain`, apiToken, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        })
      }
    } catch {
      // Some accounts need the subdomain created first
      const sub = (await cfFetch(`/accounts/${accountId}/workers/subdomain`, apiToken, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })) as { subdomain?: string }
      subdomain = sub?.subdomain || ''
    }
    if (!subdomain) {
      return Response.json({ error: 'Could not resolve the workers.dev subdomain' }, { status: 502 })
    }

    // 3) Tunnel bindings: secret path + optional relay.
    //    NO TUNNEL_ALLOW binding — a baked UUID allowlist silently killed every
    //    config created AFTER a deploy (ping OK, zero traffic — the worst kind
    //    of failure). The secret path gates access; the worker still honours a
    //    TUNNEL_ALLOW var set manually in the CF dashboard for strict lockdown.

    let tunnelPath = (await getSetting('tunnelPath')).trim().replace(/^\/+|\/+$/g, '')
    if (!tunnelPath) {
      tunnelPath = crypto.randomUUID().replace(/-/g, '').slice(0, 24)
    }
    const proxyIp = (await getSetting('tunnelProxyIp')).trim()
    const blockAds = (await getSetting('tunnelBlockAds')).trim() === '1'
    const blockPorn = (await getSetting('tunnelBlockPorn')).trim() === '1'
    const blockExtra = (await getSetting('tunnelBlockExtra')).trim()

    const code = workerCodeFor(proxyIp, blockFlagsFor(blockAds, blockPorn))
    const bindings = [
      { type: 'plain_text', name: 'PATH_SECRET', text: tunnelPath },
      { type: 'plain_text', name: 'TUNNEL_PROXYIP', text: proxyIp },
      // Shadowsocks keys are derived from this deployment-wide password — the
      // panel issues SS accounts with exactly this value so links can decrypt.
      { type: 'plain_text', name: 'TUNNEL_SS_PASSWORD', text: tunnelPath },
      ...(blockExtra ? [{ type: 'plain_text', name: 'TUNNEL_BLOCK_EXTRA', text: blockExtra }] : []),
    ]
    // Smart Placement keeps the tunnel near its users; unavailable on some
    // plans, so a failed smart upload falls back to a plain one.
    const upload = async (smart: boolean) => {
      const metadata: Record<string, unknown> = {
        main_module: 'worker.js',
        compatibility_date: TUNNEL_COMPAT_DATE,
        bindings,
      }
      if (smart) metadata.placement = { mode: 'smart' }
      const form = new FormData()
      form.append(
        'metadata',
        new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
      )
      form.append(
        'worker.js',
        new Blob([code], { type: 'application/javascript+module' }),
        'worker.js',
      )
      return cfFetch(`/accounts/${accountId}/workers/scripts/${name}`, apiToken, {
        method: 'PUT',
        body: form,
      })
    }
    try {
      await upload(true)
    } catch {
      await upload(false)
    }

    // 4) Enable the workers.dev route for this script
    await cfFetch(`/accounts/${accountId}/workers/scripts/${name}/subdomains`, apiToken, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    // 5) Register the URL in the panel (idempotent per URL)
    const url = `https://${name}.${subdomain}.workers.dev`
    const existing = await db.worker.findFirst({ where: { url } })
    const worker =
      existing ??
      (await db.worker.create({
        data: { name, url, note: 'Odyssey Edge Tunnel — deployed by panel (one-click)' },
      }))

    // 6) Persist tunnel settings so every new config points at the tunnel
    await setSettings({ tunnelUrl: url, tunnelPath })

    // 7) Make sure a Node row exists for the tunnel (UI bookkeeping)
    const nodeUrlHost = new URL(url).hostname
    const existingNode = await db.node.findFirst({ where: { address: nodeUrlHost } })
    if (!existingNode) {
      await db.node.create({
        data: {
          name: 'Odyssey Edge Tunnel',
          address: nodeUrlHost,
          port: 443,
          protocol: 'vless',
          tls: true,
          sni: nodeUrlHost,
          note: 'one-click edge tunnel worker',
        },
      })
    }

    return jsonSafe({ worker, url, accountId, path: `/${tunnelPath}` }, { status: 201 })
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Cloudflare deploy failed' },
      { status: 502 },
    )
  }
}
