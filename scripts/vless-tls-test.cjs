#!/usr/bin/node
/**
 * vless-tls-test.cjs — end-to-end proof for CF-hosted targets:
 *   ws connect → vless header (target host:443) → ack → TLS handshake
 *   INSIDE the tunnel (SNI = host) → HTTP GET → response.
 * Proves the PROXY_IP relay path (targets hosted on Cloudflare itself).
 *
 * Usage: node scripts/vless-tls-test.cjs <wss-url-with-secret> <uuid> [host]
 */
const WebSocket = require('ws')
const tls = require('tls')
const { Duplex } = require('stream')

const url = process.argv[2]
const uuid = process.argv[3]
const host = process.argv[4] || 'example.com'
const port = 443

if (!url || !uuid) {
  console.error('usage: node scripts/vless-tls-test.cjs <wss-url> <uuid> [host]')
  process.exit(2)
}

function uuidBytes(id) {
  const hex = id.replace(/-/g, '')
  const out = Buffer.alloc(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function vlessHeader(targetHost, targetPort) {
  const addr = Buffer.from(targetHost)
  const head = Buffer.alloc(1 + 16 + 1 + 1 + 2 + 1 + 1 + addr.length)
  let o = 0
  head[o++] = 0 // version
  uuidBytes(uuid).copy(head, o); o += 16
  head[o++] = 0 // addons len
  head[o++] = 1 // cmd tcp
  head[o++] = (targetPort >> 8) & 0xff
  head[o++] = targetPort & 0xff
  head[o++] = 2 // atype domain
  head[o++] = addr.length
  addr.copy(head, o)
  return head
}

// Duplex bridge: WS bytes → stream, stream bytes → WS. Strips the 2-byte
// vless ack before the TLS layer sees anything.
class WsBridge extends Duplex {
  constructor(ws) {
    super()
    this._t0 = Date.now()
    let gotFirst = false
    this.ws = ws
    this.stripped = 0
    ws.on('message', (d) => {
      let buf = Buffer.isBuffer(d) ? d : Buffer.from(d)
      if (this.stripped < 2) {
        const take = Math.min(2 - this.stripped, buf.length)
        buf = buf.slice(take)
        this.stripped += take
      }
      if (buf.length) {
        if (buf.length) {
      if (!gotFirst) { gotFirst = true; console.log('FIRST SERVER DATA at', Date.now() - (this._t0 || 0), 'ms') }
      if (!this.push(buf)) this.ws.pause && this.ws.pause()
    }
      }
    })
    ws.on('close', () => this.push(null))
    ws.on('error', (e) => this.destroy(e))
  }
  _read() {}
  _write(chunk, enc, cb) {
    console.log('CLIENT-BRIDGE-WRITE: ' + chunk.length + ' bytes, ws readyState=' + this.ws.readyState)
    try {
      this.ws.send(chunk, { binary: true })
      console.log('CLIENT-SENT-OK')
    } catch (e) {
      console.log('CLIENT-SEND-ERROR: ' + e.message)
    }
    cb()
  }
  destroy(err) {
    console.log('BRIDGE-DESTROY called' + (err ? ': ' + err.message : ''))
    super.destroy(err)
  }
}

const started = Date.now()
let done = false
const finish = (ok, msg) => {
  if (done) return
  done = true
  console.log(ok ? 'VLESS-TLS-OK: ' + msg : 'VLESS-TLS-FAIL: ' + msg)
  process.exit(ok ? 0 : 1)
}
const timer = setTimeout(() => finish(false, `timeout after ${Date.now() - started}ms`), 30000)

const ws = new WebSocket(url, { perMessageDeflate: false })
ws.on('error', (e) => finish(false, 'ws error: ' + e.message))
ws.on('close', (code, reason) => {
  console.log('WS-CLOSE event at', Date.now() - started, 'ms: code=' + code + ' reason=' + String(reason || ''))
})
ws.on('unexpected-response', (req, res) => {
  console.log('WS-UNEXPECTED-RESPONSE: ' + res.statusCode)
})
ws.on('open', () => {
  console.log('WS-OPEN at', Date.now() - started, 'ms')
  // The VLESS header MUST go out before any TLS bytes — real clients always
  // do this (the tunnel validates the UUID on the very first frame).
  console.log('VLESS header sent at', Date.now() - started, 'ms')
  ws.send(vlessHeader(host, port), { binary: true })
  const bridge = new WsBridge(ws)
  let sock
  try {
    sock = tls.connect({ socket: bridge, servername: host, rejectUnauthorized: true }, () => {
    const cert = sock.getPeerCertificate()
    const cn = cert && cert.subject && cert.subject.CN
    console.log(`TLS handshake ok in ${Date.now() - started}ms — cert CN: ${cn}, issuer: ${cert && cert.issuer && cert.issuer.CN}`)
    sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: odyssey-e2e\r\nConnection: close\r\n\r\n`)
  })
  sock.on('data', (d) => {
    const text = d.toString('latin1')
    if (/HTTP\/1\.[01] \d{3}/.test(text)) {
      const status = text.match(/HTTP\/1\.[01] (\d{3})/)[1]
      finish(true, `tunneled TLS HTTP ${status} for ${host} in ${Date.now() - started}ms`)
    }
  })
    sock.on('error', (e) => finish(false, 'tls error: ' + e.message))
  } catch (e) {
    console.log('TLS-CONNECT-THREW: ' + e.message)
    finish(false, 'tls connect threw: ' + e.message)
  }
})
