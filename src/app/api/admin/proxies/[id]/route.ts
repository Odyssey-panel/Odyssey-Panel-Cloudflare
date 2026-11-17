import { db } from '@/lib/db'
import { requireAuth, jsonSafe } from '@/lib/auth'
import { buildServerConfig, isValidFragment } from '@/lib/links'
import { generateSecret } from '@/lib/secrets'
import { normalizeProxyTarget, panelHost, syncBackend } from '@/lib/backend'
import { newRealityParams, getRealityKeys, parseReality, REALITY_FLOW } from '@/lib/reality'
import { regenerateSubscription } from '@/lib/subcache'

export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: Params) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const { id } = await params
  const proxy = await db.proxy.findUnique({ where: { id } })
  if (!proxy) return Response.json({ error: 'Not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  const data: Record<string, unknown> = {}
  for (const key of ['remark', 'sni', 'host', 'path', 'transport'] as const) {
    if (body[key] !== undefined) data[key] = String(body[key])
  }
  // address goes through URL repair (a pasted "https://host/path" must never
  // end up verbatim in a vless:// link)
  if (body.address !== undefined) {
    const norm = await normalizeProxyTarget(
      {
        address: String(body.address),
        port: body.port !== undefined ? Number(body.port) : undefined,
        sni: body.sni !== undefined ? String(body.sni) : undefined,
        host: body.host !== undefined ? String(body.host) : undefined,
        path: body.path !== undefined ? String(body.path) : undefined,
        transport: body.transport !== undefined ? String(body.transport) : undefined,
        tls: body.tls !== undefined ? Boolean(body.tls) : undefined,
      },
      await panelHost(),
    )
    data.address = norm.address
    if (norm.port !== undefined) data.port = norm.port
    if (norm.sni !== undefined) data.sni = norm.sni
    if (norm.host !== undefined) data.host = norm.host
    if (norm.path !== undefined) data.path = norm.path
    if (norm.transport !== undefined) data.transport = norm.transport
    if (norm.tls !== undefined) data.tls = norm.tls
  }
  if (body.port !== undefined && data.port === undefined) data.port = Number(body.port)
  if (body.tls !== undefined) data.tls = Boolean(body.tls)
  if (body.fragment !== undefined) {
    if (!isValidFragment(String(body.fragment))) {
      return Response.json({ error: 'Invalid fragment value' }, { status: 400 })
    }
    data.fragment = String(body.fragment).trim() || null
  }
  if (body.rotateSecret === true) {
    data.secret = generateSecret(proxy.protocol)
  }
  for (const key of ['fp', 'ech', 'plugin'] as const) {
    if (body[key] !== undefined) data[key] = String(body[key]).trim() || null
  }
  if (body.flow !== undefined) data.flow = String(body.flow).trim() || null

  // ── VLESS-Reality toggle (VPS backend) ─────────────────────────────────
  if (body.reality !== undefined) {
    const want = Boolean(body.reality)
    if (want) {
      if (proxy.protocol !== 'vless') {
        return Response.json({ error: 'Reality is only available for vless' }, { status: 400 })
      }
      if (!parseReality(proxy.reality)) {
        const r = await newRealityParams()
        if (!r) {
          return Response.json(
            { error: 'Reality keys unavailable on this runtime — run the panel on Node (VPS/Docker) once' },
            { status: 400 },
          )
        }
        data.reality = JSON.stringify(r.params)
      }
      data.transport = 'tcp'
      data.tls = true
      if (body.flow === undefined && !proxy.flow) data.flow = REALITY_FLOW
    } else {
      data.reality = null
    }
  }

  const updated = await db.proxy.update({ where: { id }, data })
  // rebuild server config snapshot (preserve flow + reality)
  const keys = parseReality(updated.reality) ? await getRealityKeys() : null
  await db.proxy.update({
    where: { id },
    data: {
      serverConfig: JSON.stringify(
        buildServerConfig({
          protocol: updated.protocol,
          remark: updated.remark,
          address: updated.address,
          port: updated.port,
          secret: updated.secret,
          sni: updated.sni,
          host: updated.host,
          path: updated.path,
          transport: updated.transport,
          tls: updated.tls,
          flow: updated.flow,
          reality: parseReality(updated.reality),
          realityPriv: keys?.priv ?? null,
        })
      ),
    },
  })
  const fresh = await db.proxy.findUnique({ where: { id } })
  syncBackend()
  await regenerateSubscription(proxy.clientId)
  return jsonSafe({ proxy: fresh })
}

export async function DELETE(_req: Request, { params }: Params) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const { id } = await params
  const proxy = await db.proxy.findUnique({ where: { id }, select: { clientId: true } })
  await db.proxy.delete({ where: { id } })
  syncBackend()
  if (proxy) await regenerateSubscription(proxy.clientId)
  return Response.json({ ok: true })
}
