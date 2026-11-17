import { db } from '@/lib/db'
import { requireAuth, jsonSafe } from '@/lib/auth'
import { buildServerConfig, isValidFragment } from '@/lib/links'
import { generateSecret, validateProtocol } from '@/lib/secrets'
import { normalizeProxyTarget, panelHost, syncBackend } from '@/lib/backend'
import { newRealityParams, REALITY_FLOW, parseReality } from '@/lib/reality'
import { regenerateSubscription } from '@/lib/subcache'
import { memoDrop } from '@/lib/memo'

export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }

type ProxyBody = {
  protocol?: string
  remark?: string
  address?: string
  port?: number
  sni?: string
  host?: string
  path?: string
  transport?: string
  tls?: boolean
  fragment?: string
  fp?: string
  ech?: string
  plugin?: string
  flow?: string
  /** true → force VLESS-Reality (tcp transport, vision flow, auto pbk/sid) */
  reality?: boolean
}

export async function POST(req: Request, { params }: Params) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const { id } = await params
  const client = await db.client.findUnique({ where: { id } })
  if (!client) return Response.json({ error: 'Client not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as ProxyBody
  const protocol = body.protocol || 'vless'
  const protoErr = validateProtocol(protocol)
  if (protoErr) return Response.json({ error: protoErr }, { status: 400 })
  if (body.fragment !== undefined && !isValidFragment(body.fragment)) {
    return Response.json({ error: 'Invalid fragment value' }, { status: 400 })
  }
  const address = (body.address || '').trim()
  const port = Number(body.port)
  const norm = await normalizeProxyTarget(
    {
      address,
      port,
      sni: body.sni,
      host: body.host,
      path: body.path,
      transport: body.transport,
      tls: body.tls,
    },
    await panelHost(),
  )
  // An empty address is fine when the edge tunnel worker is deployed — it
  // becomes the default backend (norm.address = tunnel host).
  if (!address && !norm.address) {
    return Response.json({ error: 'Valid address required' }, { status: 400 })
  }
  const finalPort = norm.port ?? port
  if (!finalPort || finalPort < 1 || finalPort > 65535) {
    return Response.json({ error: 'Valid port required' }, { status: 400 })
  }

  const secret = generateSecret(protocol)

  // ── VLESS-Reality (VPS backend) ────────────────────────────────────────
  let realityJson: string | null = null
  let realityPriv: string | null = null
  let transport = norm.transport ?? 'ws'
  let tls = norm.tls ?? true
  let flow = body.flow?.trim() || null
  if (body.reality === true) {
    if (protocol !== 'vless') {
      return Response.json({ error: 'Reality is only available for vless' }, { status: 400 })
    }
    transport = 'tcp'
    tls = true
    flow = flow || REALITY_FLOW
    const r = await newRealityParams()
    if (!r) {
      return Response.json(
        { error: 'Reality keys unavailable on this runtime — run the panel on Node (VPS/Docker) once' },
        { status: 400 },
      )
    }
    realityJson = JSON.stringify(r.params)
    realityPriv = r.priv
  }

  // Free naming: the admin types whatever remark they want; empty falls
  // back to the client's name (no forced prefix — Zeus-style clean labels).
  const rawRemark = body.remark?.trim() || ''
  const proxyLike = {
    protocol,
    remark: rawRemark || client.name,
    address: norm.address,
    port: finalPort,
    secret,
    sni: norm.sni ?? null,
    host: norm.host ?? null,
    path: norm.path ?? '/',
    transport,
    tls,
    flow,
    fragment: body.fragment?.trim() || null,
    fp: body.fp?.trim() || null,
    ech: body.ech?.trim() || null,
    plugin: body.plugin?.trim() || null,
    reality: realityJson ? parseReality(realityJson) : null,
    realityPriv,
  }

  const proxy = await db.proxy.create({
    data: {
      clientId: id,
      protocol: proxyLike.protocol,
      remark: proxyLike.remark,
      address: proxyLike.address,
      port: proxyLike.port,
      secret,
      sni: proxyLike.sni,
      host: proxyLike.host,
      path: proxyLike.path,
      transport: proxyLike.transport,
      tls: proxyLike.tls,
      flow: proxyLike.flow,
      fragment: proxyLike.fragment,
      fp: proxyLike.fp,
      ech: proxyLike.ech,
      plugin: proxyLike.plugin,
      reality: realityJson,
      serverConfig: JSON.stringify(buildServerConfig(proxyLike)),
    },
  })
  syncBackend()
  memoDrop()
  await regenerateSubscription(id)
  return jsonSafe({ proxy }, { status: 201 })
}