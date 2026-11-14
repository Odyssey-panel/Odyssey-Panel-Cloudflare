/**
 * Odyssey Edge Tunnel v2 — the ready-to-deploy Cloudflare Worker that turns
 * any *.workers.dev subdomain into a native VLESS-over-WebSocket endpoint.
 *
 * Architecture (completely different from the Railway era):
 *   client app ──WSS──▶ Cloudflare edge (this worker) ──connect()──▶ target
 * No VPS, no container, no panel involvement in the data path. The panel
 * only GENERATES configs pointing at this worker; the traffic itself rides
 * Cloudflare's edge network.
 *
 * Features:
 *  - UUID allowlist (env.UUIDS, comma separated) — when empty, the secret
 *    path alone gates access.
 *  - Secret path (env.PATH_SECRET) — WebSocket upgrades outside
 *    /<PATH_SECRET> get a 404, so scanners find nothing.
 *  - Early data (ed=2560 / sec-websocket-early-data header) — 0-RTT.
 *  - PROXY_IP fallback (env.PROXY_IP, comma separated) — targets hosted on
 *    Cloudflare itself cannot be reached by worker egress; the tunnel
 *    retries through the configured proxy relay instead.
 *  - DNS over DoH for VLESS UDP port 53 (cmd 2) so clients can resolve.
 *
 * The panel's one-click deploy embeds UUIDS/PATH_SECRET/PROXY_IP as
 * plain-text bindings, so every user account works with zero manual edits.
 */
export const WORKER_CODE = `// Odyssey Edge Tunnel v2 — VLESS over WebSocket on Cloudflare Workers
import { connect } from 'cloudflare:sockets';

const EARLY_DATA_HEADER = 'sec-websocket-early-data';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase();
    if (upgrade !== 'websocket') {
      return new Response('Odyssey Edge Tunnel v2 — ready', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const secret = String(env.PATH_SECRET || '').trim().replace(/^\\/+|\\/+$/g, '');
    if (secret) {
      const got = url.pathname.replace(/^\\/+|\\/+$/g, '');
      if (got !== secret) return new Response('Not Found', { status: 404 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    handleTunnel(server, env, request, ctx).catch(() => safeClose(server));
    return new Response(null, { status: 101, webSocket: pair[0] });
  },
};

function safeClose(ws) {
  try { ws.close(); } catch (_) {}
}

function base64UrlDecode(s) {
  try {
    let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) {
    return new Uint8Array(0);
  }
}

function formatUuid(b) {
  let h = '';
  for (let i = 0; i < 16; i++) h += (b[i] >> 4).toString(16) + (b[i] & 15).toString(16);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

// Returns null when more bytes are needed, or the parsed header + offset.
function parseVlessHeader(b) {
  if (b.length < 24) return null;
  const version = b[0];
  const uuid = formatUuid(b.slice(1, 17));
  const addonsLen = b[17];
  const opt = 18 + addonsLen;
  if (b.length < opt + 4) return null;
  const cmd = b[opt];
  const port = (b[opt + 1] << 8) | b[opt + 2];
  const atype = b[opt + 3];
  let offset = opt + 4;
  let address = '';
  if (atype === 1) {
    if (b.length < offset + 4) return null;
    address = Array.from(b.slice(offset, offset + 4)).join('.');
    offset += 4;
  } else if (atype === 2) {
    if (b.length < offset + 1) return null;
    const len = b[offset];
    if (b.length < offset + 1 + len) return null;
    address = new TextDecoder().decode(b.slice(offset + 1, offset + 1 + len));
    offset += 1 + len;
  } else if (atype === 3) {
    if (b.length < offset + 16) return null;
    const parts = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(((b[offset + i] << 8) | b[offset + i + 1]).toString(16));
    }
    address = parts.join(':');
    offset += 16;
  } else {
    return 'bad';
  }
  return { version, uuid, cmd, port, address, offset };
}

async function handleTunnel(ws, env, request, invCtx) {
  const ctx = {
    sock: null,
    writer: null,
    closed: false,
    headerParsed: false,
    buf: new Uint8Array(0),
    dnsMode: false,
    /** client bytes sent before any server byte arrived — replayed to each
     * new connect attempt (e.g. the TLS ClientHello) */
    early: [],
    confirmed: false,
  };

  const closeAll = () => {
    if (ctx.closed) return;
    ctx.closed = true;
    safeClose(ws);
    try { ctx.sock && ctx.sock.close(); } catch (_) {}
    try { ctx.writer && ctx.writer.releaseLock(); } catch (_) {}
    // release the invocation lifetime root
    if (ctx.resolveDone) { try { ctx.resolveDone(); } catch (_) {} }
  };
  ws.addEventListener('close', closeAll);
  ws.addEventListener('error', closeAll);

  // Keep the worker invocation alive for as long as this WebSocket session
  // runs. Rooting an instantly-resolving promise here (e.g. the setup call)
  // would end the invocation in milliseconds and kill the session.
  const sessionDone = new Promise((resolve) => { ctx.resolveDone = resolve; });
  if (invCtx && typeof invCtx.waitUntil === 'function') invCtx.waitUntil(sessionDone);

  const early = request.headers.get(EARLY_DATA_HEADER) || '';
  if (early) ctx.buf = base64UrlDecode(early);

  // Header phase: serialize (a vless header may span several frames).
  // Data phase: NO chain — client bytes must reach the current socket
  // immediately, even while a connect attempt's watchdog is still running.
  let chain = Promise.resolve();
  ws.addEventListener('message', (ev) => {
    if (ctx.headerParsed && ctx.buf === null) {
      dataChunk(ev, ws, ctx).catch(() => closeAll());
      return;
    }
    chain = chain.then(() => runMessage(ev, ws, env, ctx)).catch(() => closeAll());
  });

  async function dataChunk(ev, ws, ctx) {
    const chunk = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data)
      : ev.data instanceof Uint8Array ? ev.data
      : new Uint8Array(await new Response(ev.data).arrayBuffer());
    if (ctx.dnsMode) {
      await dnsStep(chunk, ws);
      return;
    }
    if (ctx.writer && chunk.byteLength) {
      // write through to the CURRENT attempt's socket immediately
      try {
        await ctx.writer.write(chunk);
        console.log('[tunnel] client-data=' + chunk.byteLength);
      } catch (e) {
        console.log('[tunnel] client-data FAILED: ' + String(e && e.message || e).slice(0, 80));
      }
    }
    if (chunk.byteLength && !ctx.confirmed) {
      // keep for replay when the next attempt takes over
      ctx.early.push(chunk);
    }
  }

  async function runMessage(ev, ws, env, ctx) {
    const chunk = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data)
      : ev.data instanceof Uint8Array ? ev.data
      : new Uint8Array(await new Response(ev.data).arrayBuffer());

    if (ctx.dnsMode) {
      await dnsStep(chunk, ws);
      return;
    }

    if (!ctx.headerParsed) {
      ctx.buf = ctx.buf.length ? concat(ctx.buf, chunk) : chunk;
      if (ctx.buf.length > 8192) return closeAll();
      const parsed = parseVlessHeader(ctx.buf);
      if (parsed === null) return; // need more bytes
      ctx.headerParsed = true;
      if (parsed === 'bad') return closeAll();

      const allow = String(env.UUIDS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (allow.length && !allow.includes(parsed.uuid)) return closeAll();

      const rest = ctx.buf.slice(parsed.offset);
      ctx.buf = null;
      ws.send(new Uint8Array([parsed.version, 0])); // vless ack

      if (parsed.cmd === 2 && parsed.port === 53) {
        ctx.dnsMode = true;
        await dnsStep(rest, ws);
        return;
      }
      if (parsed.cmd !== 1) return closeAll(); // TCP only beyond DNS

      await openPipe(ws, parsed, rest, env, ctx, invCtx);
      return;
    }

    // Data-phase message that was chained behind the header (same event-loop
    // turn, e.g. the TLS ClientHello right after the vless header).
    if (ctx.dnsMode) {
      await dnsStep(chunk, ws);
      return;
    }
    if (ctx.writer && chunk.byteLength) {
      try {
        await ctx.writer.write(chunk);
        console.log('[tunnel] client-data=' + chunk.byteLength);
      } catch (e) {
        console.log('[tunnel] client-data FAILED: ' + String(e && e.message || e).slice(0, 80));
      }
    }
    if (chunk.byteLength && !ctx.confirmed) {
      ctx.early.push(chunk);
    }
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ── Cloudflare-hosted target detection ───────────────────────────────
// Workers cannot reach Cloudflare's own IPs from connect() — those targets
// must go through the PROXY_IP relays. Resolve via DoH (allowed) and test
// the addresses against Cloudflare's published IPv4 ranges.
const CF_V4_RANGES = [
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22],
  ['141.101.64.0', 18], ['108.162.192.0', 18], ['190.93.240.0', 20], ['188.114.96.0', 20],
  ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
].map(function (p) { return [ip4ToInt(p[0]), p[1]]; });

function ip4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return 0;
  return (((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0);
}

function isCfIpv4(ip) {
  const n = ip4ToInt(ip);
  if (!n) return false;
  for (const pair of CF_V4_RANGES) {
    const bits = pair[1];
    const mask = (bits === 0 ? 0 : ((-1 << (32 - bits)) >>> 0));
    if ((n & mask) === (pair[0] & mask)) return true;
  }
  return false;
}

const cfHostCache = new Map();

async function isCloudflareHost(host) {
  if (/(\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').length === 4) return isCfIpv4(host);
  if (cfHostCache.has(host)) return cfHostCache.get(host);
  let result = false;
  try {
    const res = await Promise.race([
      fetch('https://1.1.1.1/dns-query?name=' + encodeURIComponent(host) + '&type=A', {
        headers: { accept: 'application/dns-json' },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('doh-timeout')), 3000)),
    ]);
    const json = await res.json();
    const answers = (json.Answer || []).filter((a) => a.type === 1);
    for (const a of answers) {
      if (isCfIpv4(a.data)) { result = true; break; }
    }
  } catch (_) { /* DNS failure → assume direct-first */ }
  cfHostCache.set(host, result);
  return result;
}
// Connect order: for Cloudflare-hosted targets the relays come FIRST (direct
// egress to CF IPs is refused — it would just hang); everything else tries
// direct first. Every attempt keeps a first-byte watchdog as a safety net.
async function openPipe(ws, parsed, firstPayload, env, ctx, invCtx) {
  const cfHosted = await isCloudflareHost(parsed.address);
  console.log('[tunnel] target=' + parsed.address + ':' + parsed.port + ' cfHosted=' + cfHosted);
  const direct = parsed.address + ':' + parsed.port;
  // PROXY_IP relays always listen on 443 (TLS-SNI forwarding) — never use the
  // target's port for them.
  const relays = String(env.PROXY_IP || '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((r) => (r.includes(':') ? r : r + ':443'));
  const targets = cfHosted && relays.length ? relays.concat([direct]) : [direct].concat(relays);

  ctx.early = firstPayload && firstPayload.byteLength ? [firstPayload] : [];
  ctx.confirmed = false;
  for (let i = 0; i < targets.length; i++) {
    const ok = await attemptTarget(ws, targets[i], ctx, invCtx, i < targets.length - 1);
    if (ok) return;
  }
  try { ws.close(); } catch (_) {}
}

async function attemptTarget(ws, target, ctx, invCtx, hasMore) {
  let s = null;
  let w = null;
  try {
    s = connect(target, { allowUntrusted: false });
    w = s.writable.getWriter();
    // send every byte the client produced so far (header payload + any
    // early data such as the TLS ClientHello)
    console.log('[tunnel] attempt=' + target + ' early=' + ctx.early.length);
    for (const c of ctx.early) {
      await w.write(c);
    }
  } catch (_) {
    try { w && w.releaseLock(); } catch (_) {}
    try { s && s.close(); } catch (_) {}
    return false;
  }
  ctx.sock = s;
  ctx.writer = w;
  let gotData = false;
  const pump = (async () => {
    const reader = s.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        if (!gotData) console.log('[tunnel] first-data from=' + target);
        gotData = true;
        ws.send(value);
      }
    }
    // Only end the session once THIS socket actually carried data. A silent
    // failed attempt (relay down, CF-target refusing egress) must leave the
    // WebSocket open so the watchdog can hand over to the next candidate.
    if (gotData) { try { ws.close(); } catch (_) {} }
  })().catch(() => {});
  // Root the pump: without this, production suspends the invocation
  // right after the message handler resolves and the socket idles.
  if (invCtx && typeof invCtx.waitUntil === 'function') invCtx.waitUntil(pump);
  // First-byte watchdog: silently-hanging sockets (CF-hosted targets)
  // must give way to the next relay candidate.
  const deadline = hasMore ? 6000 : 30000;
  const ok = await new Promise((resolve) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (gotData) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() - t0 > deadline) {
        clearInterval(poll);
        resolve(false);
      }
    }, 50);
  });
  console.log('[tunnel] attempt-result=' + target + ' ok=' + ok);
  if (ok) {
    ctx.confirmed = true;
    return true;
  }
  try { s.close(); } catch (_) {}
  return false;
}

// VLESS UDP for port 53 → resolve via DoH, answer with length-prefixed frames.
async function dnsStep(chunk, ws) {
  const body = chunk.length > 2 ? chunk.slice(2) : chunk; // strip 2-byte length prefix
  if (!body.byteLength) return;
  const res = await fetch('https://1.1.1.1/dns-query', {
    method: 'POST',
    headers: { 'content-type': 'application/dns-message' },
    body: body,
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!buf.byteLength) return;
  const frame = new Uint8Array(buf.byteLength + 2);
  frame[0] = (buf.byteLength >> 8) & 255;
  frame[1] = buf.byteLength & 255;
  frame.set(buf, 2);
  ws.send(frame);
}
`

export const WORKER_STEPS_FA = [
  'در داشبورد Cloudflare وارد بخش «Workers & Pages» شوید — یا ساده‌تر: در پنل اودیسه، صفحهٔ «ورکرها» را باز کنید و دکمهٔ «دیپلوی یک‌کلیکی تونل» را بزنید.',
  'دیپلوی خودکار: پنل ورکر odyssey-tunnel را با لیست UUID همهٔ کاربران، مسیر مخفی و ProxyIP روی حساب Cloudflare شما نصب می‌کند.',
  'بعد از دیپلوی، همهٔ کانفیگ‌های جدید به‌صورت خودکار از تونل edge استفاده می‌کنند (بدون نیاز به VPS یا Railway).',
  'برای سایت‌هایی که خودشان پشت Cloudflare هستند، مقدار ProxyIP را در تنظیمات بگذارید (IP یا دامنهٔ یک رله).',
]
