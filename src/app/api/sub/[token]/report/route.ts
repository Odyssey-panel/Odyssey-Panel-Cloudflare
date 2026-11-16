import { db } from '@/lib/db'
import { recordHealth, autoHeal, type HealthReport } from '@/lib/subhealth'
import { getCloudflareContext } from '@opennextjs/cloudflare'

export const runtime = 'nodejs'

type Params = { params: Promise<{ token: string }> }

/**
 * Public device-test report — the sub page silently probes every vless
 * config on the user's own device (the only honest liveness source) and
 * posts results here. Failing proxies are auto-replaced so the next
 * subscription refresh already carries the healed set.
 */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    return Response.json({ error: 'Invalid token' }, { status: 404 })
  }

  const body = (await req.json().catch(() => ({}))) as { results?: HealthReport }
  const results = Array.isArray(body.results) ? body.results.slice(0, 64) : []
  if (!results.length) return Response.json({ ok: true, replaced: 0 })

  const client = await db.client.findUnique({
    where: { subToken: token },
    select: { id: true, fastMode: true },
  })
  if (!client) return Response.json({ error: 'Not found' }, { status: 404 })

  // remark → proxy id (remarks are unique per client; missing ones are skipped)
  const proxies = await db.proxy.findMany({
    where: { clientId: client.id },
    select: { id: true, remark: true },
  })
  const ids: Record<string, string> = {}
  for (const p of proxies) ids[p.remark] = p.id

  await recordHealth(token, ids, results)

  // heal in the background — the page gets its answer immediately
  let replaced = 0
  if (client.fastMode) {
    try {
      const ctx = getCloudflareContext() as { ctx?: { waitUntil?: (p: Promise<void>) => void } } | undefined
      const heal = autoHeal(client.id).then((n) => {
        replaced = n
      })
      ctx?.ctx?.waitUntil?.(heal.catch(() => {}))
      // best-effort inline so the page can show it right away
      await Promise.race([heal, new Promise((r) => setTimeout(r, 4000))])
    } catch {
      // ignore
    }
  }

  return Response.json({ ok: true, replaced })
}
