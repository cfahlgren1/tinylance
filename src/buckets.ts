// Object stores: S3 (and S3-compatible stores) and Google Cloud Storage.
import { httpSource } from './source.ts'
import type { Fetch, Source, SourceEntry } from './source.ts'

/** Signs a request, e.g. with `sigv4(credentials)`. Returns the init to send. */
export type Signer = (url: string, init: RequestInit) => Promise<RequestInit>

export interface S3SourceOptions {
  bucket: string
  region?: string
  /** the dataset directory inside the bucket */
  prefix?: string
  /** custom endpoint for R2, MinIO, Tigris, ... (defaults to AWS virtual-hosted URLs) */
  endpoint?: string
  /** for private buckets: `sign: sigv4({ accessKeyId, secretAccessKey })` */
  sign?: Signer
  fetch?: Fetch
}

const xmlTag = (xml: string, tag: string): string[] => Array.from(xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')), (m) => m[1])

const trimSlashes = (p: string): string => p.replace(/^\/|\/$/g, '')

/** S3 or an S3-compatible store. Public buckets need no auth. */
export function s3Source(options: S3SourceOptions): Source {
  const f = options.fetch ?? globalThis.fetch

  const host = options.endpoint
    ? `${options.endpoint.replace(/\/$/, '')}/${options.bucket}`
    : `https://${options.bucket}.s3.${options.region ?? 'us-east-1'}.amazonaws.com`

  const prefix = trimSlashes(options.prefix ?? '')
  const sign = options.sign

  const signed: Fetch = async (input, init = {}) => {
    const url = String(input)

    return f(url, sign ? await sign(url, init) : init)
  }

  const http = httpSource(prefix ? `${host}/${prefix}` : host, { fetch: signed })

  return {
    ...http,
    async list(dir, signal) {
      const p = `${prefix ? `${prefix}/` : ''}${dir}/`
      const out: SourceEntry[] = []
      let token: string | undefined

      do {
        const q = new URLSearchParams({ 'list-type': '2', prefix: p, delimiter: '/' })

        if (token) q.set('continuation-token', token)

        const init: RequestInit = {}

        if (signal) init.signal = signal

        const r = await signed(`${host}/?${q}`, init)

        if (!r.ok) throw new Error(`S3 list ${r.status} for ${host}/${p}`)

        const xml = await r.text()

        for (const c of xmlTag(xml, 'Contents'))
          out.push({ name: (xmlTag(c, 'Key')[0] ?? '').slice(p.length), size: Number(xmlTag(c, 'Size')[0]), type: 'file' })

        for (const c of xmlTag(xml, 'CommonPrefixes')) out.push({ name: (xmlTag(c, 'Prefix')[0] ?? '').slice(p.length).replace(/\/$/, ''), type: 'directory' })

        token = xmlTag(xml, 'NextContinuationToken')[0]
      } while (token)

      return out
    },
  }
}

export interface GcsSourceOptions {
  bucket: string
  prefix?: string
  /** OAuth bearer token for private buckets */
  token?: string
  fetch?: Fetch
}

interface GcsListing {
  items?: { name: string; size: string }[]
  prefixes?: string[]
  nextPageToken?: string
}

/** Google Cloud Storage. Public buckets need no auth. */
export function gcsSource(options: GcsSourceOptions): Source {
  const f = options.fetch ?? globalThis.fetch
  const headers: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {}
  const prefix = trimSlashes(options.prefix ?? '')
  const http = httpSource(`https://storage.googleapis.com/${options.bucket}${prefix ? `/${prefix}` : ''}`, { headers, fetch: f })

  return {
    ...http,
    async list(dir, signal) {
      const p = `${prefix ? `${prefix}/` : ''}${dir}/`
      const out: SourceEntry[] = []
      let pageToken: string | undefined

      do {
        const q = new URLSearchParams({ prefix: p, delimiter: '/' })

        if (pageToken) q.set('pageToken', pageToken)

        const init: RequestInit = { headers }

        if (signal) init.signal = signal

        const r = await f(`https://storage.googleapis.com/storage/v1/b/${options.bucket}/o?${q}`, init)

        if (!r.ok) throw new Error(`GCS list ${r.status} for gs://${options.bucket}/${p}`)

        const j: GcsListing = await r.json()

        for (const o of j.items ?? []) out.push({ name: o.name.slice(p.length), size: Number(o.size), type: 'file' })

        for (const d of j.prefixes ?? []) out.push({ name: d.slice(p.length).replace(/\/$/, ''), type: 'directory' })

        pageToken = j.nextPageToken
      } while (pageToken)

      return out
    },
  }
}
