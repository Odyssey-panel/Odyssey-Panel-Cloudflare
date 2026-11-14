/**
 * The panel's own edge tunnel.
 *
 * The full worker source lives in ./tunnel-worker.ts (single secret path,
 * three protocols dispatched beneath it: VLESS / Trojan / Shadowsocks).
 * It is deployed automatically through the "Nodes & workers" page with the
 * admin's Cloudflare token, or can be pasted by hand into the dashboard.
 *
 * One deployment serves every user of the panel: each account carries its
 * own UUID (vless) or password (trojan / shadowsocks) inside the protocol
 * header, so the tunnel needs no per-user state. Shadowsocks additionally
 * enforces its own password through AEAD decryption — a wrong password just
 * fails to decrypt.
 */
import { tunnelWorkerSource } from './tunnel-worker'

/** Ready-to-paste tunnel worker source (no proxy fallback configured). */
export const WORKER_CODE = tunnelWorkerSource()

/** Source used by the one-click deploy route (can embed a fallback proxy IP). */
export function workerCodeFor(proxyIp = '', blockFlags = ''): string {
  return tunnelWorkerSource(proxyIp, blockFlags)
}

/** TUNNEL_BLOCK value for the deployed tunnel from panel settings. */
export function blockFlagsFor(ads: boolean, porn: boolean): string {
  const parts: string[] = []
  if (ads) parts.push('ads')
  if (porn) parts.push('porn')
  return parts.join(',')
}

/** Sub-paths beneath the secret path that the tunnel serves. */
export const TUNNEL_PROTOCOL_PATHS = {
  vless: 'vless',
  trojan: 'trojan',
  shadowsocks: 'ss',
} as const

/** TLS-enabled ports Cloudflare fronts for workers.dev / proxied zones. */
export const CF_TLS_PORTS = [443, 2053, 2083, 2087, 2096, 8443]

export const WORKER_STEPS_FA = [
  'در داشبورد Cloudflare وارد بخش «Workers & Pages» شوید — یا ساده‌تر: در پنل اودیسه، صفحهٔ «ورکرها» را باز کنید و دکمهٔ «دیپلوی یک‌کلیکی تونل» را بزنید.',
  'دیپلوی خودکار: پنل ورکر odyssey-tunnel را با مسیر مخفی و ProxyIP روی حساب Cloudflare شما نصب می‌کند — حالا هر سه پروتکل VLESS، Trojan و Shadowsocks را سرو می‌کند.',
  'بعد از دیپلوی، همهٔ کانفیگ‌های جدید به‌صورت خودکار از تونل edge استفاده می‌کنند (بدون نیاز به VPS یا Railway).',
  'برای سایت‌هایی که خودشان پشت Cloudflare هستند، مقدار ProxyIP را در تنظیمات بگذارید (IP یا دامنهٔ یک رله).',
]
