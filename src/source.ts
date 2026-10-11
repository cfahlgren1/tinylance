// Byte sources. A source reads byte ranges of files inside one dataset directory.

export interface SourceEntry {
  name: string
  size?: number
  type?: 'file' | 'directory'
}

export interface Source {
  readAll?(path: string, signal?: AbortSignal): Promise<Uint8Array>
  read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
  size?(path: string, signal?: AbortSignal): Promise<number>
  list?(dir: string, signal?: AbortSignal): Promise<SourceEntry[]>
}

export type Fetch = typeof globalThis.fetch

/**
 * A source for a dataset URI: hf://, https://, s3:// or gs://. Bucket support is loaded only when
 * a bucket URI is opened, so apps that read from the Hub or plain HTTP never download it.
 */
export async function fromUri(uri: string): Promise<Source> {
  if (uri.startsWith('hf://')) return hfSource(uri)

  if (/^https?:\/\//.test(uri)) return httpSource(uri)

  const bucket = /^(s3|gs):\/\/([^/]+)\/?(.*)$/.exec(uri)

  if (!bucket) throw new Error(`unsupported dataset URI "${uri}" (use hf://, https://, s3:// or gs://, or pass a source)`)

  const { gcsSource, s3Source } = await import('./buckets.ts')
  const options = { bucket: bucket[2], prefix: bucket[3] }

  return bucket[1] === 's3' ? s3Source(options) : gcsSource(options)
}

/** a dataset URI rather than a source object */
export function isUri(source: string | Source): source is string {
  return typeof source === 'string'
}

export interface HttpSourceOptions {
  headers?: Record<string, string>
  fetch?: Fetch
}

/** Any HTTP server that supports range requests. `url` is the dataset directory. */
export function httpSource(url: string, options: HttpSourceOptions = {}): Source {
  const base = url.replace(/\/$/, '')
  const headers = options.headers ?? {}
  const f = options.fetch ?? globalThis.fetch
  // where each file redirected to (Hub resolve -> CDN), so later ranges skip the redirect hop
  const resolved = new Map<string, string>()

  async function get(path: string, range: string, signal: AbortSignal | undefined): Promise<Response> {
    const direct = resolved.get(path)
    const init: RequestInit = { headers: direct ? { Range: range } : { ...headers, Range: range } }

    if (signal) init.signal = signal

    const r = await f(direct ?? `${base}/${path}`, init)

    if (direct && (r.status === 401 || r.status === 403 || r.status === 410)) {
      resolved.delete(path) // the signed CDN URL expired

      return get(path, range, signal)
    }

    if (r.redirected && !direct) resolved.set(path, r.url)

    return r
  }

  return {
    async readAll(path, signal) {
      const init: RequestInit = { headers }

      if (signal) init.signal = signal

      const r = await f(`${base}/${path}`, init)

      if (!r.ok) throw new Error(`HTTP ${r.status} reading ${base}/${path}`)

      return new Uint8Array(await r.arrayBuffer())
    },
    async read(path, offset, length, signal) {
      const r = await get(path, `bytes=${offset}-${offset + length - 1}`, signal)

      if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status} reading ${base}/${path}`)

      const b = new Uint8Array(await r.arrayBuffer())

      // a server that ignores Range sends the whole file
      return r.status === 200 ? b.subarray(offset, offset + length) : b
    },
    async size(path, signal) {
      const init: RequestInit = { method: 'HEAD', headers }

      if (signal) init.signal = signal

      const r = await f(`${base}/${path}`, init)

      if (!r.ok) throw new Error(`HTTP ${r.status} for ${base}/${path}`)

      return Number(r.headers.get('content-length'))
    },
  }
}

export interface HfSourceOptions {
  revision?: string
  token?: string
  endpoint?: string
  fetch?: Fetch
}

interface HfTreeEntry {
  path: string
  size?: number
  type: 'file' | 'directory'
}

/** A dataset on the Hugging Face Hub: `hf://datasets/owner/name[@revision]/path/to/table.lance`. */
export function hfSource(url: string, options: HfSourceOptions = {}): Source {
  const m = /^hf:\/\/(datasets|models|spaces)\/([^/]+\/[^/@]+)(?:@([^/]+))?\/?(.*)$/.exec(url)

  if (!m) throw new Error(`not an hf:// URL: ${url}`)

  const [, kind, repo, rev, dir] = m
  const revision = encodeURIComponent(rev ?? options.revision ?? 'main')
  const endpoint = options.endpoint ?? 'https://huggingface.co'
  const f = options.fetch ?? globalThis.fetch
  const headers: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {}
  const prefix = dir ? `${dir.replace(/\/$/, '')}/` : ''
  const http = httpSource(`${endpoint}/${kind}/${repo}/resolve/${revision}/${prefix}`, { headers, fetch: f })

  return {
    ...http,
    async list(sub, signal) {
      const out: SourceEntry[] = []
      // no trailing slash: the Hub redirects it, and browsers block that redirect cross-origin
      let next: string | null = `${endpoint}/api/${kind}/${repo}/tree/${revision}/${prefix}${sub}`.replace(/\/$/, '')

      while (next) {
        const init: RequestInit = { headers }

        if (signal) init.signal = signal

        const r: Response = await f(next, init)

        if (!r.ok) throw new Error(`HTTP ${r.status} listing ${next}`)

        const entries: HfTreeEntry[] = await r.json()

        for (const e of entries) {
          const entry: SourceEntry = { name: e.path.slice(e.path.lastIndexOf('/') + 1), type: e.type }

          if (e.size !== undefined) entry.size = e.size
          out.push(entry)
        }

        next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1] ?? null
      }

      return out
    },
  }
}

/** A source that also remembers file tails, so a file's footer and metadata cost one request. */
export interface CachedSource extends Source {
  size(path: string, signal?: AbortSignal): Promise<number>
  tail(path: string, size: number | undefined, signal?: AbortSignal): Promise<{ start: number; bytes: Uint8Array; size: number }>
}

interface Pending {
  path: string
  offset: number
  length: number
  signal: AbortSignal | undefined
  resolve: (b: Uint8Array) => void
  reject: (e: Error) => void
}

/**
 * Wait for shared work on behalf of one caller: the caller's signal stops its wait, not the work,
 * so cancelling one read never fails another read sharing the same request.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work

  signal.throwIfAborted()

  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)

    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** cache a promise per key; failed promises are evicted so a later call can retry */
export function memo<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let p = cache.get(key)

  if (!p) {
    p = make()
    cache.set(key, p)
    p.catch(() => cache.delete(key))
  }

  return p
}

/**
 * Adds a per-file tail cache and merges reads issued in the same tick into fewer requests:
 * ranges in the same file that overlap or sit within `gap` bytes of each other become one read.
 */
export function cachedSource(source: Source, { tailSize = 64 * 1024, gap = 64 * 1024, cacheBytes = 16 * 1024 * 1024 } = {}): CachedSource {
  const tails = new Map<string, Promise<{ start: number; bytes: Uint8Array }>>()
  const sizes = new Map<string, Promise<number>>()
  // recently fetched ranges, least recently used first, so paging back and forth refetches nothing
  const recent: { path: string; start: number; bytes: Uint8Array }[] = []
  let recentBytes = 0
  let queue: Pending[] = []

  function remember(path: string, start: number, bytes: Uint8Array): void {
    if (bytes.byteLength > cacheBytes / 4) return

    recent.push({ path, start, bytes })
    recentBytes += bytes.byteLength

    while (recentBytes > cacheBytes) recentBytes -= recent.shift()?.bytes.byteLength ?? 0
  }

  function recall(path: string, offset: number, length: number): Uint8Array | null {
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i]

      if (r.path !== path || offset < r.start || offset + length > r.start + r.bytes.byteLength) continue

      // most recently used moves to the end
      recent.push(...recent.splice(i, 1))

      return r.bytes.subarray(offset - r.start, offset - r.start + length)
    }

    return null
  }

  function flush(): void {
    const batch = queue
    queue = []

    // only reads for the same file with the same signal can share a request
    const groups = new Map<string, Map<AbortSignal | undefined, Pending[]>>()

    for (const q of batch) {
      // reads cancelled while queued never go out
      if (q.signal?.aborted) {
        q.reject(q.signal.reason)
        continue
      }

      const bySignal = groups.get(q.path) ?? new Map<AbortSignal | undefined, Pending[]>()
      const list = bySignal.get(q.signal) ?? []

      list.push(q)
      bySignal.set(q.signal, list)
      groups.set(q.path, bySignal)
    }

    for (const [path, bySignal] of groups) {
      for (const [signal, qs] of bySignal) {
        qs.sort((a, b) => a.offset - b.offset)

        let group = [qs[0]]
        let start = qs[0].offset
        let end = qs[0].offset + qs[0].length

        for (const q of qs.slice(1)) {
          if (q.offset <= end + gap) {
            group.push(q)
            end = Math.max(end, q.offset + q.length)
            continue
          }

          run(path, group, start, end, signal)
          group = [q]
          start = q.offset
          end = q.offset + q.length
        }

        run(path, group, start, end, signal)
      }
    }
  }

  function run(path: string, group: Pending[], start: number, end: number, signal: AbortSignal | undefined): void {
    source.read(path, start, end - start, signal).then(
      (b) => {
        remember(path, start, b)

        for (const q of group) q.resolve(b.subarray(q.offset - start, q.offset - start + q.length))
      },
      (err: Error) => {
        for (const q of group) q.reject(err)
      },
    )
  }

  async function read(path: string, offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted()

    if (length === 0) return new Uint8Array(0)

    const tail = tails.get(path)

    if (tail) {
      const t = await abortable(tail, signal)

      if (offset >= t.start && offset + length <= t.start + t.bytes.byteLength) return t.bytes.subarray(offset - t.start, offset - t.start + length)

      if (length <= 1024 * 1024 && offset < t.start && offset + length > t.start && offset + length <= t.start + t.bytes.byteLength) {
        const prefix = await read(path, offset, t.start - offset, signal)
        const out = new Uint8Array(length)

        out.set(prefix)
        out.set(t.bytes.subarray(0, offset + length - t.start), t.start - offset)

        return out
      }
    }

    const hit = recall(path, offset, length)

    if (hit) return hit

    return new Promise((resolve, reject) => {
      if (!queue.length) setTimeout(flush, 0)
      queue.push({ path, offset, length, signal, resolve, reject })
    })
  }

  // sizes and tails are shared by every reader of the dataset, so they run without a caller's signal
  function size(path: string, signal?: AbortSignal): Promise<number> {
    const get = source.size?.bind(source)

    if (!get) return Promise.reject(new Error(`cannot get the size of ${path}: the source has no size()`))

    return abortable(
      memo(sizes, path, () => get(path)),
      signal,
    )
  }

  const cached: CachedSource = {
    read,
    size,
    async tail(path, knownSize, signal) {
      const fileSize = knownSize ?? (await size(path, signal))
      const start = Math.max(0, fileSize - tailSize)

      const t = await abortable(
        memo(tails, path, async () => ({ start, bytes: await read(path, start, fileSize - start) })),
        signal,
      )

      return { ...t, size: fileSize }
    },
  }

  if (source.readAll) cached.readAll = source.readAll.bind(source)

  if (source.list) cached.list = source.list.bind(source)

  return cached
}
