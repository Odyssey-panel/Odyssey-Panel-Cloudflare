import { getSettings } from '@/lib/settings'
import { runMaintenanceOnce } from '@/lib/jobs'

export const runtime = 'nodejs'

/**
 * Maintenance endpoint for external schedulers.
 *
 * Cloudflare Workers have no always-on process, so periodic node/worker
 * health checks are done by pinging this route every >=5 minutes with the
 * panel secret. Any uptime monitor works (cron-job.org, Better Stack, a
 * tiny Cloudflare cron worker, ...):
 *
 *   GET /api/cron?secret=<panelSecret>
 *   (or header: x-cron-secret: <panelSecret>)
 *
 * The panel secret lives in Settings → security (auto-generated on first
 * login; the same one protecting session cookies).
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const provided = url.searchParams.get('secret') || req.headers.get('x-cron-secret') || ''
  const { panelSecret } = await getSettings()
  if (!panelSecret || panelSecret === 'insecure-dev-secret' || provided !== panelSecret) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const result = await runMaintenanceOnce()
  return Response.json({ ok: true, at: new Date().toISOString(), ...result })
}
