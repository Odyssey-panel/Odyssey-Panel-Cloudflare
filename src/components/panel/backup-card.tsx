'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { useLang } from '@/lib/i18n'
import { api } from './api'
import { DatabaseBackup, Download, Loader2, Upload } from 'lucide-react'

/**
 * Full panel backup & restore — one JSON download keeps every user, config,
 * worker and setting; a paste-in restore brings them onto any deployment.
 */
export function BackupCard() {
  const { t } = useLang()
  const [busy, setBusy] = useState(false)
  const [json, setJson] = useState('')

  const download = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/backup')
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `odyssey-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(t('Backup downloaded'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('Request failed'))
    } finally {
      setBusy(false)
    }
  }

  const restore = async () => {
    if (!json.trim()) return
    if (!confirm(t('Restore users from this backup? Existing users with the same name are skipped.'))) return
    setBusy(true)
    try {
      const res = await api<{ restored: number; skipped: number }>('/api/admin/backup', {
        method: 'POST',
        body: JSON.stringify({ backup: json }),
      })
      toast.success(t('{restored} users restored, {skipped} skipped', { restored: res.restored, skipped: res.skipped }))
      setJson('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('Restore failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="animate-pop">
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <span className="flex h-7 w-7 items-center justify-center rounded-2xl rounded-tl-sm bg-sky-500/15 ring-1 ring-inset ring-sky-500/25">
            <DatabaseBackup className="h-3.5 w-3.5 text-sky-500" />
          </span>
          {t('Backup & restore')}
        </CardTitle>
        <CardDescription>
          {t('Export every user, config and setting as JSON — restore on any deployment.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void download()}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} {t('Download backup')}
        </Button>
        <div className="space-y-1.5">
          <Label htmlFor="restore-json" className="text-xs">{t('Paste a backup JSON to restore')}</Label>
          <textarea
            id="restore-json"
            dir="ltr"
            className="max-h-40 min-h-[72px] w-full rounded-lg border bg-muted/30 p-2.5 font-mono text-[11px]"
            placeholder='{ "format": "odyssey-backup", … }'
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <Button size="sm" variant="outline" disabled={busy || !json.trim()} onClick={() => void restore()}>
            <Upload className="h-3.5 w-3.5" /> {t('Restore')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
