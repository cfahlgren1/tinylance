// Lance file format 2.0 pages ("ArrayEncoding" trees, protos/encodings_v2_0.proto).
// Every encoding here can be sliced by row, so only the bytes for the requested rows are fetched.
import { corrupt, unsupported } from './errors.ts'
import { asBytes, compressionName, decompress, fastlanesUnpack, fsstDecodeAll, fsstTable, typedFor, unpackBits, unpackPlain, words } from './codecs.ts'
import type { Compression, FsstTable } from './codecs.ts'
import { all, bytes, decode, msg, num, oneofTag, str } from './proto.ts'
import type { Proto } from './proto.ts'
import type { Block, DecodeContext, LazyValue, PackedChild } from './types.ts'

/** a buffer of the page (0), the column (1) or the file (2) */
export interface BufferRef {
  index: number
  type: number
}

export type Enc20 =
  | { kind: 'flat'; bits: number; buffer: BufferRef; compression: Compression | undefined }
  | { kind: 'allnull' }
  | { kind: 'nullable'; validity: Enc20 | undefined; values: Enc20 }
  | { kind: 'fsl'; dim: number; items: Enc20 }
  | { kind: 'list'; offsets: Enc20; nullAdjust: number; numItems: number }
  | { kind: 'binary'; indices: Enc20; bytes: Enc20; nullAdjust: number }
  | { kind: 'dict'; indices: Enc20; items: Enc20; size: number }
  | { kind: 'fsst'; binary: Enc20; table: FsstTable }
  | { kind: 'bitpacked'; bits: number; outBits: number; buffer: BufferRef; signed: boolean }
  | { kind: 'fastlanes'; bits: number; outBits: number; buffer: BufferRef }
  | { kind: 'fsb'; bytes: Enc20; width: number }
  | { kind: 'packedstruct'; inner: Enc20[]; buffer: BufferRef }
  | { kind: 'constant'; value: Uint8Array }
  | { kind: 'unsupported'; name: string }

/** returns bytes [from, to) of a referenced buffer */
export type BufferReader = (ref: BufferRef, from: number, to: number, signal: AbortSignal | undefined) => Promise<Uint8Array>

function required(m: Proto, k: number): Uint8Array {
  const b = bytes(m, k)

  if (!b) corrupt('encoding')

  return b
}

function bufferRef(m: Proto, k: number): BufferRef {
  const b = msg(m, k)

  if (!b) corrupt('encoding')

  return { index: num(b, 1), type: num(b, 2) }
}

export function parseArrayEncoding(raw: Uint8Array): Enc20 {
  const e = decode(raw)
  const tag = oneofTag(e)
  const m = decode(required(e, tag))
  const sub = (k: number): Enc20 => parseArrayEncoding(required(m, k))

  switch (tag) {
    case 1: {
      const c = msg(m, 3)

      return { kind: 'flat', bits: num(m, 1), buffer: bufferRef(m, 2), compression: c ? compressionName(str(c, 1)) : undefined }
    }

    case 2: {
      const nonNull = msg(m, 1)

      if (nonNull) return { kind: 'nullable', validity: undefined, values: parseArrayEncoding(required(nonNull, 1)) }

      const some = msg(m, 2)

      if (some) return { kind: 'nullable', validity: parseArrayEncoding(required(some, 1)), values: parseArrayEncoding(required(some, 2)) }

      return { kind: 'allnull' }
    }

    case 3:
      return { kind: 'fsl', dim: num(m, 1), items: sub(2) }
    case 4:
      return { kind: 'list', offsets: sub(1), nullAdjust: num(m, 2), numItems: num(m, 3) }
    case 6:
      return { kind: 'binary', indices: sub(1), bytes: sub(2), nullAdjust: num(m, 3) }
    case 7:
      return { kind: 'dict', indices: sub(1), items: sub(2), size: num(m, 3) }
    case 8:
      return { kind: 'fsst', binary: sub(1), table: fsstTable(required(m, 2)) }
    case 9:
      return { kind: 'packedstruct', inner: all(m, 1).map(parseArrayEncoding), buffer: bufferRef(m, 2) }
    case 10:
      return { kind: 'bitpacked', bits: num(m, 1), outBits: num(m, 2), buffer: bufferRef(m, 3), signed: !!num(m, 4) }
    case 11:
      return { kind: 'fsb', bytes: sub(1), width: num(m, 2) }
    case 12:
      return { kind: 'fastlanes', bits: num(m, 1), outBits: num(m, 2), buffer: bufferRef(m, 3) }
    case 13:
      return { kind: 'constant', value: required(m, 1) }
    default:
      return { kind: 'unsupported', name: tag === 5 ? 'struct' : `#${tag}` }
  }
}

/** Decode rows [s, e) of a 2.0 page. */
export async function decode20(enc: Enc20, s: number, e: number, buf: BufferReader, ctx: DecodeContext): Promise<Block> {
  const n = e - s

  switch (enc.kind) {
    case 'allnull':
      return { allNull: true }
    case 'nullable': {
      const [valid, values] = await Promise.all([enc.validity ? decode20(enc.validity, s, e, buf, ctx) : null, decode20(enc.values, s, e, buf, ctx)])

      if (!valid?.fixed) return values

      return { ...values, valid: asBytes(valid.fixed) }
    }

    case 'flat': {
      const { bits } = enc

      if (enc.compression) {
        // compressed flat buffers have to be read whole
        const whole = decompress(enc.compression, await buf(enc.buffer, 0, Infinity, ctx.signal), ctx)

        return sliceFixed(whole, bits, s, n)
      }

      if (bits === 1) return { bits, fixed: unpackBits(await buf(enc.buffer, s >> 3, (e + 7) >> 3, ctx.signal), n, s & 7) }

      const width = bits / 8

      return sliceFixed(await buf(enc.buffer, s * width, e * width, ctx.signal), bits, 0, n)
    }

    case 'fsl': {
      // the items' validity is per item; row nulls come from a nullable wrapper around the list
      const { valid, allNull, ...inner } = await decode20(enc.items, s * enc.dim, e * enc.dim, buf, ctx)
      const block: Block = { ...inner, dim: enc.dim * (inner.dim ?? 1) }

      if ((valid || allNull) && inner.dim) unsupported('nested fixed-size lists with nulls inside')

      // every item null: the rows themselves are still valid vectors
      if (allNull) block.itemValid = new Uint8Array(n * enc.dim)
      else if (valid) block.itemValid = valid

      return block
    }

    case 'fastlanes': {
      // FastLanes blocks of 1024 values, each 1024 * bits / 8 bytes
      const per = (1024 * enc.bits) / 8
      const c0 = Math.floor(s / 1024)
      const c1 = Math.ceil(e / 1024)
      const b = await buf(enc.buffer, c0 * per, c1 * per, ctx.signal)
      const out = typedFor(enc.outBits, (c1 - c0) * 1024)

      for (let c = 0; c < c1 - c0; c++) {
        // the final block may be truncated; pad it so unpacking stays in bounds
        let blk = b.subarray(c * per, (c + 1) * per)

        if (blk.byteLength < per) {
          const padded = new Uint8Array(per)
          padded.set(blk)
          blk = padded
        }

        fastlanesUnpack(blk, enc.outBits, enc.bits, out, c * 1024)
      }

      return { bits: enc.outBits, fixed: out.subarray(s - c0 * 1024, e - c0 * 1024) }
    }

    case 'bitpacked': {
      const from = Math.floor((s * enc.bits) / 8)
      const b = await buf(enc.buffer, from, Math.ceil((e * enc.bits) / 8), ctx.signal)

      return { bits: enc.outBits, fixed: unpackPlain(b, enc.bits, enc.outBits, n, enc.signed, s * enc.bits - from * 8) }
    }

    case 'binary':
      return decodeBinary(enc, s, e, buf, ctx)
    case 'fsst': {
      const inner = await decode20(enc.binary, s, e, buf, ctx)

      if (!inner.offsets || !inner.bytes) corrupt('fsst')

      const block: Block = fsstDecodeAll(inner.offsets, inner.bytes, n, enc.table)

      if (inner.valid) block.valid = inner.valid

      return block
    }

    case 'dict': {
      // index 0 is null, k -> items[k - 1]
      let items = ctx.dictCache.get(enc)

      if (!items) {
        items = decode20(enc.items, 0, enc.size, buf, ctx)
        ctx.dictCache.set(enc, items)
      }

      const [idx, dict] = await Promise.all([decode20(enc.indices, s, e, buf, ctx), items])

      if (!idx.fixed) corrupt('dictionary')

      return { dictIndices: idx.fixed, items: dict }
    }

    case 'fsb': {
      const inner = await decode20(enc.bytes, s * enc.width, e * enc.width, buf, ctx)

      if (!inner.fixed) corrupt('fixed-size binary')

      return { bits: enc.width * 8, fixed: inner.fixed }
    }

    case 'packedstruct':
      return decodePackedStruct(enc, s, e, buf, ctx.signal)
    case 'constant':
      return { constant: enc.value }
    case 'list':
    case 'unsupported':
      return unsupported(`the Lance 2.0 encoding ${enc.kind === 'unsupported' ? enc.name : enc.kind}`)
    default: {
      const unknownKind: never = enc

      return corrupt(`encoding ${String(unknownKind)}`)
    }
  }
}

function sliceFixed(b: Uint8Array, bits: number, s: number, n: number): Block {
  if (bits === 1) return { bits, fixed: unpackBits(b, n, s) }

  const w = bits / 8

  if (bits % 8 || bits > 64 || ![8, 16, 32, 64].includes(bits)) return { bits, fixed: b.subarray(s * w, (s + n) * w) }

  return { bits, fixed: words(b.subarray(s * w), bits, n) }
}

type BinaryEnc = Extract<Enc20, { kind: 'binary' }>

async function decodeBinary(enc: BinaryEnc, s: number, e: number, buf: BufferReader, ctx: DecodeContext): Promise<Block> {
  // indices hold cumulative end offsets; values >= nullAdjust mark nulls (offset = v - nullAdjust)
  const n = e - s
  const idx = await decode20(enc.indices, Math.max(0, s - 1), e, buf, ctx)

  if (!idx.fixed) corrupt('binary')

  const raw = idx.fixed
  const adj = enc.nullAdjust
  const norm = (v: number): number => (adj && v >= adj ? v - adj : v)
  const valid = new Uint8Array(n)
  const offsets = new Float64Array(n + 1)
  const base = s === 0 ? 0 : norm(Number(raw[0]))
  const k0 = s === 0 ? 0 : 1

  for (let i = 0; i < n; i++) {
    const v = Number(raw[k0 + i])
    valid[i] = adj && v >= adj ? 0 : 1
    offsets[i + 1] = norm(v) - base
  }

  const end = offsets[n] + base
  const block: Block = { offsets, bytes: new Uint8Array(0) }

  if (adj) block.valid = valid

  const bytesEnc = enc.bytes

  if (end - base > ctx.maxInlineBytes && bytesEnc.kind === 'flat' && !bytesEnc.compression) {
    // values over the limit become lazy handles; fetch only the rest
    const lazy = new Map<number, LazyValue>()

    const parts = await Promise.all(
      Array.from({ length: n }, (_, i) => {
        const a = base + offsets[i]
        const b = base + offsets[i + 1]

        if (b - a <= ctx.maxInlineBytes) return b > a ? buf(bytesEnc.buffer, a, b, ctx.signal) : new Uint8Array(0)

        lazy.set(i, { byteLength: b - a, read: (signal) => buf(bytesEnc.buffer, a, b, signal) })

        return new Uint8Array(0)
      }),
    )

    const total = parts.reduce((t, p) => t + p.length, 0)
    const bytes = new Uint8Array(total)
    let o = 0

    parts.forEach((p, i) => {
      offsets[i] = o
      bytes.set(p, o)
      o += p.length
    })
    offsets[n] = o
    block.bytes = bytes
    block.lazy = lazy

    return block
  }

  if (end > base) {
    const inner = await decode20(bytesEnc, base, end, buf, ctx)

    if (!inner.fixed) corrupt('binary')
    block.bytes = asBytes(inner.fixed)
  }

  return block
}

type PackedStructEnc = Extract<Enc20, { kind: 'packedstruct' }>

async function decodePackedStruct(enc: PackedStructEnc, s: number, e: number, buf: BufferReader, signal: AbortSignal | undefined): Promise<Block> {
  // row-major: every row stores each fixed-width child back to back
  const n = e - s

  const widths = enc.inner.map((child) => {
    let x = child

    while (x.kind === 'nullable') x = x.values // children are wrapped as non-null

    if (x.kind !== 'flat' || x.bits % 8) unsupported(`packed struct children of ${x.kind}`)

    return x.bits / 8
  })

  const stride = widths.reduce((a, b) => a + b, 0)
  const b = await buf(enc.buffer, s * stride, e * stride, signal)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const children: PackedChild[] = widths.map(() => new Array(n))

  for (let i = 0; i < n; i++) {
    let o = i * stride

    widths.forEach((w, k) => {
      children[k][i] =
        w === 8 ? dv.getBigUint64(o, true) : w === 4 ? dv.getUint32(o, true) : w === 2 ? dv.getUint16(o, true) : w === 1 ? b[o] : b.slice(o, o + w)
      o += w
    })
  }

  return { packed: children }
}

/** whether decoding an encoding needs zstd, so the decoder can be loaded before decoding starts */
export function arrayEncodingUsesZstd(e: Enc20): boolean {
  switch (e.kind) {
    case 'flat':
      return e.compression === 'zstd'
    case 'nullable':
      return arrayEncodingUsesZstd(e.values) || (!!e.validity && arrayEncodingUsesZstd(e.validity))
    case 'fsl':
      return arrayEncodingUsesZstd(e.items)
    case 'list':
      return arrayEncodingUsesZstd(e.offsets)
    case 'binary':
      return arrayEncodingUsesZstd(e.indices) || arrayEncodingUsesZstd(e.bytes)
    case 'dict':
      return arrayEncodingUsesZstd(e.indices) || arrayEncodingUsesZstd(e.items)
    case 'fsst':
      return arrayEncodingUsesZstd(e.binary)
    case 'fsb':
      return arrayEncodingUsesZstd(e.bytes)
    case 'packedstruct':
      return e.inner.some(arrayEncodingUsesZstd)
    case 'allnull':
    case 'bitpacked':
    case 'fastlanes':
    case 'constant':
    case 'unsupported':
      return false
  }
}
