import { db } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { regenerateSubscription, invalidateSubscription } from '@/lib/subcache'

export const runtime = 'nodejs'

/**
 * Bulk operations on many clients at once (the admin selects rows and
 * applies one action):
 *   enable | disable | delete | resetTraffic | resetRequests | extendDays
 */
export async function POST(req: Request) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized
  const body = (await req.json().catch(() => ({}))) as {
    ids?: string[]
    action?: 'enable' | 'disable' | 'delete' | 'resetTraffic' | 'resetRequests' | 'extendDays'
    days?: number
  }
  const ids = (body.ids || []).filter(Boolean)
  const action = body.action
  if (!ids.length || !action) {
    return Response.json({ error: 'ids and action required' }, { status: 400 })
  }

  let affected = 0
  switch (action) {
    case 'enable':
      affected = (await db.client.updateMany({ where: { id: { in: ids } }, data: { status: 'active' } })).count
      break
    case 'disable':
      affected = (await db.client.updateMany({ where: { id: { in: ids } }, data: { status: 'disabled' } })).count
      break
    case 'resetTraffic':
      affected = (await db.client.updateMany({ where: { id: { in: ids } }, data: { usedBytes: BigInt(0) } })).count
      break
    case 'resetRequests':
      affected = (await db.client.updateMany({ where: { id: { in: ids } }, data: { usedRequests: 0 } })).count
      break
    case 'extendDays': {
      const days = Math.max(1, Math.round(body.days || 30))
      const targets = await db.client.findMany({ where: { id: { in: ids } }, select: { id: true, expiresAt: true } })
      for (const c of targets) {
        const base = c.expiresAt && c.expiresAt.getTime() > Date.now() ? c.expiresAt.getTime() : Date.now()
        await db.client.update({ where: { id: c.id }, data: { expiresAt: new Date(base + days * 86400000) } })
        affected++
      }
      break
    }
    case 'delete': {
      const doomed = await db.client.findMany({ where: { id: { in: ids } }, select: { subToken: true } })
      affected = (await db.client.deleteMany({ where: { id: { in: ids } } })).count
      await Promise.allSettled(doomed.map((c) => invalidateSubscription(c.subToken)))
      return Response.json({ ok: true, affected })
    }
    default:
      return Response.json({ error: 'Unknown action' }, { status: 400 })
  }

  // refresh the edge cache for every touched user
  await Promise.allSettled(ids.map((id) => regenerateSubscription(id)))
  return Response.json({ ok: true, affected })
}
