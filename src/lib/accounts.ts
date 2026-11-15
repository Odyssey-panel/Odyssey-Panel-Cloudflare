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
import { CF_HTTP_PORTS } from '@/lib/worker-kit'

/** Protocols the edge tunnel actually serves. */
export const TUNNEL_PROTOCOLS = ['vless', 'trojan', 'shadowsocks'] as const

export type GenerateOptions = {
  /** user-facing name (remark becomes Odyssey-<name>) */
  name: string
  /** one or more of vless | trojan | shadowsocks */
  protocols: string[]
  /** explicit endpoint url/host(s) — overrides the deployed tunnel */
  workers?: string[]
  /** generate extra per-protocol variants: clean IP, domain, ipv4, ipv6 */
  addressTypes?: Array<'clean' | 'domain' | 'ipv4' | 'ipv6'>
  /** how many repeats per protocol (max 8 per protocol) */
  count?: number
  fragment?: string | null
  fingerprint?: string | null
  sni?: string | null
  /** Zeus-style ECH config list carried into the generated links */
  ech?: string | null
  /** extra ports for one-account-per-port fan-out (TLS, plain-HTTP, or any custom 1-65535) */
  ports?: number[]
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

/** Small DoH cache so multi-variant generation doesn't re-resolve hosts. */
const dnsMemo = new Map<string, { at: number; v4: string | null; v6: string | null }>()
const DNS_TTL_MS = 5 * 60 * 1000

/** Resolve one host into the requested address flavors (DNS in parallel). */
async function hostVariants(
  host: string,
  types: Array<'domain' | 'ipv4' | 'ipv6'>,
): Promise<Array<{ address: string; sni: string; kind: 'domain' | 'ipv4' | 'ipv6' }>> {
  const out: Array<{ address: string; sni: string; kind: 'domain' | 'ipv4' | 'ipv6' }> = []
  const want: Array<'domain' | 'ipv4' | 'ipv6'> = types.length ? types : (['domain'] as Array<'domain' | 'ipv4' | 'ipv6'>)
  const needsV4 = want.includes('ipv4')
  const needsV6 = want.includes('ipv6')
  const cached = needsV4 || needsV6 ? dnsMemo.get(host) : undefined
  const fresh = cached && Date.now() - cached.at < DNS_TTL_MS ? cached : null
  const [v4, v6] = needsV4 || needsV6
    ? fresh
      ? [fresh.v4, fresh.v6]
      : await Promise.all([needsV4 ? dnsLookup(host, 'ipv4') : null, needsV6 ? dnsLookup(host, 'ipv6') : null])
    : [null, null]
  if ((needsV4 || needsV6) && !fresh) dnsMemo.set(host, { at: Date.now(), v4, v6 })
  for (const kind of want) {
    if (kind === 'domain') {
      out.push({ address: host, sni: host, kind })
      continue
    }
    const resolved = kind === 'ipv4' ? v4 : v6
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
 * Short, readable endpoint label for remarks: "odyssey-tunnel.abc.workers.dev"
 * → "odyssey-tunnel", "ir1.example.com" → "ir1". Only used when the admin
 * registered more than one endpoint, so configs from different locations
 * are telling apart at a glance.
 */
function endpointTag(host: string): string {
  const h = (host || '').trim().split('/')[0].split(':')[0]
  const parts = h.split('.').filter(Boolean)
  const label =
    h.toLowerCase().endsWith('.workers.dev') || parts.length > 2 ? (parts[0] || h) : h
  return label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 20) || 'ep'
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

  // Zeus-style port fan-out: one account per selected port (443 is the base
  // and always present). Cloudflare-fronted TLS ports keep TLS; CF plain-HTTP
  // ports emit a tls:false ws variant; ANY other port the admin typed by hand
  // (custom backends / self-hosted nodes) is honoured as-is with TLS on.
  const portSet = new Set<number>([443])
  for (const p of opts.ports || []) {
    const n = Math.round(Number(p))
    if (n && n >= 1 && n <= 65535) portSet.add(n)
  }
  const ports = [...portSet]
  const httpPorts = new Set<number>(CF_HTTP_PORTS)

  // Shadowsocks is password-encrypted end-to-end by the tunnel worker with a
  // SINGLE deployment-wide password (TUNNEL_SS_PASSWORD / PATH_SECRET) — a
  // per-account random password can never decrypt. The account password must
  // therefore BE the tunnel secret path (baked at deploy time).
  // One settings read serves both this and the clean-IP override below.
  const { getSettings } = await import('@/lib/settings')
  const settingsRow = await getSettings()
  let ssPassword: string | null = null
  if (protocols.includes('shadowsocks')) {
    const p = (settingsRow.tunnelPath || '').replace(/^\/+|\/+$/g, '').trim()
    ssPassword = p || null
  }

  // Clean-IP connect override (Zeus behavior): when the admin sets a clean /
  // best Cloudflare edge IP in Settings, configs can dial it directly while
  // SNI/Host stay the real tunnel host — the biggest real-throughput lever
  // on ISPs that throttle or badly route the default anycast path.
  let cleanIp = (settingsRow.tunnelCleanIp || '').trim()
  if (cleanIp) {
    try {
      cleanIp = new URL(cleanIp.includes('://') ? cleanIp : `https://${cleanIp}`).hostname
    } catch {
      /* keep as typed */
    }
  }

  const count = Math.min(Math.max(1, opts.count ?? 1), 8)
  const out: GeneratedAccount[] = []
  // hard cap so a wild multi-select can't explode the table
  const CAP = 64
  // duplicate remarks get a numbered suffix so every config stays unique
  const seen = new Map<string, number>()

  outer: for (let li = 0; li < endpoints.length; li++) {
    const ep = endpoints[li]
    // Variant selection: explicit picks win. With a clean IP configured the
    // default becomes clean + domain (clean first — Zeus-style speed default).
    const rawTypes: Array<'clean' | 'domain' | 'ipv4' | 'ipv6'> =
      opts.addressTypes && opts.addressTypes.length
        ? opts.addressTypes
        : cleanIp
          ? (['clean', 'domain'] as Array<'clean' | 'domain' | 'ipv4' | 'ipv6'>)
          : (['domain'] as Array<'clean' | 'domain' | 'ipv4' | 'ipv6'>)
    const wantClean = rawTypes.includes('clean') && !!cleanIp && cleanIp !== ep.host
    const dnsTypes = rawTypes.filter((t) => t !== 'clean') as Array<'domain' | 'ipv4' | 'ipv6'>
    const resolved = dnsTypes.length ? await hostVariants(ep.host, dnsTypes) : []
    const variants = wantClean
      ? [{ address: cleanIp, sni: ep.host, kind: 'clean' as const }, ...resolved]
      : resolved
    for (const proto of protocols) {
      for (let i = 0; i < count; i++) {
        for (const v of variants) {
          for (const port of ports) {
            const fieldsBase = ep.custom
              ? customFields(v.address, proto, `/vlessws-${proto}`)
              : await tunnelFieldFor(proto)
            if (!fieldsBase) continue
            // plain-HTTP ports only make sense for ws (grpc/tcp on CF need TLS)
            const plain = httpPorts.has(port) && fieldsBase.transport === 'ws'
            const fields: BuiltinFields =
              port === 443 && !plain
                ? fieldsBase
                : (plain
                    ? { ...fieldsBase, port, tls: false }
                    : { ...fieldsBase, port }) as BuiltinFields
            // Clean, informative remark — everything a user needs at a glance:
            //   "Ali · VLESS"                     one endpoint, domain, TLS 443
            //   "Ali · VLESS · TLS 2053 · v4"     alt TLS port resolved to IPv4
            //   "Ali · VLESS · plain 80"          no-TLS ws variant (anti-throttle)
            //   "Ali · Trojan · myrelay #2"       second endpoint, repeat #2
            const protoTag = proto === 'shadowsocks' ? 'SS' : proto.toUpperCase()
            const tags: string[] = []
            if (ports.length > 1 || port !== 443) {
              tags.push(plain ? `plain ${port}` : port !== 443 ? `TLS ${port}` : '')
            }
            if (variants.length > 1 && v.kind !== 'domain')
              tags.push(v.kind === 'clean' ? 'clean' : v.kind === 'ipv4' ? 'v4' : 'v6')
            if (endpoints.length > 1) tags.push(endpointTag(ep.host))
            const base = `${opts.name} · ${protoTag}${tags.filter(Boolean).length ? ` · ${tags.filter(Boolean).join(' · ')}` : ''}`
            const seenN = (seen.get(base) || 0) + 1
            seen.set(base, seenN)
            const remark = count > 1 || seenN > 1 ? `${base} #${seenN}` : base
            const secret = proto === 'shadowsocks' && ssPassword ? ssPassword : generateSecret(proto)
            out.push(finalize(fields, proto, remark, secret, opts))
            if (out.length >= CAP) break outer
          }
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
  // SPEED: insert all accounts in parallel — one round-trip wave instead of
  // one sequential D1 insert per account (a 18-account config used to pay
  // 18 sequential round trips before this change).
  await Promise.all(
    accounts.map((a) =>
      db.proxy.create({
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
      }),
    ),
  )
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
    // ECH encrypts the TLS ClientHello — meaningless (and confusing for
    // clients) on plain-HTTP port variants, so it is dropped there.
    ech: fields.tls ? opts.ech || null : null,
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
