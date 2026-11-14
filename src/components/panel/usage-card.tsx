'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useApi, api } from './api'
import { useLang } from '@/lib/i18n'
import { toast } from 'sonner'
import { Activity, Gauge, Loader2, Wifi } from 'lucide-react'

type Usage = {
  requests: { today: number; cap: number; percent: number; subscriptions: number; subscriptionsTotal: number; cloudflare: number | null }
  d1: { reads: number | null; writes: number | null; readsCap: number; writesCap: number; rows: { clients: number; proxies: number; nodes: number; workers: number } }
}

type PingResult = {
  colo: string | null
  avgEgressMs: number | null
  results: Array<{ label: string; ok: boolean; latencyMs: number; status?: number; error?: string }>
}

/**
 * Edge-quota watchdog + two-hop latency probe:
 *  - daily request counter (self-tracked, free-plan 100k cap) with progress
 *  - D1 row counts (database health at a glance)
 *  - one-click ping: browser→panel and panel→public internet
 */
export function UsageCard() {
  const { t } = useLang()
  const { data } = useApi<Usage>('/api/admin/usage')
  const [ping, setPing] = useState<PingResult | null>(null)
  const [pinging, setPinging] = useState(false)
  const [token, setToken] = useState('')
  const [exact, setExact] = useState<Usage['requests'] | null>(null)

  const runPing = async () => {
    setPinging(true)
    try {
      const res = await api<PingResult>('/api/admin/ping')
      setPing(res)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('Request failed'))
    } finally {
      setPinging(false)
    }
  }

  const loadExact = async () => {
    if (!token.trim()) return
    try {
      const res = await api<{ requests: Usage['requests'] }>(`/api/admin/usage?apiToken=${encodeURIComponent(token.trim())}`)
      setExact(res.requests)
      toast.success(t('Live Cloudflare analytics loaded'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('Request failed'))
    }
  }

  const req = exact ?? data?.requests
  const pct = req ? Math.min(100, req.percent ?? 0) : 0
  const warn = pct >= 80

  return (
    <Card className="animate-pop">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <span className="flex h-7 w-7 items-center justify-center rounded-2xl rounded-tl-sm bg-amber-500/15 ring-1 ring-inset ring-amber-500/25">
            <Gauge className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          </span>
          {t('Edge quota & latency')}
        </CardTitle>
        <CardDescription>
          {t('Daily request usage against the free-plan cap, plus a two-hop latency probe.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">{t('Requests today')}</span>
            <span className={warn ? 'font-semibold text-amber-600 dark:text-amber-400' : 'text-muted-foreground'} dir="ltr">
              {(req?.today ?? 0).toLocaleString('en-US')} / {(req?.cap ?? 100000).toLocaleString('en-US')}
            </span>
          </div>
          <Progress value={pct} aria-label={t('Requests today')} />
          {warn && (
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              {t('Approaching the free daily cap — subscription traffic may be throttled tomorrow.')}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground" dir="ltr">
            {t('Subscription refreshes')}: {(req?.subscriptions ?? 0).toLocaleString('en-US')} · {t('all-time')}: {(req?.subscriptionsTotal ?? 0).toLocaleString('en-US')}
          </p>
        </div>

        {data?.d1?.rows && (
          <div className="grid grid-cols-4 gap-2 text-center">
            {([
              [t('Users'), data.d1.rows.clients],
              [t('Configs'), data.d1.rows.proxies],
              [t('Nodes'), data.d1.rows.nodes],
              [t('Workers'), data.d1.rows.workers],
            ] as Array<[string, number]>).map(([label, n]) => (
              <div key={label} className="rounded-lg border bg-muted/30 p-2">
                <div className="font-display text-lg font-semibold leading-none">{n}</div>
                <div className="mt-1 text-[10px] text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[210px] flex-1 space-y-1">
            <Label htmlFor="cf-token" className="text-xs">{t('Cloudflare token (optional, exact analytics)')}</Label>
            <Input id="cf-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="cfat_… / token" autoComplete="off" />
          </div>
          <Button size="sm" variant="outline" onClick={() => void loadExact()}>
            <Activity className="h-3.5 w-3.5" /> {t('Load')}
          </Button>
          <Button size="sm" variant="outline" disabled={pinging} onClick={() => void runPing()}>
            {pinging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />} {t('Ping test')}
          </Button>
        </div>

        {req?.cloudflare != null && (
          <p className="text-[11px] text-muted-foreground" dir="ltr">
            {t('Cloudflare (exact, last 24h)')}: {req.cloudflare.toLocaleString('en-US')}
          </p>
        )}

        {ping && (
          <div className="space-y-1.5 rounded-lg border bg-muted/30 p-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">{t('Panel → Internet')}</span>
              <span className="text-muted-foreground" dir="ltr">
                {ping.colo ? `colo: ${ping.colo}` : ''} {ping.avgEgressMs != null ? `· avg ${ping.avgEgressMs}ms` : ''}
              </span>
            </div>
            {ping.results.map((r) => (
              <div key={r.label} className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">{r.label}</span>
                <span className={r.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-500'} dir="ltr">
                  {r.ok ? `${r.latencyMs}ms` : r.error || 'timeout'}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
