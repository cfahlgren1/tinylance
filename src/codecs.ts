// Low-level codecs shared by the 2.0 and 2.1 decoders: bytes in, typed arrays out,
// with no BigInt arithmetic in hot loops.
import type { DecodeContext, Words } from './types.ts'

/** View `n` values of `bits` width, copying into an aligned buffer only when the input is misaligned or short. */
export function words(buf: Uint8Array, bits: number, n: number = (buf.byteLength * 8) / bits): Words {
  const size = (n * bits) / 8
  let copy = buf

  if (buf.byteOffset % 8 !== 0 || buf.byteLength < size) {
    copy = new Uint8Array(Math.ceil(size / 8) * 8)
    copy.set(buf.subarray(0, size))
  }

  const { buffer, byteOffset } = copy

  if (bits === 8) return new Uint8Array(buffer, byteOffset, n)

  if (bits === 16) return new Uint16Array(buffer, byteOffset, n)

  if (bits === 32) return new Uint32Array(buffer, byteOffset, n)

  if (bits === 64) return new BigUint64Array(buffer, byteOffset, n)

  throw new Error(`unsupported word width ${bits}`)
}

export function typedFor(bits: number, n: number): Words {
  if (bits === 8) return new Uint8Array(n)

  if (bits === 16) return new Uint16Array(n)

  if (bits === 32) return new Uint32Array(n)

  if (bits === 64) return new BigUint64Array(n)

  throw new Error(`unsupported word width ${bits}`)
}

/** a new zeroed array of the same kind as `like` */
export function sameKind(like: Words, n: number): Words {
  if (like instanceof BigUint64Array) return new BigUint64Array(n)

  if (like instanceof Uint32Array) return new Uint32Array(n)

  if (like instanceof Uint16Array) return new Uint16Array(n)

  return new Uint8Array(n)
}

/** every value of a word array as a number */
export function toNumbers(w: Words): number[] {
  const out = new Array<number>(w.length)

  for (let i = 0; i < w.length; i++) out[i] = Number(w[i])

  return out
}

/** bytes of any word array */
export function asBytes(w: Words): Uint8Array {
  return w instanceof Uint8Array ? w : new Uint8Array(w.buffer, w.byteOffset, w.byteLength)
}

/** LSB-first bitmap to 0/1 bytes */
export function unpackBits(buf: Uint8Array, n: number, bitOffset = 0): Uint8Array {
  const out = new Uint8Array(n)

  for (let i = 0; i < n; i++) {
    const j = i + bitOffset
    out[i] = (buf[j >> 3] >> (j & 7)) & 1
  }

  return out
}

// FastLanes bit unpacking: 1024 values per block, in transposed lane order
const FL_ORDER = [0, 4, 2, 6, 1, 5, 3, 7]

/** Unpack one 1024-value FastLanes block of `w`-bit values stored in `t`-bit words into `out` at `outOffset`. */
export function fastlanesUnpack(packed: Uint8Array, t: number, w: number, out: Words, outOffset = 0): void {
  if (w === 0) return

  if (out instanceof BigUint64Array) return fastlanesUnpack64(packed, w, out, outOffset)

  const lanes = 1024 / t
  const src = words(packed, t, lanes * w)

  if (src instanceof BigUint64Array) throw new Error('fastlanes: 64-bit words need a 64-bit output')

  const mask = w === 32 ? 0xffffffff : (1 << w) - 1

  for (let row = 0; row < t; row++) {
    const bitPos = row * w
    const wi = Math.floor(bitPos / t)
    const shift = bitPos % t
    const spill = shift + w > t
    const base = FL_ORDER[row >> 3] * 16 + (row & 7) * 128 + outOffset
    const w0 = lanes * wi
    const w1 = lanes * (wi + 1)

    for (let lane = 0; lane < lanes; lane++) {
      let v = src[w0 + lane] >>> shift

      if (spill) v |= src[w1 + lane] << (t - shift)
      out[base + lane] = (v & mask) >>> 0
    }
  }
}

function fastlanesUnpack64(packed: Uint8Array, w: number, out: BigUint64Array, outOffset: number): void {
  // 16 lanes of 64-bit words, read through 32-bit halves so no value goes through BigInt
  const lanes = 16
  const aligned = words(packed, 64, lanes * w)
  const src = new Uint32Array(aligned.buffer, aligned.byteOffset, lanes * w * 2)
  const out32 = new Uint32Array(out.buffer, out.byteOffset, out.length * 2)

  // bits [p, p + n) of one lane's bitstream, n <= 32
  const get = (lane: number, p: number, n: number): number => {
    const word = Math.floor(p / 64)
    const within = p % 64
    const half = within >= 32 ? 1 : 0
    const sh = within % 32
    const idx = 2 * (lanes * word + lane) + half
    let v = src[idx] >>> sh

    if (sh + n > 32) {
      const nextIdx = half ? 2 * (lanes * (word + 1) + lane) : idx + 1
      v |= src[nextIdx] << (32 - sh)
    }

    return n === 32 ? v >>> 0 : (v & ((1 << n) - 1)) >>> 0
  }

  for (let row = 0; row < 64; row++) {
    const p = row * w
    const base = FL_ORDER[row >> 3] * 16 + (row & 7) * 128 + outOffset

    for (let lane = 0; lane < lanes; lane++) {
      const o = 2 * (base + lane)
      out32[o] = get(lane, p, Math.min(w, 32))
      out32[o + 1] = w > 32 ? get(lane, p + 32, w - 32) : 0
    }
  }
}

/** Plain LSB-first bit packing (the 2.0 "bitpacked" encoding), starting `bitOffset` bits in. */
export function unpackPlain(buf: Uint8Array, w: number, t: number, n: number, signed: boolean, bitOffset = 0): Words {
  const out = typedFor(t, n)

  if (out instanceof BigUint64Array) {
    for (let i = 0; i < n; i++) {
      let v = 0n

      for (let b = 0; b < w; b++) {
        const p = bitOffset + i * w + b

        if ((buf[p >> 3] >> (p & 7)) & 1) v |= 1n << BigInt(b)
      }

      if (signed && w < 64 && v >> BigInt(w - 1)) v |= ~((1n << BigInt(w)) - 1n)
      out[i] = BigInt.asUintN(64, v)
    }

    return out
  }

  for (let i = 0; i < n; i++) {
    let v = 0

    for (let b = 0; b < w; b++) {
      const p = bitOffset + i * w + b
      v |= ((buf[p >> 3] >> (p & 7)) & 1) << b
    }

    if (signed && w < 32 && v >> (w - 1)) v |= ~((1 << w) - 1)
    out[i] = v
  }

  return out
}

/** LZ4 block with a u32 little-endian uncompressed size prefix */
export function lz4(input: Uint8Array): Uint8Array {
  const size = new DataView(input.buffer, input.byteOffset, 4).getUint32(0, true)

  return lz4Raw(input.subarray(4), size)
}

export function lz4Raw(input: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size)
  const n = input.length
  let i = 0
  let o = 0

  while (i < n) {
    const token = input[i++]
    let lit = token >> 4

    if (lit === 15) {
      let b: number

      do {
        b = input[i++]
        lit += b
      } while (b === 255)
    }

    out.set(input.subarray(i, i + lit), o)
    i += lit
    o += lit

    if (i >= n) break

    const offset = input[i] | (input[i + 1] << 8)
    i += 2

    let len = token & 15

    if (len === 15) {
      let b: number

      do {
        b = input[i++]
        len += b
      } while (b === 255)
    }

    len += 4

    if (offset >= len) out.copyWithin(o, o - offset, o - offset + len)
    else for (let k = 0; k < len; k++) out[o + k] = out[o + k - offset]

    o += len
  }

  return out
}

/** zstd is pluggable. Lance writes either a bare zstd frame or a u64 length prefix and then the frame. */
export function zstd(input: Uint8Array, ctx: DecodeContext): Uint8Array {
  if (!ctx.zstd) throw new Error('this column is zstd-compressed: pass decompressors: { zstd } to lanceOpen (Node >= 22.15 has it built in)')

  if (input.byteLength === 0) return input

  const bare = input[0] === 0x28 && input[1] === 0xb5 && input[2] === 0x2f && input[3] === 0xfd

  return ctx.zstd(bare ? input : input.subarray(8))
}

export type Compression = 'lz4' | 'zstd'

export function decompress(scheme: Compression, input: Uint8Array, ctx: DecodeContext): Uint8Array {
  return scheme === 'lz4' ? lz4(input) : zstd(input, ctx)
}

export function compressionName(name: string): Compression {
  if (name === 'lz4' || name === 'zstd') return name

  throw new Error(`unsupported compression "${name}"`)
}

export interface FsstTable {
  on: boolean
  lens: Uint8Array
  symbols: Uint8Array
}

export function fsstTable(t: Uint8Array): FsstTable {
  // 8-byte header: low byte = symbol count, bit 24 = decoder switch; then n u64 symbols, then n lengths
  const n = t[0]

  return { on: (t[3] & 1) === 1, lens: t.subarray(8 + n * 8, 8 + n * 9), symbols: t.subarray(8, 8 + n * 8) }
}

export function fsstDecode(b: Uint8Array, table: FsstTable): Uint8Array {
  if (!table.on) return b

  const { lens, symbols } = table
  const out = new Uint8Array(b.length * 8)
  let o = 0

  for (let i = 0; i < b.length; i++) {
    const c = b[i]

    if (c === 255) {
      out[o++] = b[++i]
      continue
    }

    const l = lens[c]
    const s = c * 8

    for (let k = 0; k < l; k++) out[o++] = symbols[s + k]
  }

  return out.subarray(0, o)
}

/** Decode every value of an FSST-compressed offsets + bytes block into one contiguous buffer. */
/** variable-width values: n + 1 offsets into bytes */
export interface VarBytes {
  offsets: Uint32Array
  bytes: Uint8Array
}

export function fsstDecodeAll(offsets: ArrayLike<number>, bytes: Uint8Array, n: number, table: FsstTable): VarBytes {
  if (!table.on) return { offsets: Uint32Array.from(offsets), bytes }

  // every code expands to at most 8 bytes, so decode straight into one buffer sized for the worst case
  const out = new Uint8Array((Number(offsets[n]) - Number(offsets[0])) * 8)
  const outOffsets = new Uint32Array(n + 1)
  const { lens, symbols } = table
  let o = 0

  for (let i = 0; i < n; i++) {
    outOffsets[i] = o

    for (let j = Number(offsets[i]), end = Number(offsets[i + 1]); j < end; j++) {
      const c = bytes[j]

      if (c === 255) {
        out[o++] = bytes[++j]
        continue
      }

      const l = lens[c]
      const s = c * 8

      for (let k = 0; k < l; k++) out[o++] = symbols[s + k]
    }
  }

  outOffsets[n] = o

  return { offsets: outOffsets, bytes: out.subarray(0, o) }
}

/** byte stream split: byte k of value i lives at k * n + i */
export function byteStreamSplit(buf: Uint8Array, bytesPerValue: number, n: number): Uint8Array {
  const out = new Uint8Array(n * bytesPerValue)

  for (let k = 0; k < bytesPerValue; k++) {
    const s = k * n

    for (let i = 0; i < n; i++) out[i * bytesPerValue + k] = buf[s + i]
  }

  return out
}

/** values[i] repeated runLengths[i] times, clamped to n */
export function rle(values: Words, runLengths: Words, n: number): Words {
  const out = sameKind(values, n)
  let o = 0

  for (let i = 0; i < runLengths.length && o < n; i++) {
    const end = Math.min(n, o + Number(runLengths[i]))

    if (out instanceof BigUint64Array) out.fill(BigInt(values[i]), o, end)
    else out.fill(Number(values[i]), o, end)

    o = end
  }

  return out
}

export const align8 = (x: number): number => (x + 7) & ~7

/** little-endian unsigned integer of `size` bytes at `o` */
export function readUint(b: Uint8Array, o: number, size: number): number {
  let v = 0

  for (let k = size - 1; k >= 0; k--) v = v * 256 + b[o + k]

  return v
}
