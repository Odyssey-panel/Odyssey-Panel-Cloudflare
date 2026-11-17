import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { buildServerConfig, type ProxyLike } from '@/lib/links'
import { getRealityKeys, parseReality } from '@/lib/reality'

export const runtime = 'nodejs'

/**
 * GET /api/admin/vps/xray-config
 *
 * Full xray-core server config for the admin's VPS, built from every proxy
 * account in the panel. Reality vless / ws-tls groups are merged into shared
 * inbounds (one client entry per account); shadowsocks keeps one inbound per
 * account (single-password inbounds). Download with the admin session and
 * drop the file at /etc/xray/config.json (or mount it into the container).
 */
export async function GET() {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized

  const proxies = await db.proxy.findMany({ orderBy: { createdAt: 'asc' } })
  const keys = await getRealityKeys()
  const priv = keys?.priv ?? ''

  const hasReality = proxies.some((p) => parseReality(p.reality))
  if (hasReality && !priv) {
    return Response.json(
      { error: 'Reality keys unavailable on this runtime — run the panel on Node (VPS/Docker) once' },
      { status: 400 },
    )
  }

  type Inbound = {
    tag: string
    port: number
    protocol: string
    settings: Record<string, unknown>
    streamSettings?: Record<string, unknown>
    sniffing?: Record<string, unknown>
  }

  const merged = new Map<string, { inbound: Inbound; kind: 'vless' | 'vmess' | 'trojan' }>()
  const singles: Inbound[] = []
  const portOwner = new Map<number, string>()

  for (const p of proxies) {
    if (!['vless', 'vmess', 'trojan', 'shadowsocks'].includes(p.protocol)) continue
    const reality = parseReality(p.reality)
    const proxyLike: ProxyLike = {
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
      fp: p.fp,
      ech: p.ech,
      reality,
      realityPriv: priv,
    }
    const cfg = buildServerConfig(proxyLike) as {
      tag: string
      port: number
      protocol: string
      settings?: Record<string, unknown>
      streamSettings?: Record<string, unknown>
    }
    if (!cfg?.settings || !cfg?.port) continue

    const clients = (cfg.settings.clients as unknown[] | undefined) ?? []
    const firstClient = clients[0]
    if (!firstClient) continue

    // shadowsocks = one password per inbound → never merged
    if (p.protocol === 'shadowsocks') {
      const ssTag = `in-ss-${p.port}-${singles.length + 1}`
      singles.push({
        tag: ssTag,
        port: cfg.port,
        protocol: 'shadowsocks',
        settings: cfg.settings,
        streamSettings: cfg.streamSettings,
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
      })
      continue
    }

    const sig = JSON.stringify(cfg.streamSettings || {})
    const key = `${p.protocol}|${cfg.port}|${sig}`
    const existing = merged.get(key)
    if (existing) {
      const arr = (existing.inbound.settings.clients as unknown[]) ?? []
      arr.push(firstClient)
      existing.inbound.settings.clients = arr
      continue
    }
    if (portOwner.has(cfg.port)) continue // port collision with a different stream — skip
    portOwner.set(cfg.port, key)
    merged.set(key, {
      kind: p.protocol as 'vless' | 'vmess' | 'trojan',
      inbound: {
        tag: `in-${p.protocol}-${cfg.port}`,
        port: cfg.port,
        protocol: p.protocol,
        settings: cfg.settings,
        streamSettings: cfg.streamSettings,
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
      },
    })
  }

  const config = {
    log: { loglevel: 'warning' },
    inbounds: [...[...merged.values()].map((m) => m.inbound), ...singles],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'blocked' },
    ],
  }

  return new Response(JSON.stringify(config, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="config.json"',
      'cache-control': 'no-store',
    },
  })
}
