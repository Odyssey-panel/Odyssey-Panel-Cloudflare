import { db } from '@/lib/db'
import { buildSubscription, type SubFormat, type ProxyLike } from '@/lib/links'
import { readSubscriptionCache } from '@/lib/subcache'
import { bumpRequestCounter } from '@/app/api/admin/usage/route'
import { getCloudflareContext } from '@opennextjs/cloudflare'

export const runtime = 'nodejs'

type Params = { params: Promise<{ token: string }> }

/**
 * Public subscription endpoint — edge-fast by design.
 *
 * Every admin mutation pre-generates all formats into Workers KV
 * (src/lib/subcache.ts), so a subscription refresh is a single KV read on
 * the nearest Cloudflare edge: no D1 round trip, no link building at
 * request time. On a cold cache we fall back to building on the fly and
 * return the fresh payload immediately (the next refresh hits the cache).
 *
 * Formats: base64 (default, v2rayNG etc.), raw, clash, singbox
 */
export async function GET(req: Request, { params }: Params) {
  const { token } = await params
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    return new Response('Invalid token', { status: 404 })
  }

  const url = new URL(req.url)
  const format = (url.searchParams.get('format') || 'base64') as SubFormat

  // self-tracking for the usage dashboard (fire-and-forget)
  try {
    const ctx = (getCloudflareContext() as { ctx?: { waitUntil?: (p: Promise<void>) => void } } | undefined)
    ctx?.ctx?.waitUntil?.(bumpRequestCounter('sub'))
  } catch {
    // dev without wrangler bindings
  }

  // ── fast path: pre-built payload from the edge cache ──────────────────────
  const cached = await readSubscriptionCache(token, format)
  if (cached) {
    return new Response(cached.body, {
      headers: subHeaders('Odyssey', cached.userinfo),
    })
  }

  // ── slow path: build on demand (and let the next refresh hit the cache) ──
  const client = await db.client.findUnique({ where: { subToken: token }, include: { proxies: true } })
  if (!client) return new Response('Subscription not found', { status: 404 })

  if (client.status !== 'active') {
    return new Response('Subscription disabled', { status: 403 })
  }
  // "start from first connection": expiry anchored to startedAt when present
  const effectiveExpiry = client.expiresAt
  if (effectiveExpiry && effectiveExpiry.getTime() < Date.now()) {
    return new Response('Subscription expired', { status: 403 })
  }
  if (client.limitBytes > 0 && client.usedBytes >= client.limitBytes) {
    return new Response('Traffic limit reached', { status: 403 })
  }
  if (client.requestLimit > 0 && client.usedRequests >= client.requestLimit) {
    return new Response('Request limit reached', { status: 403 })
  }

  const proxies: ProxyLike[] = client.proxies.map((p) => ({
    protocol: p.protocol,
    remark: p.remark,
    address: p.address,
    port: p.port,
    secret: p.secret,
    sni: p.sni,
    host: p.host,
    path: p.path,
    transport: p.transport,
    tls: p.tls,
    flow: p.flow,
    fragment: p.fragment,
    fp: p.fp,
    ech: p.ech,
    plugin: p.plugin,
  }))

  const { body, contentType } = buildSubscription(proxies, format)

  // warm the edge cache for the next refresh (fire-and-forget)
  try {
    const ctx = (getCloudflareContext() as { ctx?: { waitUntil?: (p: Promise<void>) => void } } | undefined)
    ctx?.ctx?.waitUntil?.(regenerateSubscriptionQuietly(client.id))
  } catch {
    // dev without wrangler bindings
  }

  return new Response(body, {
    headers: subHeaders(`Odyssey-${client.name}`, userinfoOf(client), contentType),
  })
}

/** Cache warming helper that never breaks the request. */
async function regenerateSubscriptionQuietly(clientId: string): Promise<void> {
  try {
    const { regenerateSubscription } = await import('@/lib/subcache')
    await regenerateSubscription(clientId)
  } catch {
    // ignore
  }
}

function userinfoOf(client: {
  limitBytes: bigint
  usedBytes: bigint
  expiresAt: Date | null
}): string {
  const parts = ['upload=0', `download=${client.usedBytes}`]
  if (client.limitBytes > 0) parts.push(`total=${client.limitBytes}`)
  if (client.expiresAt) parts.push(`expire=${Math.floor(client.expiresAt.getTime() / 1000)}`)
  return parts.join('; ')
}

function subHeaders(filename: string, userinfo: string, contentType = 'text/plain; charset=utf-8') {
  return {
    'content-type': contentType,
    // edge + browser cache: instant refreshes, still fresh enough for clients
    'cache-control': 'public, max-age=30, stale-while-revalidate=300',
    'profile-update-interval': '6',
    'subscription-userinfo': userinfo,
    'content-disposition': `attachment; filename="${filename}"`,
  }
}
