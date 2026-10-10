// Blob columns: each row stores a descriptor of where its bytes live, and comes back as a
// LazyValue that fetches them on read().
import { unsupported } from './errors.ts'
import type { Fetch } from './source.ts'
import type { Block, LazyValue, Value } from './types.ts'

/** reads a range of a file, by path relative to the dataset root */
export type ReadFile = (path: string, offset: number, length: number, signal?: AbortSignal) => Promise<Uint8Array>

const EMPTY = new Uint8Array(0)

function lazy(byteLength: number, read: (signal?: AbortSignal) => Promise<Uint8Array>): LazyValue {
  return { byteLength, read: (signal) => (byteLength ? read(signal) : Promise.resolve(EMPTY)) }
}

/**
 * Blob v1 (formats 2.0 and 2.1): (position, size) at an absolute offset in the row's own data
 * file. A null is stored as size 0 at a non-zero position.
 */
export function blobV1Values(block: Block, n: number, readAt: (offset: number, length: number, signal?: AbortSignal) => Promise<Uint8Array>): Value[] {
  const [pos, size] = block.packed ?? []

  if (!pos || !size) return unsupported('blob descriptors without position and size')

  return Array.from({ length: n }, (_, i): Value => {
    const p = Number(pos[i])
    const s = Number(size[i])

    return s === 0 && p !== 0 ? null : lazy(s, (signal) => readAt(p, s, signal))
  })
}

// blob v2 kinds: where a row's bytes are
const INLINE = 0 // in the data file, at `position`

const PACKED = 1 // in a shared sidecar file `blob_id`, at `position`

const DEDICATED = 2 // the whole of sidecar file `blob_id`

const EXTERNAL = 3 // at an external URI

const MANAGED = 4 // a file in the dataset directory, at `uri`

/** sidecar files are named by the blob id's 32 bits, reversed */
const sidecar = (dataFile: string, id: number): string =>
  `${dataFile.replace(/\.lance$/, '')}/${id.toString(2).padStart(32, '0').split('').reverse().join('')}.blob`

const utf8 = new TextDecoder()

/** a descriptor field as an exact number; null when it is past 2^53 or not a number */
function exact(v: number | bigint | Uint8Array | undefined): number | null {
  const n = v instanceof Uint8Array || v === undefined ? NaN : Number(v)

  return Number.isSafeInteger(n) ? n : null
}

/** a value that fails when read, so one unreadable blob doesn't fail the whole read */
const failing = (byteLength: number | undefined, what: string): LazyValue => ({ byteLength, read: async () => unsupported(what) })

/** Blob v2 (format 2.2): descriptors of (kind, position, size, blob_id, uri). */
export function blobV2Values(block: Block, n: number, dataFile: string, read: ReadFile, fetchUrl: Fetch): Value[] {
  const [kinds, positions, sizes, ids, uris] = block.packed ?? []

  if (!kinds || !positions || !sizes || !ids || !uris) return unsupported('blob v2 descriptors with other fields')

  return Array.from({ length: n }, (_, i): Value => {
    const kind = exact(kinds[i])
    const position = exact(positions[i])
    const size = exact(sizes[i])
    const id = exact(ids[i]) ?? -1
    const uriBytes = uris[i]
    const uri = uriBytes instanceof Uint8Array ? utf8.decode(uriBytes) : ''

    if (position === null || size === null) return failing(undefined, 'blobs at offsets past 2^53')

    if (kind === INLINE) return lazy(size, (signal) => read(dataFile, position, size, signal))

    if (kind === PACKED) return lazy(size, (signal) => read(sidecar(dataFile, id), position, size, signal))

    if (kind === DEDICATED) return lazy(size, (signal) => read(sidecar(dataFile, id), 0, size, signal))

    if (kind === MANAGED) return lazy(size, (signal) => read(uri, position, size, signal))

    if (kind === EXTERNAL) {
      // size 0 at position 0 means the whole object, whose length is unknown until fetched
      const whole = size === 0 && position === 0

      if (id !== 0 || !/^https?:\/\//.test(uri)) return failing(whole ? undefined : size, `external blobs at ${uri || `base ${id}`}`)

      if (whole) return { byteLength: undefined, read: (signal) => fetchBytes(fetchUrl, uri, null, signal) }

      return lazy(size, (signal) => fetchBytes(fetchUrl, uri, [position, size], signal))
    }

    return failing(size, `blob kind ${kind}`)
  })
}

/** an external URL, or a range of it */
async function fetchBytes(f: Fetch, url: string, range: [number, number] | null, signal?: AbortSignal): Promise<Uint8Array> {
  const init: RequestInit = range ? { headers: { Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` } } : {}

  if (signal) init.signal = signal

  const r = await f(url, init)

  if (!r.ok) throw new Error(`HTTP ${r.status} reading ${url}`)

  const b = new Uint8Array(await r.arrayBuffer())

  // a server that ignores Range sends the whole object
  return range && r.status === 200 ? b.subarray(range[0], range[0] + range[1]) : b
}
