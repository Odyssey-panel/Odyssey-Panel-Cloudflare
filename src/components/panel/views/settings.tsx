'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { CopyField } from '../copy'
import { api, useApi } from '../api'
import { BackupCard } from '../backup-card'
import { toast } from 'sonner'
import { useTheme } from 'next-themes'
import { useLang, type Lang } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Loader2, Save, Globe2, Languages, Palette, MonitorSmartphone, Sun, Moon, Network, Shield, Radar } from 'lucide-react'

type Settings = {
  publicUrl: string
  lastOrigin: string
  tunnelProxyIp: string
  tunnelBlockAds: string
  tunnelBlockPorn: string
  tunnelBlockExtra: string
}

type ProxyIpResult = {
  target: string
  directMs: number | null
  directOk: boolean
  relayMs: number | null
  relayOk: boolean
  error: string | null
}

export function SettingsView() {
  const { data, loading, reload } = useApi<{ settings: Settings }>('/api/admin/settings')
  const [form, setForm] = useState<Settings | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeResults, setProbeResults] = useState<ProxyIpResult[] | null>(null)
  const { lang, setLang, t } = useLang()
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    if (data?.settings && !form) setForm({ ...data.settings })
  }, [data, form])

  const runProbe = async () => {
    setProbing(true)
    setProbeResults(null)
    try {
      const r = await api<{ results: ProxyIpResult[] }>('/api/admin/proxyip', {
        method: 'POST',
        body: JSON.stringify({ targets: (form?.tunnelProxyIp || '').split(',').map((s) => s.trim()).filter(Boolean) }),
      })
      setProbeResults(r.results || [])
      toast.success(t('Relay test finished'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('Request failed'))
    } finally {
      setProbing(false)
    }
  }

  const save = async () => {
    if (!form) return
    setSaving(true)
    try {
      const body: Record<string, string> = { ...form }
      if (newPassword) body.newPassword = newPassword
      const res = await api<{ settings: Settings }>('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) })
      setForm({ ...res.settings })
      setNewPassword('')
      toast.success(t('Settings saved'))
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('Save failed'))
    } finally {
      setSaving(false)
    }
  }

  if (loading && !form) {
    return <div className="space-y-4">{[0, 1].map((i) => <Skeleton key={i} className="h-64" />)}</div>
  }
  if (!form) return null

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const effectiveUrl = form.publicUrl || form.lastOrigin || origin

  const langOptions: { value: Lang; native: string; sub: string }[] = [
    { value: 'fa', native: 'فارسی', sub: t('Persian (RTL)') },
    { value: 'en', native: 'English', sub: t('English (LTR)') },
  ]

  return (
    <div className="animate-rise space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-odyssey-navy to-odyssey-cyan shadow-[0_0_8px_oklch(0.72_0.1_214/0.9)]" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-800 dark:text-odyssey-cyan/90">
              {t('Configuration')}
            </span>
          </div>
          <h1 className="font-display text-[26px] font-semibold leading-tight tracking-tight md:text-3xl">{t('Settings')}</h1>
          <p className="text-sm text-muted-foreground">{t('Panel URL, admin password and appearance')}</p>
        </div>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {t('Save changes')}
        </Button>
      </div>

      {/* Panel */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe2 className="h-4 w-4 text-primary" /> {t('Panel')}
          </CardTitle>
          <CardDescription>{t('Public URL and admin credentials')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CopyField label={t('Effective panel URL (auto-detected or pinned)')} value={effectiveUrl || t('not detected yet')} mono={false} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="st-publicurl">{t('Public URL override')}</Label>
              <Input
                id="st-publicurl"
                placeholder={t('https://panel.example.com (leave empty to auto-detect)')}
                value={form.publicUrl}
                onChange={(e) => setForm((f) => (f ? { ...f, publicUrl: e.target.value } : f))}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('Used in subscription links and QR codes. Empty = auto-detected from the browser you manage the panel with, so it adapts to whatever domain you deploy on.')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-password">{t('Change admin password')}</Label>
              <Input
                id="st-password"
                type="password"
                placeholder={t('new password (min 6 chars)')}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Edge tunnel: relays + content policy ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4 text-primary" /> {t('Edge tunnel')}
          </CardTitle>
          <CardDescription>{t('Proxy-IP relays, content policy and reachability tests — applied to the tunnel on the next one-click redeploy.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="st-proxyip">{t('Proxy-IP relay pool (comma-separated IP:port)')}</Label>
            <Input
              id="st-proxyip"
              value={form.tunnelProxyIp || ''}
              onChange={(e) => setForm((f) => (f ? { ...f, tunnelProxyIp: e.target.value } : f))}
              placeholder="219.76.13.169:443, 34.96.247.17:443"
              dir="ltr"
              className="font-mono text-xs"
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('Used only as a fallback when a target site is itself behind Cloudflare and the edge cannot reach it directly.')}
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div
              className={`flex items-center justify-between gap-3 rounded-xl border p-3 transition-colors ${
                form.tunnelBlockAds === '1' ? 'border-odyssey-cyan/40 bg-odyssey-cyan/[0.07]' : 'border-border/60'
              }`}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-odyssey-cyan/15 ring-1 ring-inset ring-odyssey-cyan/30">
                  <Shield className="h-4 w-4 text-odyssey-deep dark:text-odyssey-bright" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold leading-tight">{t('Block ads & trackers')}</div>
                  <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{t('Drops connections to known ad/tracker domains at the tunnel.')}</div>
                </div>
              </div>
              <Switch
                checked={form.tunnelBlockAds === '1'}
                onCheckedChange={(v) => setForm((f) => (f ? { ...f, tunnelBlockAds: v ? '1' : '0' } : f))}
                aria-label={t('Block ads & trackers')}
              />
            </div>
            <div
              className={`flex items-center justify-between gap-3 rounded-xl border p-3 transition-colors ${
                form.tunnelBlockPorn === '1' ? 'border-odyssey-cyan/40 bg-odyssey-cyan/[0.07]' : 'border-border/60'
              }`}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-odyssey-cyan/15 ring-1 ring-inset ring-odyssey-cyan/30">
                  <Shield className="h-4 w-4 text-odyssey-deep dark:text-odyssey-bright" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-semibold leading-tight">{t('Block adult content')}</div>
                  <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{t('Drops connections to known adult domains at the tunnel.')}</div>
                </div>
              </div>
              <Switch
                checked={form.tunnelBlockPorn === '1'}
                onCheckedChange={(v) => setForm((f) => (f ? { ...f, tunnelBlockPorn: v ? '1' : '0' } : f))}
                aria-label={t('Block adult content')}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="st-blockextra">{t('Always-block domains (comma-separated)')}</Label>
            <Input
              id="st-blockextra"
              value={form.tunnelBlockExtra || ''}
              onChange={(e) => setForm((f) => (f ? { ...f, tunnelBlockExtra: e.target.value } : f))}
              placeholder="example.com, tracker.io"
              dir="ltr"
              className="font-mono text-xs"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void runProbe()} disabled={probing}>
              {probing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />} {t('Test relays from the edge')}
            </Button>
            <span className="text-[11px] text-muted-foreground">{t('Probes every relay directly and through the tunnel, like a real user connection.')}</span>
          </div>
          {probeResults && (
            <div className="space-y-1.5">
              {probeResults.map((r) => (
                <div key={r.target} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-white/[0.03] px-3 py-2 font-mono text-xs">
                  <span dir="ltr">{r.target}</span>
                  <span className="flex items-center gap-3 text-muted-foreground" dir="ltr">
                    <span className={r.directOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}>direct {r.directMs != null ? `${r.directMs}ms` : '—'}</span>
                    <span className={r.relayOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}>relay {r.relayMs != null ? `${r.relayMs}ms` : '—'}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Language & appearance */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Languages className="h-4 w-4 text-primary" /> {t('Language & appearance')}
          </CardTitle>
          <CardDescription>{t('Switch anytime — the whole panel translates and mirrors instantly.')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Language */}
          <div className="grid gap-2 sm:grid-cols-2">
            {langOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setLang(o.value)}
                className={cn(
                  'flex items-center justify-between rounded-xl border p-4 text-start transition-all duration-200 hover:bg-white/[0.05]',
                  lang === o.value && 'border-primary/50 bg-primary/5 ring-1 ring-inset ring-primary/30'
                )}
              >
                <span>
                  <span className="block text-sm font-semibold">{o.native}</span>
                  <span className="block text-xs text-muted-foreground">{o.sub}</span>
                </span>
                <span
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full border',
                    lang === o.value ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/30'
                  )}
                >
                  {lang === o.value && <span className="h-2 w-2 rounded-full bg-current" />}
                </span>
              </button>
            ))}
          </div>

          {/* Theme */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <Palette className="h-3.5 w-3.5" /> {t('Theme')}
            </Label>
            <div className="inline-flex rounded-lg border p-1">
              {[
                { value: 'dark', label: t('Dark'), icon: Moon },
                { value: 'light', label: t('Light'), icon: Sun },
              ].map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setTheme(o.value)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
                    theme === o.value ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <o.icon className="h-3.5 w-3.5" /> {o.label}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Layouts info */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MonitorSmartphone className="h-4 w-4 text-primary" /> {t('Layout')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            {t('This panel ships with two layouts — desktop with a sidebar, and mobile with bottom navigation. It picks the right one automatically based on your screen.')}
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <div className="rounded-xl border p-4">
              <div className="text-sm font-semibold">{t('Desktop layout')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('sidebar + full tables')}</div>
            </div>
            <div className="rounded-xl border p-4">
              <div className="text-sm font-semibold">{t('Mobile layout')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('bottom navigation + compact cards')}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Backup & restore ── */}
      <BackupCard />
    </div>
  )
}
