import { db } from '@/lib/db'
import { formatBytes } from '@/lib/format'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ token: string }> }

/**
 * Public per-user subscription status page (self-service portal).
 * Shows quota/traffic/expiry — no secrets, no config links.
 */
export default async function SubStatusPage({ params }: Props) {
  const { token } = await params
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    return <StatusCard title='Odyssey' rows={[]} state='notfound' />
  }
  const client = await db.client.findUnique({
    where: { subToken: token },
    include: { proxies: { select: { protocol: true, remark: true } } },
  })
  if (!client) return <StatusCard title='Odyssey' rows={[]} state='notfound' />

  const expired = client.expiresAt && client.expiresAt.getTime() < Date.now()
  const trafficOver = client.limitBytes > 0 && client.usedBytes >= client.limitBytes
  const state = client.status !== 'active' ? 'disabled' : expired ? 'expired' : trafficOver ? 'over' : 'active'

  const rows: Array<[string, string]> = [
    ['Protocol count', String(client.proxies.length)],
    [
      'Traffic',
      client.limitBytes > 0
        ? `${formatBytes(Number(client.usedBytes))} / ${formatBytes(Number(client.limitBytes))}`
        : `${formatBytes(Number(client.usedBytes))} (unlimited)`,
    ],
    ['Requests', client.requestLimit > 0 ? `${client.usedRequests} / ${client.requestLimit}` : String(client.usedRequests)],
    [
      'Expiry',
      !client.expiresAt
        ? 'unlimited'
        : `${client.expiresAt.toISOString().slice(0, 10)} (${Math.max(0, Math.ceil((client.expiresAt.getTime() - Date.now()) / 86400000))} days left)`,
    ],
    ['Last update', client.updatedAt.toISOString().slice(0, 16).replace('T', ' ')],
  ]

  return <StatusCard title={`Odyssey — ${client.name}`} rows={rows} state={state} />
}

function StatusCard({
  title,
  rows,
  state,
}: {
  title: string
  rows: Array<[string, string]>
  state: 'active' | 'disabled' | 'expired' | 'over' | 'notfound'
}) {
  const badge = {
    active: { text: 'Active', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    disabled: { text: 'Disabled', cls: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400' },
    expired: { text: 'Expired', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    over: { text: 'Traffic limit', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
    notfound: { text: 'Not found', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
  }[state]
  return (
    <main className='mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6'>
      <div className='rounded-2xl border bg-card p-6 shadow-sm'>
        <div className='flex items-center justify-between gap-3'>
          <h1 className='text-lg font-bold tracking-tight'>{title}</h1>
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${badge.cls}`}>{badge.text}</span>
        </div>
        <dl className='mt-4 space-y-2 text-sm'>
          {rows.map(([k, v]) => (
            <div key={k} className='flex items-center justify-between gap-3 border-t pt-2 first:border-t-0'>
              <dt className='text-muted-foreground'>{k}</dt>
              <dd className='font-medium' dir='ltr'>{v}</dd>
            </div>
          ))}
        </dl>
        {rows.length === 0 && (
          <p className='mt-3 text-sm text-muted-foreground'>This subscription link does not exist.</p>
        )}
      </div>
      <p className='text-center text-xs text-muted-foreground'>Odyssey Panel — self-service status</p>
    </main>
  )
}
