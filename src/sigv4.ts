// AWS Signature Version 4 with WebCrypto, so private S3 / R2 / MinIO buckets work in browsers,
// Node and Workers. Kept in its own module so bundles that don't sign never include it.
import type { Signer } from './buckets.ts'

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region?: string
  service?: string
}

const enc = new TextEncoder()

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

const sha256 = async (s: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))

async function hmac(key: BufferSource, s: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])

  return crypto.subtle.sign('HMAC', k, enc.encode(s))
}

/** Sign a request at `date` (exposed for testing against AWS's reference signatures). */
export async function signRequest(url: string, init: RequestInit, credentials: AwsCredentials, date: Date): Promise<RequestInit> {
  const u = new URL(url)
  const region = credentials.region ?? 'us-east-1'
  const service = credentials.service ?? 's3'
  const payloadHash = 'UNSIGNED-PAYLOAD'
  const now = date.toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = now.slice(0, 8)
  const headers = new Headers(init.headers)

  headers.set('x-amz-date', now)
  headers.set('x-amz-content-sha256', payloadHash)

  if (credentials.sessionToken) headers.set('x-amz-security-token', credentials.sessionToken)

  // host is signed but sent by fetch itself
  const signed = new Headers(headers)

  signed.set('host', u.host)

  const names = Array.from(signed.keys()).sort()

  const query = Array.from(u.searchParams)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const canonical = [
    init.method ?? 'GET',
    u.pathname,
    query,
    names.map((h) => `${h}:${(signed.get(h) ?? '').trim()}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n')

  const scope = `${day}/${region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', now, scope, await sha256(canonical)].join('\n')
  let k = await hmac(enc.encode(`AWS4${credentials.secretAccessKey}`), day)

  for (const part of [region, service, 'aws4_request']) k = await hmac(k, part)

  headers.set(
    'authorization',
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hex(await hmac(k, toSign))}`,
  )

  return { ...init, headers }
}

/** A signer for `s3Source({ sign })`. */
export function sigv4(credentials: AwsCredentials): Signer {
  return (url, init) => signRequest(url, init, credentials, new Date())
}
