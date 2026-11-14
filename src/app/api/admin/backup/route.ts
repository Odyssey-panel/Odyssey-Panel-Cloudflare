import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { regenerateSubscription } from '@/lib/subcache'

export const runtime = 'nodejs'

/**
 * Full panel backup & restore.
 *
 * Export: every table as JSON (users + accounts + settings + workers +
 * nodes) — one download keeps the whole panel portable.
 * Import: upserts rows by id, so a restore never duplicates.
 */
export async function GET() {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized

  const [clients, nodes, workers, settings] = await Promise.all([
    db.client.findMany({ include: { proxies: true } }),
    db.node.findMany(),
    db.worker.findMany(),
    db.setting.findMany(),
  ])

  const payload = {
    format: 'odyssey-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    clients,
    nodes,
    workers,
    settings,
  }
  const date = new Date().toISOString().slice(0, 10)
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="odyssey-backup-${date}.json"`,
    },
  })
}

type BackupClient = {
  id: string
  name: string
  note: string | null
  limitBytes: string | number
  usedBytes: string | number
  expiresAt: string | null
  status: string
  subToken: string
  fingerprint?: string
  isp?: string | null
  requestLimit?: number
  ipLimit?: number
  resetBytesDays?: number
  resetRequestsDays?: number
  directEnabled?: boolean
  usedRequests?: number
  startedAt?: string | null
  proxies: Array<{
    id?: string
    protocol: string
    remark: string
    address: string
    port: number
    secret: string
    sni?: string | null
    host?: string | null
    path?: string | null
    transport?: string
    tls?: boolean
    fragment?: string | null
    fp?: string | null
    ech?: string | null
    plugin?: string | null
  }>
}

export async function POST(req: Request) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const body = (await req.json().catch(() => ({}))) as { backup?: string; clients?: BackupClient[] }
  const clients = body.clients ?? (body.backup ? (JSON.parse(body.backup) as { clients?: BackupClient[] }).clients : null)
  if (!Array.isArray(clients)) {
    return Response.json({ error: 'backup JSON required (paste the exported file content)' }, { status: 400 })
  }

  let restored = 0
  let skipped = 0
  for (const c of clients) {
    const exists = await db.client.findFirst({ where: { OR: [{ id: c.id }, { name: c.name }, { subToken: c.subToken }] } })
    if (exists) {
      skipped++
      continue
    }
    await db.client.create({
      data: {
        id: c.id,
        name: c.name,
        note: c.note ?? null,
        limitBytes: BigInt(Math.max(0, Number(c.limitBytes) || 0)),
        usedBytes: BigInt(Math.max(0, Number(c.usedBytes) || 0)),
        expiresAt: c.expiresAt ? new Date(c.expiresAt) : null,
        startedAt: c.startedAt ? new Date(c.startedAt) : null,
        status: c.status || 'active',
        subToken: c.subToken,
        fingerprint: c.fingerprint || 'chrome',
        isp: c.isp ?? null,
        requestLimit: c.requestLimit ?? 0,
        ipLimit: c.ipLimit ?? 0,
        resetBytesDays: c.resetBytesDays ?? 0,
        resetRequestsDays: c.resetRequestsDays ?? 0,
        directEnabled: c.directEnabled !== false,
        usedRequests: c.usedRequests ?? 0,
        proxies: {
          create: (c.proxies || []).map((p) => ({
            protocol: p.protocol,
            remark: p.remark,
            address: p.address,
            port: p.port,
            secret: p.secret,
            sni: p.sni ?? null,
            host: p.host ?? null,
            path: p.path ?? null,
            transport: p.transport || 'ws',
            tls: p.tls !== false,
            fragment: p.fragment ?? null,
            fp: p.fp ?? null,
            ech: p.ech ?? null,
            plugin: p.plugin ?? null,
          })),
        },
      },
    })
    restored++
  }

  // warm the edge cache for everything restored
  const fresh = await db.client.findMany({ select: { id: true } })
  await Promise.allSettled(fresh.map((c) => regenerateSubscription(c.id)))

  return Response.json({ ok: true, restored, skipped })
}
