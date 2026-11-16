import { db } from '@/lib/db'
import { getCloudflareContext } from '@opennextjs/cloudflare'

export const runtime = 'nodejs'

/**
 * Temporary diagnostics for the subscription cache pipeline (no secrets):
 * which store the runtime actually sees, whether the KV row exists, and
 * what the DB really holds for a subscription token.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') || ''
  if (!/^[a-f0-9]{16,64}$/i.test(token)) {
    return new Response('bad token', { status: 400 })
  }

  let storeType = 'none'
  let kvRawPresent: boolean | null = null
  let kvErr = ''
  try {
    const cf = getCloudflareContext()
    const env = cf?.env as
      | { KV?: { get(k: string, t?: string): Promise<string | null> } }
      | undefined
    storeType = env?.KV ? 'kv' : 'none'
    if (env?.KV) {
      try {
        kvRawPresent = (await env.KV.get(`sub:${token}`, 'text')) != null
      } catch (e) {
        kvErr = e instanceof Error ? e.message : String(e)
      }
    }
  } catch (e) {
    storeType = 'ctx-error: ' + (e instanceof Error ? e.message : String(e))
  }

  let proxies: Array<{ addr: string; proto: string }> | null = null
  let dbErr = ''
  try {
    const client = await db.client.findUnique({
      where: { subToken: token },
      include: { proxies: { select: { address: true, protocol: true } } },
    })
    proxies = client?.proxies.map((p) => ({ addr: p.address, proto: p.protocol })) ?? null
  } catch (e) {
    dbErr = e instanceof Error ? e.message : String(e)
  }

  return Response.json({ storeType, kvRawPresent, kvErr, proxies, dbErr })
}
