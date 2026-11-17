/**
 * VLESS-Reality key management for the VPS backend.
 *
 * Reality removes the need for a domain + certificate entirely: the server
 * borrows the TLS handshake of a real site (dest/SNI) and only clients that
 * present the matching Reality auth (pbk/sid) get proxied — everyone else is
 * forwarded to the real site. Perfect for Iranian ISPs that block workers.dev
 * and SNI-sniff generic domains: the config dials the VPS IP directly.
 *
 * Keys are X25519 (xray-core compatible, base64url of the raw 32 bytes —
 * exactly what `xray x25519` prints). One keypair per deployment, stored in
 * the Setting table under "realityKeys". Generated lazily on first use, on
 * Node (VPS / Docker / dev) via node:crypto and on Workers via WebCrypto.
 */
import { db } from '@/lib/db'

export type RealityKeys = { priv: string; pub: string }
export type RealityParams = { pbk: string; sid: string; spx: string }

export const REALITY_SETTING_KEY = 'realityKeys'

/** Fallback dest/SNI when the admin leaves it empty (fast, TLS1.3+, widely reachable). */
export const REALITY_DEFAULT_SNI = 'www.samsung.com'

/** Flow injected on every Reality config (xtls-rprx-vision = best throughput). */
export const REALITY_FLOW = 'xtls-rprx-vision'

const b64url = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function nodeKeyPair(): RealityKeys {
  // Lazy require so bundling on Workers never hard-depends on node:crypto.
  const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto')
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Uint8Array
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Uint8Array
  // DER envelopes end with the raw 32-byte key
  return {
    priv: b64url(privDer.subarray(privDer.length - 32)),
    pub: b64url(pubDer.subarray(pubDer.length - 32)),
  }
}

async function webCryptoKeyPair(): Promise<RealityKeys> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('no WebCrypto')
  const kp = (await subtle.generateKey(
    { name: 'X25519' } as AlgorithmIdentifier,
    true,
    ['deriveKey', 'deriveBits'] as unknown as KeyUsage[],
  )) as { privateKey: CryptoKey; publicKey: CryptoKey }
  const priv = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey))
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey))
  return { priv: b64url(priv.subarray(priv.length - 32)), pub: b64url(pub.subarray(pub.length - 32)) }
}

function randomShortId(): string {
  const bytes = new Uint8Array(8)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    const { randomBytes } = require('node:crypto') as typeof import('node:crypto')
    bytes.set(randomBytes(8))
  }
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function isValidShortId(v: string): boolean {
  return /^[0-9a-fA-F]{0,16}$/.test(v)
}

/**
 * Get (or lazily create) the deployment Reality keypair. Never throws when
 * generation is impossible — returns null and callers degrade gracefully.
 */
export async function getRealityKeys(): Promise<RealityKeys | null> {
  try {
    const row = await db.setting.findUnique({ where: { key: REALITY_SETTING_KEY } })
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Partial<RealityKeys>
      if (parsed?.priv && parsed?.pub) return { priv: parsed.priv, pub: parsed.pub }
    }
  } catch {
    /* fall through to generation */
  }
  let keys: RealityKeys | null = null
  try {
    keys = nodeKeyPair()
  } catch {
    try {
      keys = await webCryptoKeyPair()
    } catch {
      keys = null
    }
  }
  if (!keys) return null
  try {
    await db.setting.upsert({
      where: { key: REALITY_SETTING_KEY },
      update: { value: JSON.stringify(keys) },
      create: { key: REALITY_SETTING_KEY, value: JSON.stringify(keys) },
    })
  } catch {
    /* a keypair that isn't persisted still works for this request */
  }
  return keys
}

/** Parse the persisted reality JSON column of a Proxy row. */
export function parseReality(json: string | null | undefined): RealityParams | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<RealityParams>
    if (v?.pbk) return { pbk: v.pbk, sid: v.sid || '', spx: v.spx || '/' }
    return null
  } catch {
    return null
  }
}

/**
 * Build a fresh reality params object for one proxy (public key from the
 * deployment keypair, random per-account short id).
 */
export async function newRealityParams(sid?: string): Promise<{ params: RealityParams; priv: string } | null> {
  const keys = await getRealityKeys()
  if (!keys) return null
  return {
    params: { pbk: keys.pub, sid: sid || randomShortId(), spx: '/' },
    priv: keys.priv,
  }
}
