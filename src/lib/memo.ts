/**
 * In-isolate memo cache — SPEED, round 2.
 *
 * Short-TTL memory hits for the panel's heaviest admin GETs (clients list,
 * dashboard stats). A dashboard view-switch used to re-pay 5 sequential D1
 * queries; now it re-pays nothing within the TTL window. Mutations call
 * memoDrop() so the same isolate stays coherent; the worst case across
 * isolates is the TTL window itself (1-5s) on a single-admin panel.
 */

type Entry = { at: number; value: unknown }
const store = new Map<string, Entry>()

export async function memoCached<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  const hit = store.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T
  const value = await producer()
  store.set(key, { at: Date.now(), value })
  return value
}

/** Drop one cached key, or everything when no key is given (after mutations). */
export function memoDrop(key?: string) {
  try {
    if (key) store.delete(key)
    else store.clear()
  } catch {
    // memo must never break a request
  }
}
