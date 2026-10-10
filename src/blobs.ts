// Blob columns: each row stores a descriptor of where its bytes live, and comes back as a
// LazyValue that fetches them on read().
import { unsupported } from './errors.ts'
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

/** Blob v2 (format 2.2): descriptors of (kind, position, size, blob_id, uri). */
export function blobV2Values(block: Block, n: number, dataFile: string, read: ReadFile): Value[] {
  const [kinds, positions, sizes, ids, uris] = block.packed ?? []

  if (!kinds || !positions || !sizes || !ids || !uris) return unsupported('blob v2 descriptors with other fields')

  return Array.from({ length: n }, (_, i): Value => {
    const kind = Number(kinds[i])
    const position = Number(positions[i])
    const size = Number(sizes[i])
    const id = Number(ids[i])
    const uriBytes = uris[i]
    const uri = uriBytes instanceof Uint8Array ? utf8.decode(uriBytes) : ''

    if (kind === INLINE) return lazy(size, (signal) => read(dataFile, position, size, signal))

    if (kind === PACKED) return lazy(size, (signal) => read(sidecar(dataFile, id), position, size, signal))

    if (kind === DEDICATED) return lazy(size, (signal) => read(sidecar(dataFile, id), 0, size, signal))

    if (kind === MANAGED) return lazy(size, (signal) => read(uri, position, size, signal))

    if (kind === EXTERNAL && id === 0 && /^https?:\/\//.test(uri)) return lazy(size, (signal) => fetchRange(uri, position, size, signal))

    // one unreadable blob shouldn't fail the whole read: it fails when read
    return lazy(size, async () => unsupported(kind === EXTERNAL ? `external blobs at ${uri || `base ${id}`}` : `blob kind ${kind}`))
  })
}

async function fetchRange(url: string, position: number, size: number, signal?: AbortSignal): Promise<Uint8Array> {
  const init: RequestInit = { headers: { Range: `bytes=${position}-${position + size - 1}` } }

  if (signal) init.signal = signal

  const r = await fetch(url, init)

  if (!r.ok) throw new Error(`HTTP ${r.status} reading ${url}`)

  const b = new Uint8Array(await r.arrayBuffer())

  return r.status === 200 ? b.subarray(position, position + size) : b
}
