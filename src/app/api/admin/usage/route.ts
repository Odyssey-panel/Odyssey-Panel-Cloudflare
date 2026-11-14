import { db } from '@/lib/db'
import { requireAuth, jsonSafe } from '@/lib/auth'
import { cachedJson } from '@/lib/subcache'

export const runtime = 'nodejs'

const CF_API = 'https://api.cloudflare.com/client/v4'
const FREE_DAILY_REQUESTS = 100_000 // Workers free plan daily cap
const KV_PREFIX = 'metrics'

/** UTC day key for counters, e.g. 20261114 */
function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/**
 * Fire-and-forget request counter (called from other routes via waitUntil).
 * KV increments are cheap and free-plan friendly: one small write per hit.
 */
export async function bumpRequestCounter(kind: 'sub' | 'admin' = 'sub'): Promise<void> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const env = (getCloudflareContext()?.env ?? {}) as {
      KV?: { get: (k: string, t?: string) => Promise<string | null>; put: (k: string, v: string, o?: object) => Promise<unknown> }
    }
    const store = env.KV
    if (!store) return
    const k = `${KV_PREFIX}:req:${kind}:${dayKey()}`
    const cur = parseInt((await store.get(k, 'text')) || '0', 10) || 0
    await store.put(k, String(cur + 1), { expirationTtl: 90 * 86400 })
    const kt = `${KV_PREFIX}:req:${kind}:total`
    const tot = parseInt((await store.get(kt, 'text')) || '0', 10) || 0
    await store.put(kt, String(tot + 1), { expirationTtl: 90 * 86400 })
  } catch {
    // metrics must never break the request
  }
}

export async function GET(req: Request) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized

  // Optional: a Cloudflare token pasted once per session gives precise
  // Workers + D1 quota numbers straight from the GraphQL analytics API.
  // It is used in-memory for this request only — never persisted.
  const token = new URL(req.url).searchParams.get('apiToken') || ''

  // Self-tracked counters (always available, token-free)
  const [subsToday, subsTotal, adminToday] = await Promise.all([
    counter(`req:sub:${dayKey()}`),
    counter('req:sub:total'),
    counter(`req:admin:${dayKey()}`),
  ])
  const requestsToday = subsToday + adminToday

  const base = await cachedJson('usage-base', 60_000, async () => {
    const [clients, proxies, nodes, workers] = await Promise.all([
      db.client.count(),
      db.proxy.count(),
      db.node.count(),
      db.worker.count(),
    ])
    return { clients, proxies, nodes, workers }
  })

  let cloudflare: {
    requestsToday: number | null
    requestsTotal: number | null
    d1ReadsToday: number | null
    d1WritesToday: number | null
  } = { requestsToday: null, requestsTotal: null, d1ReadsToday: null, d1WritesToday: null }

  if (token) {
    try {
      const accountId = (await cfGet('/accounts?per_page=1', token) as { id: string }[])[0]?.id
      if (accountId) {
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19) + 'Z'
        const gql = `query { viewer { accounts(filter: {accountTag: "${accountId}"}) {
          workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: "${since}"}) { sum { requests } }
          d1AnalyticsAdaptiveGroups(limit: 1, filter: {date_geq: "${dayKey()}"}) { sum { readQueries writeQueries } }
        } } }`
        const res = await fetch(`${CF_API}/graphql`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query: gql }),
        })
        const data = (await res.json().catch(() => ({}))) as {
          data?: { viewer?: { accounts?: Array<{
            workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }>
            d1AnalyticsAdaptiveGroups?: Array<{ sum?: { readQueries?: number; writeQueries?: number } }>
          }> } }
        }
        const acct = data.data?.viewer?.accounts?.[0]
        cloudflare = {
          requestsToday: acct?.workersInvocationsAdaptive?.[0]?.sum?.requests ?? null,
          requestsTotal: null,
          d1ReadsToday: acct?.d1AnalyticsAdaptiveGroups?.[0]?.sum?.readQueries ?? null,
          d1WritesToday: acct?.d1AnalyticsAdaptiveGroups?.[0]?.sum?.writeQueries ?? null,
        }
      }
    } catch {
      // analytics is optional — fall back to self-tracked numbers
    }
  }

  return jsonSafe({
    requests: {
      today: requestsToday,
      cap: FREE_DAILY_REQUESTS,
      percent: Math.min(100, Math.round((requestsToday / FREE_DAILY_REQUESTS) * 1000) / 10),
      subscriptions: subsToday,
      subscriptionsTotal: subsTotal,
      cloudflare: cloudflare.requestsToday,
    },
    d1: {
      reads: cloudflare.d1ReadsToday,
      writes: cloudflare.d1WritesToday,
      readsCap: 5_000_000,
      writesCap: 100_000,
      rows: base,
    },
  })
}

async function counter(key: string): Promise<number> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare')
    const env = (getCloudflareContext()?.env ?? {}) as {
      KV?: { get: (k: string, t?: string) => Promise<string | null> }
    }
    const raw = await env.KV?.get(`${KV_PREFIX}:${key}`, 'text')
    return parseInt(raw || '0', 10) || 0
  } catch {
    return 0
  }
}

async function cfGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${CF_API}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const data = (await res.json().catch(() => ({}))) as { result?: unknown }
  return data.result ?? []
}
