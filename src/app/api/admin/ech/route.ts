import { requireAuth, jsonSafe } from '@/lib/auth'

export const runtime = 'nodejs'

/**
 * ECH (Encrypted ClientHello) helper — Zeus-style.
 *
 * GET /api/admin/ech?host=example.com
 *   → queries Cloudflare DoH for the HTTPS record (RFC 9460) of the host
 *     and extracts the `ech` SvcParam (base64 ECHConfigList) when published.
 *
 * GET /api/admin/ech?suggest=1
 *   → a few domains commonly known to publish ECH configs, to try quickly.
 */
export async function GET(req: Request) {
  const unauthorized = await requireAuth()
  if (unauthorized) return unauthorized

  const url = new URL(req.url)
  if (url.searchParams.has('suggest')) {
    return jsonSafe({
      suggestions: ['crypto.cloudflare.com', 'speed.cloudflare.com', 'cloudflare.com'],
    })
  }

  const host = (url.searchParams.get('host') || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
    return Response.json({ ok: false, error: 'valid domain required' }, { status: 400 })
  }

  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=HTTPS`,
      { headers: { accept: 'application/dns-json' } },
    )
    if (!res.ok) return Response.json({ ok: false, error: `DoH HTTP ${res.status}` }, { status: 200 })
    const data = (await res.json()) as {
      Status?: number
      Answer?: Array<{ name: string; type: number; data: string }>
    }
    const answers = (data.Answer || []).filter((a) => a.type === 65)
    for (const a of answers) {
      const ech = extractEch(a.data)
      if (ech) return jsonSafe({ ok: true, host, ech })
    }
    return jsonSafe({ ok: false, host, error: 'no ECH config published for this domain' })
  } catch (e) {
    return jsonSafe({ ok: false, error: e instanceof Error ? e.message : 'DoH lookup failed' })
  }
}

/**
 * Cloudflare's DoH JSON API returns HTTPS-record RDATA base64-encoded.
 * Wire format: svcPriority(2) targetName(len-prefixed) then SvcParams:
 * each param = key(2BE) len(2BE) value. ECH param key = 5, value = the
 * base64 ECHConfigList (ASCII).
 */
function extractEch(data: string): string | null {
  // Cloudflare's DoH JSON API returns HTTPS records in presentation format:
  // "1 . alpn=h2 ech=<base64 ECHConfigList> ipv4hint=..." — some resolvers
  // return base64 RDATA instead, so try both.
  const m = /(?:^|\s)ech=([A-Za-z0-9+/=._-]+)/.exec(data || '')
  if (m) return m[1]
  try {
    const raw = Buffer.from((data || '').replace(/\s+/g, ''), 'base64')
    if (raw.length < 3 || !/^[-A-Za-z0-9+/=\s]+$/.test(data || '')) return null
    let off = 2 // svcPriority
    const nameLen = raw[off]
    off += 1 + nameLen
    while (off + 4 <= raw.length) {
      const key = (raw[off] << 8) | raw[off + 1]
      const len = (raw[off + 2] << 8) | raw[off + 3]
      const val = raw.slice(off + 4, off + 4 + len)
      if (key === 5 && len > 0) {
        const ech = Buffer.from(val).toString('utf8').trim()
        if (ech) return ech
      }
      off += 4 + len
    }
    return null
  } catch {
    return null
  }
}
