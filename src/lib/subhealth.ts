/**
 * Subscription health + fastest-mode auto-heal.
 *
 * The user's own device is the only honest liveness probe (CF blocks
 * worker→workers.dev calls with 1042, and a config that "pings" can still be
 * dead in the client's ISP). So the sub page silently runs the device test
 * for every vless config and reports results here:
 *
 *   - KV-backed health map per subscription token (ok / latency / fails)
 *   - proxies that fail twice in a row are AUTO-REPLACED with a fresh
 *     variant of the same protocol (current clean-IP first, then domain)
 *     — the user just refreshes the sub and the new config is already there
 *   - fastMode clients get their sub ordered fastest-first: configs with
 *     known-good latency first, clean-IP variants before domain variants
 */
import { db } from '@/lib/db'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { generateAccounts } from '@/lib/accounts'

type KvLike = { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>; delete(k: string): Promise<void> }

const HEALTH_TTL = 7 * 24 * 3600
const FAILS_TO_REPLACE = 2
const REPLACE_COOLDOWN_MS = 5 * 60 * 1000

type HealthEntry = { ok: boolean; ms: number; at: number; fails: number }
export type HealthMap = Record<string, HealthEntry>
export type HealthReport = Array<{ remark?: string; ok: boolean; ms?: number }>

function kv(): KvLike | null {
  try {
    const cf = getCloudflareContext()
    const env = cf?.env as { KV?: KvLike } | undefined
    return env?.KV ?? null
  } catch {
    return null
  }
}

const healthKey = (token: string) => `subhealth:${token}`

/** Read the health map for one subscription (null-safe). */
export async function readHealth(subToken: string): Promise<HealthMap> {
  try {
    const raw = await kv()?.get(healthKey(subToken))
    return raw ? (JSON.parse(raw) as HealthMap) : {}
  } catch {
    return {}
  }
}

/**
 * Record one batch of device-test results. `ids` maps remark → proxy id so
 * the report (which only carries remarks) updates the right rows.
 */
export async function recordHealth(
  subToken: string,
  ids: Record<string, string>,
  results: HealthReport,
): Promise<void> {
  const map = await readHealth(subToken)
  const now = Date.now()
  for (const r of results) {
    const id = r.remark ? ids[r.remark] : undefined
    if (!id) continue
    const prev = map[id]
    const ok = !!r.ok
    map[id] = {
      ok,
      ms: Math.max(1, Math.round(r.ms || prev?.ms || 0)),
      at: now,
      fails: ok ? 0 : (prev?.fails || 0) + 1,
    }
  }
  try {
    await kv()?.put(healthKey(subToken), JSON.stringify(map), { expirationTtl: HEALTH_TTL })
  } catch {
    // health tracking must never break the sub
  }
}

/** Proxy id → health, or a clean-IP-first heuristic when no data yet. */
function healthScore(
  p: { id: string; address: string; sni: string | null; protocol: string },
  health: HealthMap,
): { bucket: number; ms: number } {
  const h = health[p.id]
  if (h) return { bucket: h.ok ? 0 : 2, ms: h.ms || 9999 }
  // no data yet: clean-IP (address ≠ sni, looks like an IP) sorts before domain
  const looksIp = /\d+\.\d+\.\d+\.\d+/.test(p.address) || p.address.includes(':')
  const clean = !!p.sni && p.address !== p.sni && looksIp
  return { bucket: clean ? 1 : 1.5, ms: 5000 }
}

/** Fastest-first ordering for fastMode subscriptions. */
export function orderFastest<
  T extends { id: string; address: string; sni: string | null; protocol: string },
>(proxies: T[], health: HealthMap): T[] {
  return [...proxies].sort((a, b) => {
    const sa = healthScore(a, health)
    const sb = healthScore(b, health)
    if (sa.bucket !== sb.bucket) return sa.bucket - sb.bucket
    if (sa.ms !== sb.ms) return sa.ms - sb.ms
    return a.protocol.localeCompare(b.protocol)
  })
}

/**
 * Replace proxies that failed the device test FAILS_TO_REPLACE times in a
 * row: same protocol, fresh variant (current clean IP first), remark keeps
 * the family name. Cooldown-guarded so a flaky check can't churn configs.
 */
export async function autoHeal(clientId: string): Promise<number> {
  try {
    const client = await db.client.findUnique({
      where: { id: clientId },
      include: { proxies: true },
    })
    if (!client || !client.fastMode) return 0

    const health = await readHealth(client.subToken)
    const dead = client.proxies.filter((p) => (health[p.id]?.fails || 0) >= FAILS_TO_REPLACE)
    if (!dead.length) return 0

    const store = kv()
    const cool = store ? await store.get(`subheal:${client.subToken}`) : null
    if (cool && Date.now() - Number(cool) < REPLACE_COOLDOWN_MS) return 0

    // regenerate at most 2 dead protocols per heal — measured, not wild
    const byProto = new Map<string, typeof dead>()
    for (const p of dead) {
      const list = byProto.get(p.protocol) || []
      list.push(p)
      byProto.set(p.protocol, list)
    }

    let replaced = 0
    const { getSettings } = await import('@/lib/settings')
    const s = await getSettings()
    const vpsSet = Boolean((s.vpsHost || '').trim())
    for (const [proto, list] of byProto) {
      if (replaced >= 2) break
      const generated = await generateAccounts({
        name: client.name,
        protocols: [proto],
        addressTypes: ['clean', 'domain'],
        ports: [443],
        count: 1,
        reality: proto === 'vless' && vpsSet,
      })
      if (!generated.length) continue
      // drop the dead rows, add the fresh ones (remark family preserved by
      // the generator: "Name · VLESS · …")
      await db.proxy.deleteMany({
        where: { id: { in: list.map((p) => p.id) } },
      })
      for (const g of generated) {
        await db.proxy.create({
          data: {
            clientId: client.id,
            protocol: g.protocol,
            remark: g.remark,
            address: g.address,
            port: g.port,
            secret: g.secret,
            sni: g.sni,
            host: g.host,
            path: g.path,
            transport: g.transport,
            tls: g.tls,
            flow: g.flow,
            fragment: g.fragment,
            fp: g.fp,
            ech: g.ech,
            plugin: g.plugin,
            reality: g.reality,
            serverConfig: g.serverConfig,
          },
        })
      }
      replaced += generated.length
    }

    if (store) {
      await store.put(`subheal:${client.subToken}`, String(Date.now()), { expirationTtl: 3600 })
    }
    const { regenerateSubscription } = await import('@/lib/subcache')
    await regenerateSubscription(client.id)
    return replaced
  } catch {
    return 0 // healing must never break the sub
  }
}
