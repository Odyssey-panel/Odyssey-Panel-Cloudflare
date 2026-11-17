import { db } from '@/lib/db'
import { headers } from 'next/headers'
import { buildShareLink, type ProxyLike } from '@/lib/links'
import SubProbe from './sub-probe'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ token: string }> }

/**
 * Public subscription page — the human-facing side of the sub link.
 * Silently device-tests every vless config (the user's own network is the
 * only honest liveness source), reports the results so dead/weak protocols
 * get auto-replaced, and shows the tap-to-copy subscription link.
 */
export default async function SubPage({ params }: Props) {
  const { token } = await params
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    return <Shell title="Odyssey">{p('لینک نامعتبر است', 'Invalid link')}</Shell>
  }

  const client = await db.client.findUnique({
    where: { subToken: token },
    include: { proxies: true },
  })
  if (!client || client.status !== 'active') {
    return (
      <Shell title="Odyssey">
        {p('اشتراک یافت نشد یا غیرفعال است', 'Subscription not found or disabled')}
      </Shell>
    )
  }

  const h = await headers()
  const origin =
    (h.get('x-forwarded-proto') || 'https') + '://' + (h.get('host') || '')
  const subUrl = `${origin}/api/sub/${token}`

  const items = client.proxies.map((px) => {
    const like: ProxyLike = {
      protocol: px.protocol,
      remark: px.remark,
      address: px.address,
      port: px.port,
      secret: px.secret,
      sni: px.sni,
      host: px.host,
      path: px.path,
      transport: px.transport,
      tls: px.tls,
      flow: px.flow,
      fragment: px.fragment,
      fp: px.fp,
      ech: px.ech,
      plugin: px.plugin,
    }
    return { remark: px.remark, protocol: px.protocol, uri: buildShareLink(like) }
  })

  return (
    <Shell title={`Odyssey · ${client.name}`}>
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <div className="text-sm font-semibold text-white/90">{client.name}</div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-white/60">
          <span>ترافیک مصرفی</span>
          <span className="text-left text-white/85" dir="ltr">
            {fmtGb(client.usedBytes)}{Number(client.limitBytes) > 0 ? ` / ${fmtGb(client.limitBytes)}` : ' (نامحدود)'}
          </span>
          <span>تاریخ انقضا</span>
          <span className="text-left text-white/85" dir="ltr">
            {client.expiresAt ? client.expiresAt.toISOString().slice(0, 10) : 'unlimited'}
          </span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-white/55">
          لینک زیر را در برنامه (v2rayNG / Hiddify / Streisand) اضافه کنید — هر بار آپدیت ساب، پروتکل‌های قطع یا ضعیف خودکار جایگزین می‌شوند.
          <br />
          <span className="text-white/40">Add this link to your VPN app — dead protocols are replaced automatically on every refresh.</span>
        </p>
        <input
          readOnly
          value={subUrl}
          className="mt-3 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2.5 font-mono text-xs text-emerald-300 outline-none"
          dir="ltr"
        />
      </div>
      <SubProbe token={token} items={items} />
      <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4">
        <div className="text-xs font-semibold text-amber-200">
          اگر کانفیگ‌ها وصل نمی‌شوند — چک‌لیست
          <span className="text-amber-200/50"> · if nothing connects</span>
        </div>
        <ol className="mt-2 list-decimal space-y-1.5 ps-4 text-xs leading-relaxed text-white/70">
          <li>
            اول کانفیگ‌های <span dir="ltr" className="font-mono text-emerald-300">· clean</span> را تست کن — با IP مستقیم وصل می‌شوند و DNS میانی را دور می‌زنند.
          </li>
          <li>
            کانفیگ‌های <span dir="ltr" className="font-mono text-emerald-300">· clean-fx</span> دارای Fragment هستند (ضد فیلترینگ SNI) — در Hiddify / Streisand / NekoBox خودکار اعمال می‌شود.
          </li>
          <li>
            در v2rayNG: تنظیمات → <b>Fragment</b> را روشن کن و دوباره تست بگیر.
          </li>
          <li>
            اگر DNS اپراتورت مسدود است، DNS گوشی را عوض کن (مثلاً Shecan <span dir="ltr">178.22.122.100</span> یا <span dir="ltr">8.8.8.8</span>) تا دامنه‌ها هم باز شوند.
          </li>
        </ol>
      </div>
    </Shell>
  )
}

function fmtGb(bytes: bigint): string {
  const gb = Number(bytes) / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(Number(bytes) / 1024 ** 2).toFixed(0)} MB`
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-4 bg-[#0a0e1a] px-4 py-10 font-sans">
      <div className="flex items-center gap-2">
        <span className="text-lg font-black tracking-tight text-white">Odyssey</span>
        <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">PANEL</span>
      </div>
      <title>{title}</title>
      {children}
    </main>
  )
}

function p(fa: string, en: string) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm leading-relaxed text-white/70">
      {fa}
      <br />
      <span className="text-white/40">{en}</span>
    </div>
  )
}
