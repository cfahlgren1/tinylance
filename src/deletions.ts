// Deletion files: an Arrow IPC file with one uint32 column of deleted row offsets,
// or a serialized 32-bit Roaring bitmap.
import { corrupt } from './errors.ts'
import type { Zstd } from './types.ts'

export function parseDeletionFile(bytes: Uint8Array, type: 'arrow' | 'bitmap', zstd: Zstd | undefined): Uint32Array {
  return (type === 'bitmap' ? roaring(bytes) : arrowUint32Column(bytes, zstd)).sort()
}

// ---- a minimal flatbuffer reader, enough for an Arrow IPC Message / RecordBatch ----

interface FlatTable {
  u8(i: number): number
  i64(i: number): number
  table(i: number): FlatTable | null
  structs(i: number, size: number): number[]
  dv: DataView
}

function flatTable(b: Uint8Array, pos: number): FlatTable {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const vt = pos - dv.getInt32(pos, true)
  const vtLen = dv.getUint16(vt, true)

  const field = (i: number): number => {
    const o = 4 + i * 2

    return o < vtLen ? dv.getUint16(vt + o, true) : 0
  }

  return {
    u8: (i) => (field(i) ? b[pos + field(i)] : 0),
    i64: (i) => (field(i) ? Number(dv.getBigInt64(pos + field(i), true)) : 0),
    table: (i) => {
      const f = field(i)

      return f ? flatTable(b, pos + f + dv.getUint32(pos + f, true)) : null
    },
    structs: (i, size) => {
      const f = field(i)

      if (!f) return []

      const v = pos + f + dv.getUint32(pos + f, true)

      return Array.from({ length: dv.getUint32(v, true) }, (_, k) => v + 4 + k * size)
    },
    dv,
  }
}

const MESSAGE_RECORD_BATCH = 3

/** the values of the first column of every record batch in an Arrow IPC file or stream, as uint32 */
export function arrowUint32Column(bytes: Uint8Array, zstd: Zstd | undefined): Uint32Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: number[] = []
  let o = bytes[0] === 0x41 && bytes[1] === 0x52 ? 8 : 0 // "ARROW1\0\0"

  while (o + 8 <= bytes.byteLength) {
    let len = dv.getInt32(o, true)
    o += 4

    if (len === 0) continue // alignment padding

    if (len === -1) {
      len = dv.getInt32(o, true)
      o += 4
    }

    if (len === 0) break // end of stream

    const meta = bytes.subarray(o, o + len)
    o += len

    const m = flatTable(meta, new DataView(meta.buffer, meta.byteOffset).getUint32(0, true))
    const headerType = m.u8(1)
    const bodyLength = m.i64(3)
    const rb = headerType === MESSAGE_RECORD_BATCH ? m.table(2) : null

    if (rb) {
      const n = rb.i64(0)
      const buffers = rb.structs(2, 16).map((p) => [Number(rb.dv.getBigInt64(p, true)), Number(rb.dv.getBigInt64(p + 8, true))])
      const [off, size] = buffers[1] // [validity, values]
      let body = bytes.subarray(o + off, o + off + size)
      const codec = rb.table(3)

      if (codec) {
        // compressed IPC buffers: i64 uncompressed length (-1 = stored raw), then the frame
        const raw = new DataView(body.buffer, body.byteOffset, 8).getBigInt64(0, true) === -1n

        if (!raw && (codec.u8(0) !== 1 || !zstd)) throw new Error('this deletion file is zstd-compressed: pass decompressors: { zstd } to lanceOpen')

        body = raw || !zstd ? body.subarray(8) : zstd(body.subarray(8))
      }

      const vals = new DataView(body.buffer, body.byteOffset, n * 4)

      for (let i = 0; i < n; i++) out.push(vals.getUint32(i * 4, true))
    }

    o += bodyLength

    if (headerType === 0 || bytes.byteLength - o < 8) break
  }

  return Uint32Array.from(out)
}

/** RoaringBitmap portable serialization (32-bit) */
export function roaring(bytes: Uint8Array): Uint32Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cookie = dv.getUint32(0, true)
  let o: number
  let size: number
  let runs: Uint8Array | null = null

  if ((cookie & 0xffff) === 12347) {
    size = (cookie >>> 16) + 1
    o = 4
    runs = bytes.subarray(o, o + Math.ceil(size / 8))
    o += Math.ceil(size / 8)
  } else if (cookie === 12346) {
    size = dv.getUint32(4, true)
    o = 8
  } else {
    corrupt('deletion bitmap')
  }

  const keys: number[] = []
  const cards: number[] = []

  for (let i = 0; i < size; i++) {
    keys.push(dv.getUint16(o, true))
    cards.push(dv.getUint16(o + 2, true) + 1)
    o += 4
  }

  if (!runs || size >= 4) o += 4 * size // container offsets

  const out: number[] = []

  for (let i = 0; i < size; i++) {
    const hi = keys[i] << 16
    const isRun = runs && (runs[i >> 3] >> (i & 7)) & 1

    if (isRun) {
      const n = dv.getUint16(o, true)
      o += 2

      for (let r = 0; r < n; r++) {
        const s = dv.getUint16(o, true)
        const l = dv.getUint16(o + 2, true)
        o += 4

        for (let v = s; v <= s + l; v++) out.push((hi | v) >>> 0)
      }
    } else if (cards[i] <= 4096) {
      for (let k = 0; k < cards[i]; k++) {
        out.push((hi | dv.getUint16(o, true)) >>> 0)
        o += 2
      }
    } else {
      // bitset container: 1024 u64 words, read as 2048 u32 halves
      for (let w = 0; w < 2048; w++) {
        let word = dv.getUint32(o + w * 4, true)

        for (let bit = 0; word; bit++, word >>>= 1) if (word & 1) out.push((hi | (w * 32 + bit)) >>> 0)
      }

      o += 8192
    }
  }

  return Uint32Array.from(out)
}
