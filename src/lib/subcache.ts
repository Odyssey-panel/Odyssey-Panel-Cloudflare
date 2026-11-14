/**
 * Edge-native subscription cache.
 *
 * The panel pre-generates every subscription format (base64 / raw / clash /
 * sing-box) the moment a user or their accounts change, and stores the
 * result in Workers KV. The public /api/sub/[token] endpoint then serves a
 * single KV read from the nearest edge — no D1 round trip, no link building
 * at request time — which is what makes subscription updates near-instant
 * even for users with hundreds of configs.
 *
 * Falls back to an in-process map outside Workers (next dev without
 * wrangler bindings), so local development keeps working unchanged.
 */
import { db } from '@/lib/db'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { buildSubscription, type SubFormat, type ProxyLike } from '@/lib/links'

const KV_TTL_SECONDS = 7 * 24 * 3600 // a week; rows are rewritten on change
const FORMATS: SubFormat[] = ['base64', 'raw', 'clash', 'singbox']

type CachedSub = {
  /** one entry per format → pre-built response body */
  formats: Partial<Record<SubFormat, string>>
  /** Subscription-Userinfo header value (upload/download/total/expire) */
  userinfo: string
  /** epoch ms the payload was generated */
  updatedAt: number
}

const g = globalThis as unknown as { __subCache?: Map<string, CachedSub> }
const memory = (): Map<string, CachedSub> => (g.__subCache ??= new Map())

type KvLike = {
  get: (key: string, type?: string) => Promise<string | null>
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<unknown>
  delete: (key: string) => Promise<unknown>
}

function kv(): KvLike | null {
  try {
    const cf = getCloudflareContext()
    const env = cf?.env as { KV?: KvLike; CACHE?: KvLike } | undefined
    return env?.KV ?? env?.CACHE ?? null
  } catch {
    return null // dev without wrangler bindings
  }
}

/** Subscription-Userinfo (v2rayNG / Clash / Shadowrocket show remaining quota). */
export function userinfoHeader(input: {
  limitBytes: bigint | number
  usedBytes: bigint | number
  expiresAt: Date | null
}): string {
  const total = Number(input.limitBytes)
  const used = Number(input.usedBytes)
  const parts = [`upload=0`, `download=${Number.isFinite(used) ? Math.max(0, used) : 0}`]
  if (total > 0) parts.push(`total=${total}`)
  if (input.expiresAt) parts.push(`expire=${Math.floor(input.expiresAt.getTime() / 1000)}`)
  return parts.join('; ')
}

/** Build + persist all subscription formats for one client. Never throws. */
export async function regenerateSubscription(clientId: string): Promise<void> {
  try {
    const client = await db.client.findUnique({
      where: { id: clientId },
      include: { proxies: true },
    })
    if (!client) return

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
    }))

    const formats: Partial<Record<SubFormat, string>> = {}
    for (const f of FORMATS) {
      formats[f] = buildSubscription(proxies, f).body
    }

    const payload: CachedSub = {
      formats,
      userinfo: userinfoHeader(client),
      updatedAt: Date.now(),
    }
    const raw = JSON.stringify(payload)
    const store = kv()
    if (store) {
      await store.put(`sub:${client.subToken}`, raw, { expirationTtl: KV_TTL_SECONDS })
    } else {
      memory().set(client.subToken, payload)
    }
  } catch {
    // cache generation must never break admin mutations
  }
}

/** Drop cached payloads for a client (e.g. right before deletion). */
export async function invalidateSubscription(subToken: string): Promise<void> {
  try {
    const store = kv()
    if (store) await store.delete(`sub:${subToken}`)
    else memory().delete(subToken)
  } catch {
    // ignore
  }
}

/**
 * Read a pre-built subscription payload. Returns null when the cache is
 * cold — callers fall back to building on the fly (and should then warm it).
 */
export async function readSubscriptionCache(
  subToken: string,
  format: SubFormat,
): Promise<{ body: string; userinfo: string; updatedAt: number } | null> {
  try {
    const store = kv()
    const raw: string | null = store
      ? await store.get(`sub:${subToken}`)
      : (memory().get(subToken) as CachedSub | undefined
          ? JSON.stringify(memory().get(subToken))
          : null)
    if (!raw) return null
    const payload = JSON.parse(raw) as CachedSub
    const body = payload.formats[format]
    if (typeof body !== 'string') return null
    return { body, userinfo: payload.userinfo, updatedAt: payload.updatedAt }
  } catch {
    return null
  }
}

/** Small generic KV/memory cache for expensive admin queries (stats etc.). */
const memo = new Map<string, { at: number; value: string }>()

export async function cachedJson<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>,
): Promise<T> {
  const store = kv()
  const now = Date.now()
  try {
    const raw = store ? await store.get(`cache:${key}`) : null
    const local = raw ? null : memo.get(key)
    const hit = raw ? JSON.parse(raw).v : local && now - local.at < ttlMs ? JSON.parse(local.value).v : null
    if (hit !== null && hit !== undefined) return hit as T
  } catch {
    // fall through to recompute
  }
  const value = await producer()
  try {
    const wrapped = JSON.stringify({ v: value, at: now })
    if (store) {
      await store.put(`cache:${key}`, wrapped, { expirationTtl: Math.max(60, Math.floor(ttlMs / 1000)) })
    } else {
      memo.set(key, { at: now, value: wrapped })
    }
  } catch {
    // caching is best-effort
  }
  return value
}
