import { requireAuth, jsonSafe } from '@/lib/auth'
import { getCloudflareContext } from '@opennextjs/cloudflare'

export const runtime = 'nodejs'

/** Small set of well-known, high-availability targets for egress latency. */
const TARGETS = [
  { label: 'Cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace' },
  { label: 'Google', url: 'https://www.google.com/generate_204' },
  { label: 'GitHub', url: 'https://api.github.com/zen' },
  { label: 'X.AI', url: 'https://api.x.ai' },
]

/**
 * Two-hop latency probe, matching the panel's real traffic path:
 *  1. browser → panel (client-side fetch timing, measured by the UI)
 *  2. panel edge → public internet (measured here with tiny HEAD/GET calls)
 *
 * One click fires 4 small requests — negligible volume, well within
 * Cloudflare's fair-use limits.
 */
export async function GET() {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized

  const colo = (() => {
    try {
      return (getCloudflareContext() as { cf?: { colo?: string } } | undefined)?.cf?.colo ?? null
    } catch {
      return null
    }
  })()

  const results = await Promise.all(
    TARGETS.map(async (t) => {
      const started = Date.now()
      try {
        const res = await fetch(t.url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(8000),
          headers: { 'user-agent': 'Odyssey-Panel-Ping/2.0' },
        })
        // drain a tiny body so the timing includes the round trip
        await res.arrayBuffer()
        return { label: t.label, ok: res.status < 500, latencyMs: Date.now() - started, status: res.status }
      } catch (e) {
        return {
          label: t.label,
          ok: false,
          latencyMs: Date.now() - started,
          status: 0,
          error: e instanceof Error ? e.message : 'timeout',
        }
      }
    }),
  )

  const ok = results.filter((r) => r.ok && r.latencyMs < 8000)
  const avg = ok.length ? Math.round(ok.reduce((a, r) => a + r.latencyMs, 0) / ok.length) : null
  return jsonSafe({ colo, results, avgEgressMs: avg, measuredAt: new Date().toISOString() })
}
