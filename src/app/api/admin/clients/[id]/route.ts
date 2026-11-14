import { db } from '@/lib/db'
import { requireAuth, jsonSafe } from '@/lib/auth'
import { regenerateSubscription, invalidateSubscription } from '@/lib/subcache'

export const runtime = 'nodejs'

type Params = { params: Promise<{ id: string }> }

type PatchBody = {
  name?: string
  note?: string
  trafficGb?: number
  daysExtend?: number
  expiresAt?: string | null
  status?: 'active' | 'disabled'
  requestLimit?: number
  ipLimit?: number
  resetBytesDays?: number
  resetRequestsDays?: number
  directEnabled?: boolean
  fingerprint?: string
  isp?: string | null
  resetTraffic?: boolean // reset usedBytes
  resetRequests?: boolean // reset usedRequests
  anchorFirstConnection?: boolean // set startedAt = now (start-from-first-connection)
}

export async function GET(_req: Request, { params }: Params) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const { id } = await params
  const client = await db.client.findUnique({ where: { id }, include: { proxies: true } })
  if (!client) return Response.json({ error: 'Not found' }, { status: 404 })
  return jsonSafe({ client })
}

export async function PATCH(req: Request, { params }: Params) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as PatchBody
  const client = await db.client.findUnique({ where: { id } })
  if (!client) return Response.json({ error: 'Not found' }, { status: 404 })

  const data: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = body.name.trim()
    if (!name) return Response.json({ error: 'Name required' }, { status: 400 })
    const dupe = await db.client.findFirst({ where: { name, id: { not: id } } })
    if (dupe) return Response.json({ error: 'Name already exists' }, { status: 409 })
    data.name = name
  }
  if (body.note !== undefined) data.note = body.note || null
  if (body.trafficGb !== undefined) data.limitBytes = BigInt(Math.round(body.trafficGb * 1024 ** 3))
  if (body.status !== undefined) data.status = body.status
  if (body.requestLimit !== undefined) data.requestLimit = Math.max(0, Math.round(body.requestLimit))
  if (body.ipLimit !== undefined) data.ipLimit = Math.max(0, Math.round(body.ipLimit))
  if (body.resetBytesDays !== undefined) data.resetBytesDays = Math.max(0, Math.round(body.resetBytesDays))
  if (body.resetRequestsDays !== undefined) data.resetRequestsDays = Math.max(0, Math.round(body.resetRequestsDays))
  if (body.directEnabled !== undefined) data.directEnabled = Boolean(body.directEnabled)
  if (body.fingerprint !== undefined) data.fingerprint = body.fingerprint.trim() || 'chrome'
  if (body.isp !== undefined) data.isp = body.isp?.trim() || null
  if (body.resetTraffic) data.usedBytes = BigInt(0)
  if (body.resetRequests) data.usedRequests = 0
  if (body.anchorFirstConnection) data.startedAt = new Date()
  if (body.expiresAt !== undefined) {
    data.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null
  }
  if (body.daysExtend && body.daysExtend > 0) {
    const current = client.expiresAt && client.expiresAt.getTime() > Date.now() ? client.expiresAt.getTime() : Date.now()
    data.expiresAt = new Date(current + body.daysExtend * 86400000)
  }

  const updated = await db.client.update({ where: { id }, data, include: { proxies: true } })
  await regenerateSubscription(id)
  return jsonSafe({ client: updated })
}

export async function DELETE(_req: Request, { params }: Params) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const { id } = await params
  const client = await db.client.findUnique({ where: { id }, select: { subToken: true } })
  await db.client.delete({ where: { id } })
  if (client) await invalidateSubscription(client.subToken)
  return Response.json({ ok: true })
}
