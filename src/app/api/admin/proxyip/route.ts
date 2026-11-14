import { requireAuth, jsonSafe } from '@/lib/auth'
import { getSettings } from '@/lib/settings'

export const runtime = 'nodejs'

/**
 * Proxy-IP relay tester — Zeus-style.
 *
 * POST /api/admin/proxyip  { targets?: string[] }
 *   - targets default to the configured tunnelProxyIp pool.
 *   - each relay is probed THROUGH the deployed tunnel worker's
 *     /<secret>/probe endpoint (direct + relay dial), so the numbers reflect
 *     what real users experience from the edge.
 *
 * Response: { results: [{ target, directMs, relayMs, ok, error? }] }
 */
export async function POST(req: Request) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized

  const body = (await req.json().catch(() => ({}))) as { targets?: string[] }
  const s = await getSettings()
  const tunnelUrl = (s.tunnelUrl || '').trim().replace(/\/+$/, '')
  const tunnelPath = (s.tunnelPath || '').trim().replace(/^\/+|\/+$/g, '')
  if (!tunnelUrl || !tunnelPath) {
    return Response.json({ error: 'tunnel not deployed yet' }, { status: 400 })
  }
  // NOTE: on *.workers.dev, Cloudflare blocks worker→worker fetches with
  // error 1042 — the settings UI therefore probes from the BROWSER directly.
  // This server-side route still works when the panel runs on a custom domain.

  const pool = (body.targets && body.targets.length ? body.targets : (s.tunnelProxyIp || '').split(','))
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12)
  if (!pool.length) return Response.json({ error: 'no proxy-ip configured' }, { status: 400 })

  const probe = async (target: string, relay: boolean) => {
    const u = `${tunnelUrl}/${tunnelPath}/probe?target=${encodeURIComponent(target)}${relay ? '&relay=1' : ''}`
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(9000) })
      const j = (await res.json()) as { ok?: boolean; ms?: number; error?: string }
      return { ok: !!j.ok, ms: j.ms ?? null, error: j.error || null }
    } catch (e) {
      return { ok: false, ms: null, error: e instanceof Error ? e.message : 'probe failed' }
    }
  }

  const results = await Promise.all(
    pool.map(async (target) => {
      const clean = /^[a-zA-Z0-9.:-]+:\d{1,5}$/.test(target) ? target : `${target}:443`
      const [direct, relay] = await Promise.all([probe(clean, false), probe(clean, true)])
      return { target: clean, directMs: direct.ms, directOk: direct.ok, relayMs: relay.ms, relayOk: relay.ok, error: relay.error }
    }),
  )

  return jsonSafe({ results })
}
