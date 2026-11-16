'use client'

import { useEffect, useRef, useState } from 'react'
import { parseVlessUri, runDeviceTest } from '@/lib/selftest'

type Item = { remark: string; protocol: string; uri: string }
type Status = 'probe' | 'ok' | 'fail' | 'skip'

/**
 * Silent device test for every vless config, straight from the user's
 * device — real reachability, not just a TCP ping. Results feed the
 * auto-heal: dead/weak protocols get replaced on the server side.
 */
export default function SubProbe({ token, items }: { token: string; items: Item[] }) {
  const [status, setStatus] = useState<Record<string, { st: Status; ms?: number }>>({})
  const [healed, setHealed] = useState<number | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    const run = async () => {
      const results: Array<{ remark: string; ok: boolean; ms?: number }> = []
      for (const it of items) {
        if (it.protocol !== 'vless') {
          setStatus((s) => ({ ...s, [it.remark]: { st: 'skip' } }))
          continue
        }
        setStatus((s) => ({ ...s, [it.remark]: { st: 'probe' } }))
        const target = parseVlessUri(it.uri)
        if (!target) {
          setStatus((s) => ({ ...s, [it.remark]: { st: 'skip' } }))
          results.push({ remark: it.remark, ok: false })
          continue
        }
        try {
          const res = await runDeviceTest(target)
          const ok = res.verdict === 'ok'
          const ms = res.steps.find((x) => x.state === 'ok')?.latencyMs
          setStatus((s) => ({ ...s, [it.remark]: { st: ok ? 'ok' : 'fail', ms } }))
          results.push({ remark: it.remark, ok, ms })
        } catch {
          setStatus((s) => ({ ...s, [it.remark]: { st: 'fail' } }))
          results.push({ remark: it.remark, ok: false })
        }
      }
      try {
        const r = await fetch(`/api/sub/${token}/report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ results }),
        })
        const j = (await r.json()) as { replaced?: number }
        if (j.replaced) setHealed(j.replaced)
      } catch {
        // reporting is best-effort
      }
    }
    run()
  }, [items, token])

  if (!items.length) return null

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="text-xs font-semibold text-white/70">
        وضعیت کانفیگ‌ها — تست از همین دستگاه
        <span className="text-white/35"> · live config test</span>
      </div>
      <div className="mt-3 space-y-2">
        {items.map((it) => {
          const s = status[it.remark]
          const st = s?.st || 'probe'
          return (
            <div key={it.remark} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-white/75" dir="ltr">
                {it.remark}
              </span>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 font-semibold ${
                  st === 'ok'
                    ? 'bg-emerald-400/15 text-emerald-300'
                    : st === 'fail'
                      ? 'bg-rose-400/15 text-rose-300'
                      : st === 'skip'
                        ? 'bg-white/10 text-white/45'
                        : 'bg-amber-400/15 text-amber-300'
                }`}
              >
                {st === 'ok'
                  ? `سبز · ${s?.ms ?? ''}ms`
                  : st === 'fail'
                    ? 'قطع / ضعیف'
                    : st === 'skip'
                      ? '—'
                      : 'در حال تست…'}
              </span>
            </div>
          )
        })}
      </div>
      {healed ? (
        <p className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs leading-relaxed text-emerald-200">
          {healed} کانفیگ قطع/ضعیف خودکار جایگزین شد — ساب را در برنامه دوباره آپدیت کنید.
          <br />
          <span className="text-emerald-200/60">{healed} config(s) auto-replaced — refresh the sub in your app.</span>
        </p>
      ) : null}
    </div>
  )
}
