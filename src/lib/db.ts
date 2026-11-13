import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'
import { getCloudflareContext } from '@opennextjs/cloudflare'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * Cloudflare Workers / `next dev` with wrangler bindings → Prisma over the
 * D1 binding (`DB` in wrangler.jsonc), using the official driver adapter
 * (no query engine binary — fully workerd-compatible).
 *
 * Plain `next dev` without wrangler bindings → classic file SQLite client
 * via DATABASE_URL (see .env.example), so local development keeps working.
 */
function makeDb(): PrismaClient {
  try {
    const cf = getCloudflareContext()
    const d1 = (cf?.env as { DB?: unknown } | undefined)?.DB
    if (d1) {
      return new PrismaClient({
        adapter: new PrismaD1(d1 as Parameters<typeof PrismaD1>[0]),
      })
    }
  } catch {
    // getCloudflareContext() throws outside Workers/wrangler contexts.
  }
  return new PrismaClient({ log: ['query'] })
}

export const db = globalForPrisma.prisma ?? makeDb()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
