/**
 * Maintenance helpers.
 *
 * Cloudflare Workers have no always-on process, so the old setInterval
 * scheduler no longer runs there. Health checks now run in two ways:
 *  1. `runMaintenanceOnce()` — invoked by GET /api/cron, which external
 *     schedulers (uptime monitor, cron-job.org, a tiny cron worker, ...)
 *     can ping every 5 minutes with the panel secret.
 *  2. `maybeAutoCheck()` — opportunistic, throttled background check fired
 *     when an admin opens the dashboard (uses waitUntil on Workers).
 *
 * For container-style hosts the classic inline loop is still available:
 * set ODYSSEY_INLINE_JOBS=1 and startJobs() runs every 10s like before.
 */
import { checkAllNodes, checkAllWorkers } from '@/lib/health'
import { getCloudflareContext } from '@opennextjs/cloudflare'

const g = globalThis as unknown as { __panelJobsStarted?: boolean; __panelLastAutoCheck?: number }

const HEALTH_INTERVAL_MS = 5 * 60 * 1000 // every 5 minutes
const INLINE_TICK_MS = 10_000

export async function runMaintenanceOnce() {
  const [nodes, workers] = await Promise.allSettled([checkAllNodes(), checkAllWorkers()])
  return {
    nodes: nodes.status === 'fulfilled' ? nodes.value : { error: String((nodes as PromiseRejectedResult).reason) },
    workers: workers.status === 'fulfilled' ? workers.value : { error: String((workers as PromiseRejectedResult).reason) },
  }
}

/** Throttled background auto-check; attaches to the Workers lifetime when possible. */
export function maybeAutoCheck(): void {
  const now = Date.now()
  if (g.__panelLastAutoCheck && now - g.__panelLastAutoCheck < HEALTH_INTERVAL_MS) return
  g.__panelLastAutoCheck = now

  const p = runMaintenanceOnce().then(() => undefined).catch(() => undefined)
  try {
    const ctx = (getCloudflareContext() as { ctx?: { waitUntil?: (p: Promise<void>) => void } } | undefined)?.ctx
    ctx?.waitUntil?.(p)
  } catch {
    // dev without wrangler bindings — let the promise float
  }
}

export function startJobs() {
  if (g.__panelJobsStarted) return
  g.__panelJobsStarted = true

  void (async () => {
    for (;;) {
      try {
        await maybeAutoCheck()
      } catch (e) {
        console.error('[jobs] tick error', e)
      }
      await new Promise((r) => setTimeout(r, INLINE_TICK_MS))
    }
  })()

  console.log('[jobs] background scheduler started')
}
