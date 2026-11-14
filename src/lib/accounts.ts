/**
 * Account generation engine.
 *
 * Turns a "create user" request into concrete proxy accounts:
 *  - one or more protocols in a single click (vless / trojan / shadowsocks —
 *    all three terminate on the panel's edge tunnel worker)
 *  - optional N-address rotation: the tunnel host is offered as a domain,
 *    a resolved IPv4 and a resolved IPv6 so users can pick what their ISP
 *    treats best (some mobile networks route v4/v6 differently)
 *  - optional multi-location: distribute the accounts across up to 8
 *    endpoints (the deployed tunnel + any registered worker urls)
 *
 * Everything it produces lands in the Proxy table and — through the admin
 * API — straight into the KV subscription cache.
 */
import { db } from '@/lib/db'
import { tunnelFieldFor, type BuiltinFields } from '@/lib/backend'
import { generateSecret, validateProtocol } from '@/lib/secrets'
import { isValidFragment, buildServerConfig } from '@/lib/links'

/** Protocols the edge tunnel actually serves. */
export const TUNNEL_PROTOCOLS = ['vless', 'trojan', 'shadowsocks'] as const

export type GenerateOptions = {
  /** user-facing name (remark becomes Odyssey-<name>) */
  name: string
  /** one or more of vless | trojan | shadowsocks */
  protocols: string[]
  /** explicit endpoint url/host(s) — overrides the deployed tunnel */
  workers?: string[]
  /** generate extra per-protocol variants: domain, ipv4, ipv6 */
  addressTypes?: Array<'domain' | 'ipv4' | 'ipv6'>
  /** how many repeats per protocol (max 8 per protocol) */
  count?: number
  fragment?: string | null
  fingerprint?: string | null
  sni?: string | null
}

export type GeneratedAccount = {
  protocol: string
  remark: string
  address: string
  port: number
  secret: string
  sni: string | null
  host: string | null
  path: string
  transport: string
  tls: boolean
  fragment: string | null
  fp: string | null
  ech: string | null
  plugin: string | null
  serverConfig: string
}

/**
 * Resolve the endpoint list: explicit picks first, then the deployed
 * tunnel (settings), then any registered worker urls — up to 8 locations.
 */
async function resolveEndpoints(preferred: string[]): Promise<Array<{ host: string; custom: boolean }>> {
  const clean = (v: string) => {
    const s = (v || '').trim()
    if (!s) return ''
    try {
      return new URL(s.includes('://') ? s : `https://${s}`).hostname
    } catch {
      return s
    }
  }
  const picked = preferred.map(clean).filter(Boolean).slice(0, 8)
  if (picked.length) return picked.map((h) => ({ host: h, custom: true }))

  const out: Array<{ host: string; custom: boolean }> = []
  const fields = await tunnelFieldFor('vless')
  if (fields) out.push({ host: fields.address, custom: false })
  if (out.length) return out.slice(0, 8)

  const rows = await db.worker.findMany({
    orderBy: { createdAt: 'desc' },
    select: { url: true },
    take: 8,
  })
  for (const r of rows) {
    const h = clean(r.url)
    if (h) out.push({ host: h, custom: true })
  }
  return out.slice(0, 8)
}

/** Resolve one host into the requested address flavors. */
async function hostVariants(
  host: string,
  types: Array<'domain' | 'ipv4' | 'ipv6'>,
): Promise<Array<{ address: string; sni: string; kind: 'domain' | 'ipv4' | 'ipv6' }>> {
  const out: Array<{ address: string; sni: string; kind: 'domain' | 'ipv4' | 'ipv6' }> = []
  const want = types.length ? types : (['domain'] as const)
  for (const kind of want) {
    if (kind === 'domain') {
      out.push({ address: host, sni: host, kind })
      continue
    }
    const resolved = await dnsLookup(host, kind)
    out.push({ address: resolved || host, sni: host, kind })
  }
  return out
}

/** Small DNS helper on top of Workers-compatible fetch (DoH via Cloudflare). */
async function dnsLookup(host: string, kind: 'ipv4' | 'ipv6'): Promise<string | null> {
  try {
    const type = kind === 'ipv4' ? 'A' : 'AAAA'
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      { headers: { accept: 'application/dns-json' } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { Answer?: Array<{ type: number; data: string }> }
    const rec = data.Answer?.find((a) => (kind === 'ipv4' ? a.type === 1 : a.type === 28))
    return rec?.data ?? null
  } catch {
    return null
  }
}

/** Build tunnel fields for a custom endpoint (any registered worker url). */
function customFields(host: string, protocol: string, path: string): BuiltinFields {
  return {
    address: host,
    port: 443,
    transport: 'ws',
    tls: true,
    sni: host,
    host,
    path: path || '/',
  }
}

/**
 * Generate the full account set for one user. Throws a friendly Error when
 * there is no tunnel endpoint to point at (the admin must deploy/register
 * one first — the panel UI guides that flow).
 */
export async function generateAccounts(opts: GenerateOptions): Promise<GeneratedAccount[]> {
  const protocols = opts.protocols.filter((p) => TUNNEL_PROTOCOLS.includes(p as 'vless'))
  for (const p of protocols) {
    const err = validateProtocol(p)
    if (err) throw new Error(err)
  }
  if (!protocols.length) return []

  const endpoints = await resolveEndpoints(opts.workers || [])
  if (!endpoints.length) {
    throw new Error(
      'NO_TUNNEL: deploy the edge tunnel worker (Nodes & workers → one-click deploy) first',
    )
  }
  if (opts.fragment && !isValidFragment(opts.fragment)) {
    throw new Error('Invalid fragment value')
  }

  const count = Math.min(Math.max(1, opts.count ?? 1), 8)
  const out: GeneratedAccount[] = []

  for (let li = 0; li < endpoints.length; li++) {
    const ep = endpoints[li]
    const variants = await hostVariants(
      ep.host,
      opts.addressTypes && opts.addressTypes.length
        ? opts.addressTypes
        : (['domain'] as Array<'domain' | 'ipv4' | 'ipv6'>),
    )
    const locTag = endpoints.length > 1 ? `-L${li + 1}` : ''
    for (const proto of protocols) {
      for (let i = 0; i < count; i++) {
        for (const v of variants) {
          const fields = ep.custom
            ? customFields(v.address, proto, `/vlessws-${proto}`)
            : await tunnelFieldFor(proto)
          if (!fields) continue
          const suffix =
            `${locTag}${variants.length > 1 ? `-${v.kind}` : ''}${count > 1 ? `-${i + 1}` : ''}`
          const remark = `Odyssey-${opts.name}${suffix}`
          const secret = generateSecret(proto)
          out.push(finalize(fields, proto, remark, secret, opts))
        }
      }
    }
  }
  return out
}

/** Persist generated accounts for a client and return them. */
export async function persistAccounts(
  clientId: string,
  accounts: GeneratedAccount[],
): Promise<GeneratedAccount[]> {
  for (const a of accounts) {
    await db.proxy.create({
      data: {
        clientId,
        protocol: a.protocol,
        remark: a.remark,
        address: a.address,
        port: a.port,
        secret: a.secret,
        sni: a.sni,
        host: a.host,
        path: a.path,
        transport: a.transport,
        tls: a.tls,
        fragment: a.fragment,
        fp: a.fp,
        ech: a.ech,
        plugin: a.plugin,
        serverConfig: a.serverConfig,
      },
    })
  }
  return accounts
}

function finalize(
  fields: BuiltinFields,
  proto: string,
  remark: string,
  secret: string,
  opts: GenerateOptions,
): GeneratedAccount {
  const proxyLike = {
    protocol: proto,
    remark,
    address: fields.address,
    port: fields.port,
    secret,
    sni: opts.sni || fields.sni,
    host: fields.host,
    path: fields.path,
    transport: fields.transport,
    tls: fields.tls,
    fragment: opts.fragment || null,
    fp: opts.fingerprint || null,
    ech: null as string | null,
    plugin: null as string | null,
  }
  return {
    protocol: proto,
    remark,
    address: fields.address,
    port: fields.port,
    secret,
    sni: proxyLike.sni,
    host: fields.host,
    path: fields.path,
    transport: fields.transport,
    tls: fields.tls,
    fragment: proxyLike.fragment,
    fp: proxyLike.fp,
    ech: proxyLike.ech,
    plugin: proxyLike.plugin,
    serverConfig: JSON.stringify(buildServerConfig(proxyLike)),
  }
}
