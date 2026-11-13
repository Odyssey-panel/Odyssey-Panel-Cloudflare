export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    // Cloudflare Workers are stateless and short-lived — no inline scheduler.
    // Opt in explicitly on long-running hosts (Docker/VPS) with
    // ODYSSEY_INLINE_JOBS=1, or rely on GET /api/cron instead.
    if (process.env.ODYSSEY_INLINE_JOBS === '1') {
      const { startJobs } = await import('@/lib/jobs')
      startJobs()
    }
  }
}
