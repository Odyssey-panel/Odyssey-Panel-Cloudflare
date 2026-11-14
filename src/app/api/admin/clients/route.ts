import { db } from '@/lib/db'
import { requireAuth, jsonSafe } from '@/lib/auth'
import { randomBytes } from 'node:crypto'
import { generateAccounts, persistAccounts } from '@/lib/accounts'
import { regenerateSubscription } from '@/lib/subcache'
import { syncBackend } from '@/lib/backend'

export const runtime = 'nodejs'

type CreateBody = {
  name?: string
  note?: string
  trafficGb?: number // 0 = unlimited
  days?: number // days from now; 0/null = never
  expiresAt?: string | null
  // quotas (0 = unlimited)
  requestLimit?: number
  ipLimit?: number
  // auto reset cycles in days (0 = never)
  resetBytesDays?: number
  resetRequestsDays?: number
  // allow the direct (no-proxy) config for this user
  directEnabled?: boolean
  // TLS ClientHello fingerprint + ISP tag
  fingerprint?: string
  isp?: string
  // expiry anchored to the first connection instead of creation time
  startOnFirstConnection?: boolean
  // account generation
  protocols?: string[] // vless | trojan | shadowsocks (multi-select)
  workers?: string[] // tunnel endpoint urls (multi-location)
  addressTypes?: Array<'domain' | 'ipv4' | 'ipv6'>
  count?: number
  fragment?: string
  sni?: string
}

export async function GET() {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const clients = await db.client.findMany({
    include: { proxies: true },
    orderBy: { createdAt: 'desc' },
  })
  return jsonSafe({ clients })
}

export async function POST(req: Request) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const body = (await req.json().catch(() => ({}))) as CreateBody

  const name = (body.name || '').trim()
  if (!name) return Response.json({ error: 'Name required' }, { status: 400 })
  const exists = await db.client.findUnique({ where: { name } })
  if (exists) return Response.json({ error: 'Name already exists' }, { status: 409 })

  const subToken = randomBytes(16).toString('hex')
  const expiresAt =
    body.expiresAt
      ? new Date(body.expiresAt)
      : body.days && body.days > 0
        ? new Date(Date.now() + body.days * 86400000)
        : null
  if (expiresAt && isNaN(expiresAt.getTime())) {
    return Response.json({ error: 'Invalid expiry date' }, { status: 400 })
  }

  const client = await db.client.create({
    data: {
      name,
      note: body.note || null,
      limitBytes: BigInt(Math.round((body.trafficGb ?? 0) * 1024 ** 3)),
      expiresAt,
      requestLimit: Math.max(0, Math.round(body.requestLimit ?? 0)),
      ipLimit: Math.max(0, Math.round(body.ipLimit ?? 0)),
      resetBytesDays: Math.max(0, Math.round(body.resetBytesDays ?? 0)),
      resetRequestsDays: Math.max(0, Math.round(body.resetRequestsDays ?? 0)),
      directEnabled: body.directEnabled !== false,
      fingerprint: (body.fingerprint || 'chrome').trim(),
      isp: body.isp?.trim() || null,
      subToken,
    },
  })

  let generationError: string | null = null
  const requested = (body.protocols || []).filter(Boolean)
  if (requested.length) {
    try {
      const accounts = await generateAccounts({
        name,
        protocols: requested,
        workers: body.workers || [],
        addressTypes: body.addressTypes || [],
        count: body.count,
        fragment: body.fragment || null,
        fingerprint: (body.fingerprint || 'chrome').trim(),
        sni: body.sni,
      })
      await persistAccounts(client.id, accounts)
    } catch (e) {
      generationError = e instanceof Error ? e.message : 'Account generation failed'
    }
  }

  await regenerateSubscription(client.id)
  syncBackend()
  const created = await db.client.findUnique({ where: { id: client.id }, include: { proxies: true } })
  return jsonSafe({ client: created, generationError }, { status: 201 })
}

export async function DELETE(req: Request) {
  // bulk delete by ids in body
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const { ids } = (await req.json().catch(() => ({}))) as { ids?: string[] }
  if (!ids?.length) return Response.json({ error: 'ids required' }, { status: 400 })
  const doomed = await db.client.findMany({ where: { id: { in: ids } }, select: { subToken: true } })
  await db.client.deleteMany({ where: { id: { in: ids } } })
  await Promise.allSettled(doomed.map((c) => import('@/lib/subcache').then((m) => m.invalidateSubscription(c.subToken))))
  syncBackend()
  return Response.json({ ok: true })
}
