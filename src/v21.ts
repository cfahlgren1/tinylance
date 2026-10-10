// Lance file format 2.1 / 2.2 pages: structural layouts (mini-block, full-zip, constant, blob)
// over compressive encodings. Spec: protos/encodings_v2_1.proto in lance-format/lance.
import {
  align8,
  asBytes,
  byteStreamSplit,
  decompress,
  fastlanesUnpack,
  fsstDecodeAll,
  fsstTable,
  readUint,
  rle,
  toNumbers,
  typedFor,
  unpackBits,
  words,
} from './codecs.ts'
import type { Compression, FsstTable } from './codecs.ts'
import { bytes, decode, has, msg, num, oneofTag, packed } from './proto.ts'
import type { Proto } from './proto.ts'
import { unravel } from './repdef.ts'
import type { Layer } from './repdef.ts'
import type { Block, Convert, DecodeContext, LazyValue, PackedChild, Value } from './types.ts'

export type Enc21 =
  | { kind: 'flat'; bits: number; compression: Compression | undefined }
  | { kind: 'variable'; offsets: Enc21; compression: Compression | undefined }
  | { kind: 'constant'; value: Uint8Array | undefined }
  | { kind: 'ool'; bits: number; values: Enc21 }
  | { kind: 'bitpack'; bits: number; compression: Compression | undefined }
  | { kind: 'fsst'; table: FsstTable; values: Enc21 }
  | { kind: 'dict'; indices: Enc21; items: Enc21; size: number }
  | { kind: 'rle'; values: Enc21; lengths: Enc21 }
  | { kind: 'bss'; values: Enc21 }
  | { kind: 'general'; scheme: Compression; values: Enc21 }
  | { kind: 'fsl'; dim: number; validity: boolean; values: Enc21 }
  | { kind: 'packedstruct'; bits: number[]; values: Enc21 }
  | { kind: 'unsupported'; name: string }

const UNSUPPORTED = new Map([
  [13, 'variable packed struct'],
  [14, 'range'],
  [15, 'delta'],
])

const SCHEMES = new Map<number, Compression>([
  [1, 'lz4'],
  [2, 'zstd'],
])

function scheme(m: Proto | undefined): Compression {
  const s = m ? SCHEMES.get(num(m, 1)) : undefined

  if (!s) throw new Error(`unsupported compression scheme ${m ? num(m, 1) : 'none'}`)

  return s
}

function bufferCompression(m: Proto, k: number): Compression | undefined {
  return has(m, k) ? scheme(msg(m, k)) : undefined
}

function child(m: Proto, k: number): Enc21 {
  const b = bytes(m, k)

  if (!b) throw new Error(`Lance 2.1 encoding is missing field ${k}`)

  return parseEncoding(b)
}

export function parseEncoding(raw: Uint8Array): Enc21 {
  const e = decode(raw)
  const tag = oneofTag(e)
  const m = msg(e, tag)

  if (!m) throw new Error(`Lance 2.1 encoding ${tag} is empty`)

  switch (tag) {
    case 1:
      return { kind: 'flat', bits: num(m, 1), compression: bufferCompression(m, 2) }
    case 2:
      return { kind: 'variable', offsets: child(m, 1), compression: bufferCompression(m, 2) }
    case 3:
      return { kind: 'constant', value: bytes(m, 1) }
    case 4:
      return { kind: 'ool', bits: num(m, 1), values: child(m, 3) }
    case 5:
      return { kind: 'bitpack', bits: num(m, 1), compression: bufferCompression(m, 2) }
    case 6: {
      const table = bytes(m, 1)

      if (!table) throw new Error('FSST encoding has no symbol table')

      return { kind: 'fsst', table: fsstTable(table), values: child(m, 2) }
    }

    case 7:
      return { kind: 'dict', indices: child(m, 1), items: child(m, 2), size: num(m, 3) }
    case 8:
      return { kind: 'rle', values: child(m, 1), lengths: child(m, 2) }
    case 9:
      return { kind: 'bss', values: child(m, 1) }
    case 10:
      return { kind: 'general', scheme: scheme(msg(m, 1)), values: child(m, 3) }
    case 11:
      return { kind: 'fsl', dim: num(m, 1), validity: !!num(m, 3), values: child(m, 2) }
    case 12:
      return { kind: 'packedstruct', bits: packed(m, 1), values: child(m, 2) }
    default:
      return { kind: 'unsupported', name: UNSUPPORTED.get(tag) ?? `#${tag}` }
  }
}

/** bits per value of an encoding's decoded output */
function outBits(e: Enc21): number {
  switch (e.kind) {
    case 'flat':
    case 'bitpack':
    case 'ool':
      return e.bits
    case 'rle':
    case 'bss':
    case 'general':
      return outBits(e.values)
    default:
      throw new Error(`no fixed width for ${e.kind}`)
  }
}

interface Cursor {
  i: number
}

function unsupported(e: Enc21): Error {
  return new Error(`unsupported Lance 2.1 encoding "${e.kind === 'unsupported' ? e.name : e.kind}"`)
}

/**
 * Decode one block. `bufs` are the block's buffers (mini-block chunks can carry several), consumed left to right.
 * `pre` is an already-decoded inner block (used for FSST over a dictionary).
 */
function decodeBlock(e: Enc21, bufs: Uint8Array[], n: number, ctx: DecodeContext, cursor: Cursor = { i: 0 }, pre?: Block): Block {
  switch (e.kind) {
    case 'flat': {
      let b = bufs[cursor.i++]

      if (e.compression) b = decompress(e.compression, b, ctx)

      if (e.bits === 1) return { bits: 1, fixed: unpackBits(b, n) }

      if (e.bits % 8 !== 0 || e.bits > 64 || e.bits === 24 || e.bits === 40 || e.bits === 48 || e.bits === 56) return { bits: e.bits, fixed: b } // e.g. fixed-size binary

      return { bits: e.bits, fixed: words(b, e.bits, n) }
    }

    case 'bitpack': {
      // inline FastLanes: per 1024-value block, a t-bit word holding the bit width, then the packed words
      let b = bufs[cursor.i++]

      if (e.compression) b = decompress(e.compression, b, ctx)

      const t = e.bits
      const wordBytes = t / 8
      const blocks = Math.ceil(n / 1024)
      const out = typedFor(t, blocks * 1024)
      let o = 0

      for (let blk = 0; blk < blocks; blk++) {
        const w = readUint(b, o, wordBytes)
        o += wordBytes
        fastlanesUnpack(b.subarray(o), t, w, out, blk * 1024)
        o += (1024 * w) / 8
      }

      return { bits: t, fixed: out.subarray(0, n) }
    }

    case 'ool': {
      // one bit width for every 1024-value block; the last partial block is either packed (padded) or raw
      if (e.values.kind !== 'flat') throw new Error(`out-of-line bitpacking over ${e.values.kind}`)

      let packedBytes = bufs[cursor.i++]

      if (e.values.compression) packedBytes = decompress(e.values.compression, packedBytes, ctx)

      const t = e.bits
      const w = e.values.bits
      const full = Math.floor(n / 1024)
      const tail = n % 1024
      const per = (1024 * w) / 8
      const out = typedFor(t, (full + (tail ? 1 : 0)) * 1024)

      for (let c = 0; c < full; c++) fastlanesUnpack(packedBytes.subarray(c * per), t, w, out, c * 1024)

      if (tail) {
        const rest = packedBytes.subarray(full * per)

        if (rest.byteLength === (tail * t) / 8) setWords(out, words(rest, t, tail), full * 1024)
        else fastlanesUnpack(rest, t, w, out, full * 1024)
      }

      return { bits: t, fixed: out.subarray(0, n) }
    }

    case 'variable': {
      // n + 1 offsets (relative to the start of this buffer), then the bytes
      let b = bufs[cursor.i++]

      if (e.compression) b = decompress(e.compression, b, ctx)

      const offBits = outBits(e.offsets)
      const offs = words(b, offBits, n + 1)

      return { offsets: offs instanceof BigUint64Array ? Array.from(offs, Number) : offs, bytes: b }
    }

    case 'fsst': {
      const inner = pre ?? decodeBlock(e.values, bufs, n, ctx, cursor)

      if (!inner.offsets || !inner.bytes) throw new Error('FSST block has no strings')

      return fsstDecodeAll(inner.offsets, inner.bytes, n, e.table)
    }

    case 'general': {
      // the child sees decompressed buffers
      const sub = bufs.slice(cursor.i).map((b) => decompress(e.scheme, b, ctx))
      const c = { i: 0 }
      const res = decodeBlock(e.values, sub, n, ctx, c)
      cursor.i += c.i

      return res
    }

    case 'bss': {
      const bits = outBits(e.values)

      return decodeBlock(e.values, [byteStreamSplit(bufs[cursor.i++], bits / 8, n)], n, ctx)
    }

    case 'rle': {
      // values and run lengths are two buffers, each with its own count
      let vb = bufs[cursor.i++]
      let lb = bufs[cursor.i++]

      if (!lb) {
        // block form (levels, dictionaries): [u64 values size][values][run lengths]
        const size = readUint(vb, 0, 8)
        lb = vb.subarray(8 + size)
        vb = vb.subarray(8, 8 + size)
      }

      const vbits = outBits(e.values)
      const values = decodeBlock(e.values, [vb], (vb.byteLength * 8) / vbits, ctx).fixed
      const lengths = decodeBlock(e.lengths, [lb], (lb.byteLength * 8) / outBits(e.lengths), ctx).fixed

      if (!values || !lengths) throw new Error('RLE block has no values')

      return { bits: vbits, fixed: rle(values, lengths, n) }
    }

    case 'fsl': {
      // with item nulls, a validity bitmap for the n * dim items comes before the values
      const valid = e.validity ? unpackBits(bufs[cursor.i++], n * e.dim) : undefined
      const inner = decodeBlock(e.values, bufs, n * e.dim, ctx, cursor)

      if (valid && inner.itemValid) throw new Error('nested fixed-size lists with nulls at several levels are not supported')

      const block: Block = { ...inner, dim: e.dim * (inner.dim ?? 1) }

      if (valid) block.itemValid = valid

      return block
    }

    case 'packedstruct': {
      // each row stores its fixed-width children back to back
      const inner = decodeBlock(e.values, bufs, n, ctx, cursor)

      if (!inner.fixed) throw new Error('packed struct block has no bytes')

      const b = asBytes(inner.fixed)
      const widths = e.bits.map((x) => x / 8)
      const stride = widths.reduce((a, x) => a + x, 0)
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
      const children: PackedChild[] = widths.map(() => new Array(n))

      for (let i = 0; i < n; i++) {
        let o = i * stride

        widths.forEach((w, k) => {
          children[k][i] =
            w === 8 ? Number(dv.getBigUint64(o, true)) : w === 4 ? dv.getUint32(o, true) : w === 2 ? dv.getUint16(o, true) : w === 1 ? b[o] : b.slice(o, o + w)
          o += w
        })
      }

      return { packed: children }
    }

    case 'constant':
      return e.value ? { constant: e.value } : { allNull: true }
    case 'dict':
    case 'unsupported':
      throw unsupported(e)
    default: {
      const never: never = e

      throw new Error(`unknown Lance 2.1 encoding ${JSON.stringify(never)}`)
    }
  }
}

function setWords(out: ReturnType<typeof typedFor>, src: ReturnType<typeof words>, at: number): void {
  if (out instanceof BigUint64Array) {
    for (let i = 0; i < src.length; i++) out[at + i] = BigInt(src[i])

    return
  }

  for (let i = 0; i < src.length; i++) out[at + i] = Number(src[i])
}

/** dictionary page buffers are one block */
function decodeDictionary(buf: Uint8Array, e: Enc21, n: number, ctx: DecodeContext): Block {
  if (e.kind === 'general') return decodeDictionary(decompress(e.scheme, buf, ctx), e.values, n, ctx)

  if (e.kind === 'variable') {
    // [bits per offset][bytes start][offsets...][bytes...], header words of the offset width
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const bits = dv.getUint32(0, true)
    const start = bits === 64 ? readUint(buf, 8, 8) : dv.getUint32(4, true)
    const offs = words(buf.subarray(bits / 4), bits, n + 1)

    return { offsets: offs instanceof BigUint64Array ? Array.from(offs, Number) : offs, bytes: buf.subarray(start) }
  }

  if (e.kind === 'fsst') return decodeBlock(e, [], n, ctx, { i: 0 }, decodeDictionary(buf, e.values, n, ctx))

  return decodeBlock(e, [buf], n, ctx)
}

function decodeLevels(e: Enc21, buf: Uint8Array, n: number, ctx: DecodeContext): Uint16Array {
  const block = decodeBlock(e, [buf], n, ctx)

  if (!block.fixed) return new Uint16Array(n)

  const f = block.fixed

  return f instanceof Uint16Array ? f : Uint16Array.from(toNumbers(f))
}

// ---- page layouts ----

const LAYERS = new Map<number, Layer>([
  [1, 'item'],
  [2, 'list'],
  [3, 'nullitem'],
  [4, 'nulllist'],
  [5, 'emptylist'],
  [6, 'nullemptylist'],
])

export type Layout =
  | {
      kind: 'miniblock'
      rep: Enc21 | undefined
      def: Enc21 | undefined
      value: Enc21
      dictionary: Enc21 | undefined
      dictionarySize: number
      layers: Layer[]
      numBuffers: number
      repIndexDepth: number
      numItems: number
      largeChunk: boolean
    }
  | { kind: 'constant'; layers: Layer[]; value: Uint8Array | undefined; rep: Enc21 | undefined; def: Enc21 | undefined; numRep: number; numDef: number }
  | {
      kind: 'fullzip'
      bitsRep: number
      bitsDef: number
      bitsPerValue: number | undefined
      bitsPerOffset: number | undefined
      numItems: number
      value: Enc21
      layers: Layer[]
    }
  | { kind: 'blob'; inner: Layout }
  | { kind: 'unsupported'; name: string }

function layers(m: Proto, k: number): Layer[] {
  const out: Layer[] = []

  for (const v of packed(m, k)) {
    const layer = LAYERS.get(v)

    if (!layer) throw new Error(`unknown repetition/definition layer ${v}`)
    out.push(layer)
  }

  return out
}

function optionalEncoding(m: Proto, k: number): Enc21 | undefined {
  const b = bytes(m, k)

  return b ? parseEncoding(b) : undefined
}

export function parseLayout(raw: Uint8Array): Layout {
  const l = decode(raw)
  const mini = msg(l, 1)

  if (mini) {
    return {
      kind: 'miniblock',
      rep: optionalEncoding(mini, 1),
      def: optionalEncoding(mini, 2),
      value: child(mini, 3),
      dictionary: optionalEncoding(mini, 4),
      dictionarySize: num(mini, 5),
      layers: layers(mini, 6),
      numBuffers: num(mini, 7) || 1,
      repIndexDepth: num(mini, 8),
      numItems: num(mini, 9),
      largeChunk: !!num(mini, 10),
    }
  }

  const constant = msg(l, 2)

  if (constant) {
    return {
      kind: 'constant',
      layers: layers(constant, 5),
      value: bytes(constant, 6),
      rep: optionalEncoding(constant, 7),
      def: optionalEncoding(constant, 8),
      numRep: num(constant, 9),
      numDef: num(constant, 10),
    }
  }

  const fullzip = msg(l, 3)

  if (fullzip) {
    return {
      kind: 'fullzip',
      bitsRep: num(fullzip, 1),
      bitsDef: num(fullzip, 2),
      bitsPerValue: has(fullzip, 3) ? num(fullzip, 3) : undefined,
      bitsPerOffset: has(fullzip, 4) ? num(fullzip, 4) : undefined,
      numItems: num(fullzip, 5),
      value: child(fullzip, 7),
      layers: layers(fullzip, 8),
    }
  }

  const blob = msg(l, 4)
  const inner = blob && bytes(blob, 1)

  if (inner) return { kind: 'blob', inner: parseLayout(inner) }

  return { kind: 'unsupported', name: has(l, 5) ? 'sparse' : 'unknown' }
}

export interface PageRef {
  offsets: number[]
  sizes: number[]
  rows: number
}

export interface PageIO {
  readMany(ranges: [number, number][], signal?: AbortSignal): Promise<Uint8Array[]>
}

/** Read rows [start, end) of one page as JS values, nulls applied. */
export function readPage21(page: PageRef, layout: Layout, start: number, end: number, io: PageIO, ctx: DecodeContext, convert: Convert): Promise<Value[]> {
  switch (layout.kind) {
    case 'miniblock':
      return readMiniBlock(page, layout, start, end, io, ctx, convert)
    case 'fullzip':
      return readFullZip(page, layout, start, end, io, ctx, convert)
    case 'constant':
      return readConstant(page, layout, start, end, io, ctx, convert)
    case 'blob':
      // large binaries stored out of line: the page holds (position, size) descriptors
      if (layout.inner.kind === 'miniblock') return readMiniBlock(page, layout.inner, start, end, io, ctx, (block, n) => blobValues(block, n, io))

      throw new Error(`unsupported blob layout over ${layout.inner.kind}`)
    case 'unsupported':
      throw new Error(`unsupported page layout "${layout.name}"`)
    default: {
      const never: never = layout

      throw new Error(`unknown page layout ${JSON.stringify(never)}`)
    }
  }
}

type ConstantLayout = Extract<Layout, { kind: 'constant' }>

async function readConstant(page: PageRef, l: ConstantLayout, start: number, end: number, io: PageIO, ctx: DecodeContext, convert: Convert): Promise<Value[]> {
  // buffers: [] or [rep, def] with an inline value; [value] or [value, rep, def] with a value buffer.
  // A page with no value at all is all null.
  const n = end - start
  const nb = page.sizes.length
  const hasValueBuffer = !l.value && (nb === 1 || nb === 3)
  const hasList = l.layers.some((x) => x.includes('list'))

  if (!hasList && !l.def && !l.rep && (nb === 2 || nb === 3)) {
    // a flat page with raw u16 def levels: fetch only the levels for [start, end)
    const d = nb - 1
    const ranges: [number, number][] = [[page.offsets[d] + start * 2, n * 2]]

    if (hasValueBuffer) ranges.push([page.offsets[0], page.sizes[0]])

    const [defs, vb] = await io.readMany(ranges, ctx.signal)
    const value = l.value ? convert({ constant: l.value }, 1)[0] : vb ? convert(scalarFromValueBuffer(vb), 1)[0] : null
    const def = page.sizes[d] ? words(defs, 16, n) : new Uint16Array(n)

    return toNumbers(def).map((x) => (x ? null : value))
  }

  const bufs = nb
    ? await io.readMany(
        page.offsets.map((o, i): [number, number] => [o, page.sizes[i]]),
        ctx.signal,
      )
    : []

  let scalar: Block | null = null

  if (l.value) scalar = { constant: l.value }
  else if (hasValueBuffer) scalar = scalarFromValueBuffer(bufs[0])

  const repdef = hasValueBuffer ? bufs.slice(1) : bufs
  const value = scalar ? convert(scalar, 1)[0] : null

  if (!repdef.length || repdef.every((b) => !b.byteLength)) return new Array<Value>(n).fill(value)

  const levels = (enc: Enc21 | undefined, b: Uint8Array): Uint16Array => {
    if (enc) return decodeLevels(enc, b, l.numRep || l.numDef || b.byteLength / 2, ctx)

    const w = words(b, 16, b.byteLength / 2)

    return w instanceof Uint16Array ? w : Uint16Array.from(toNumbers(w))
  }

  const rep = hasList && repdef[0].byteLength ? levels(l.rep, repdef[0]) : null
  const def = repdef[1]?.byteLength ? levels(l.def, repdef[1]) : !hasList && repdef[0].byteLength ? levels(l.def, repdef[0]) : null
  const count = (rep ?? def)?.length ?? 0

  return unravel(new Array<Value>(count).fill(value), rep, def, l.layers).slice(start, end)
}

/** Arrow buffers of a length-1 array: [u32 count][u32 len]*count[bytes]* */
function scalarFromValueBuffer(b: Uint8Array): Block {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const count = dv.getUint32(0, true)
  const parts: Uint8Array[] = []
  let o = 4 + count * 4

  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(4 + i * 4, true)
    parts.push(b.subarray(o, o + len))
    o += len
  }

  if (count === 2) {
    // offsets and data (string / binary); offsets may be 32 or 64 bit
    const offs = words(parts[0], parts[0].byteLength === 16 ? 64 : 32, 2)

    return { offsets: [Number(offs[0]), Number(offs[1])], bytes: parts[1] }
  }

  return { constant: parts[0] }
}

type MiniBlockLayout = Extract<Layout, { kind: 'miniblock' }>

interface Chunk {
  byte: number
  bytes: number
  item: number
  items: number
}

async function readMiniBlock(
  page: PageRef,
  l: MiniBlockLayout,
  start: number,
  end: number,
  io: PageIO,
  ctx: DecodeContext,
  convert: Convert,
): Promise<Value[]> {
  // buffer 0: chunk metadata (u16 or u32 words), 1: chunk data, then the dictionary, then the repetition index
  const [metaOff, dataOff] = page.offsets
  const [metaLen, dataLen] = page.sizes
  const hasDict = !!l.dictionary
  const hasRepIndex = l.repIndexDepth > 0
  // small pages: fetch every buffer at once instead of metadata first and then the chunks
  const whole = page.sizes.reduce((a, b) => a + b, 0) <= ctx.wholePageBytes
  const reads: [number, number][] = [[metaOff, metaLen]]

  if (hasDict) reads.push([page.offsets[2], page.sizes[2]])

  if (hasRepIndex) reads.push([page.offsets[page.offsets.length - 1], page.sizes[page.sizes.length - 1]])

  if (whole) reads.push([dataOff, dataLen])

  const fetched = await io.readMany(reads, ctx.signal)
  const meta = fetched[0]
  const dictBuf = hasDict ? fetched[1] : undefined
  const repIndex = hasRepIndex ? fetched[hasDict ? 2 : 1] : undefined
  const wholeData = whole ? fetched[fetched.length - 1] : undefined
  const wordBytes = l.largeChunk ? 4 : 2
  const nChunks = meta.byteLength / wordBytes
  const mdv = new DataView(meta.buffer, meta.byteOffset, meta.byteLength)
  const hasRep = !!l.rep
  const totalItems = hasRep ? l.numItems : page.rows
  const chunks: Chunk[] = []
  let byte = 0
  let item = 0

  for (let w = 0; w < nChunks; w++) {
    const word = l.largeChunk ? mdv.getUint32(w * 4, true) : mdv.getUint16(w * 2, true)
    const size = ((word >>> 4) + 1) * 8
    const log = word & 0xf
    const items = log === 0 ? totalItems - item : 2 ** log

    chunks.push({ byte, bytes: size, item, items })
    byte += size
    item += items
  }

  // without repetition an item is a row, so only the chunks covering [start, end) are needed
  let first = 0
  let last = chunks.length - 1
  let rowBase = 0

  if (!hasRep) {
    while (first < last && chunks[first].item + chunks[first].items <= start) first++

    while (last > first && chunks[last].item >= end) last--
    rowBase = chunks[first].item
  } else if (repIndex) {
    // per chunk, (depth + 1) u64s: [0] = rows ending in the chunk, [1] = items of a trailing partial row
    const stride = (l.repIndexDepth + 1) * 8
    const rowStarts = [0]
    const ends: number[] = []
    const trailer: boolean[] = []

    for (let c = 0; c < nChunks; c++) {
      ends.push(readUint(repIndex, c * stride, 8))
      trailer.push(readUint(repIndex, c * stride + 8, 8) > 0)
      rowStarts.push(rowStarts[c] + ends[c] + (trailer[c] ? 1 : 0) - (c && trailer[c - 1] ? 1 : 0))
    }

    // first: the chunk where row `start` begins; last: the chunk where row `end - 1` finishes
    while (first < last && rowStarts[first + 1] <= start) first++
    last = first

    while (last < nChunks - 1 && rowStarts[last + 1] < end) last++

    while (last < nChunks - 1 && trailer[last] && rowStarts[last + 1] === end) {
      last++ // the final row spills into the next chunk(s)

      if (ends[last] > 0) break
    }

    rowBase = rowStarts[first]
  }

  const from = chunks[first].byte
  const to = chunks[last].byte + chunks[last].bytes
  const data = wholeData ? wholeData.subarray(from, to) : (await io.readMany([[dataOff + from, to - from]], ctx.signal))[0]
  const dict = l.dictionary && dictBuf ? decodeDictionary(dictBuf, l.dictionary, l.dictionarySize, ctx) : null
  const values: Value[][] = []
  const defs: Uint16Array[] = []
  const reps: Uint16Array[] = []

  for (let c = first; c <= last; c++) {
    const ch = chunks[c]
    const buf = data.subarray(ch.byte - from, ch.byte - from + ch.bytes)
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let o = 0
    const numLevels = dv.getUint16(o, true)
    o += 2

    let repSize = 0
    let defSize = 0

    if (l.rep) {
      repSize = dv.getUint16(o, true)
      o += 2
    }

    if (l.def) {
      defSize = dv.getUint16(o, true)
      o += 2
    }

    const sizes: number[] = []

    for (let k = 0; k < l.numBuffers; k++) {
      sizes.push(l.largeChunk ? dv.getUint32(o, true) : dv.getUint16(o, true))
      o += wordBytes
    }

    o = align8(o)

    const levelCount = numLevels || ch.items

    if (l.rep) {
      reps.push(decodeLevels(l.rep, buf.subarray(o, o + repSize), levelCount, ctx))
      o = align8(o + repSize)
    }

    if (l.def) {
      defs.push(decodeLevels(l.def, buf.subarray(o, o + defSize), levelCount, ctx))
      o = align8(o + defSize)
    }

    const bufs = sizes.map((s) => {
      const b = buf.subarray(o, o + s)
      o = align8(o + s)

      return b
    })

    const block = decodeBlock(l.value, bufs, ch.items, ctx)

    values.push(dict ? convertDict(block, dict, convert) : convert(block, ch.items))
  }

  const vals = values.length === 1 ? values[0] : values.flat()
  const rep = reps.length ? concatU16(reps) : null
  const def = defs.length ? concatU16(defs) : null
  let rows: Value[]

  if (rep || (def && l.layers.length > 1)) rows = unravel(vals, rep, def, l.layers)
  else if (def) rows = vals.map((v, i) => (def[i] ? null : v))
  else rows = vals

  return rows.slice(start - rowBase, end - rowBase)
}

function convertDict(block: Block, dict: Block, convert: Convert): Value[] {
  const size = dict.offsets ? dict.offsets.length - 1 : (dict.fixed?.length ?? 0)
  const items = convert(dict, size)
  const idx = block.fixed

  if (!idx) throw new Error('dictionary block has no indices')

  const out = new Array<Value>(idx.length)

  for (let i = 0; i < idx.length; i++) out[i] = items[Number(idx[i])]

  return out
}

function concatU16(parts: Uint16Array[]): Uint16Array {
  const out = new Uint16Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0

  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }

  return out
}

type FullZipLayout = Extract<Layout, { kind: 'fullzip' }>

const controlBytes = (l: FullZipLayout): number => {
  const bits = l.bitsRep + l.bitsDef

  return bits === 0 ? 0 : bits <= 8 ? 1 : bits <= 16 ? 2 : 4
}

async function readFullZip(page: PageRef, l: FullZipLayout, start: number, end: number, io: PageIO, ctx: DecodeContext, convert: Convert): Promise<Value[]> {
  const [dataOff, repIdxOff] = page.offsets
  const repIdxLen = page.sizes[1]
  const hasRep = l.bitsRep > 0
  let from: number
  let to: number

  if (!hasRep && l.bitsPerValue !== undefined) {
    // fixed-width rows: [control][value] per row
    const per = controlBytes(l) + l.bitsPerValue / 8
    from = start * per
    to = end * per
  } else {
    // repetition index: rows + 1 byte positions into the data buffer
    const bytesPer = repIdxLen / (page.rows + 1)
    const [idx] = await io.readMany([[repIdxOff + start * bytesPer, (end - start + 1) * bytesPer]], ctx.signal)
    const at = (i: number): number => readUint(idx, i * bytesPer, bytesPer)

    from = at(0)
    to = at(end - start)

    // big values (videos, archives): fetch the small rows and hand back lazy handles for the big ones
    if (!hasRep && to - from > ctx.maxInlineBytes) return readFullZipLazy(page, l, end - start, at, io, ctx, convert)
  }

  const [data] = await io.readMany([[dataOff + from, to - from]], ctx.signal)

  return readFullZipSpan(l, data, ctx, convert)
}

function readFullZipSpan(l: FullZipLayout, data: Uint8Array, ctx: DecodeContext, convert: Convert): Value[] {
  const ctrlBytes = controlBytes(l)
  const hasRep = l.bitsRep > 0
  const valueBits = l.bitsPerValue
  const mask = (1 << l.bitsDef) - 1
  const maxVisibleDef = maxVisibleDefOf(l.layers)
  const reps: number[] = []
  const defs: number[] = []
  const items: (Uint8Array | null)[] = []
  const lenBytes = (l.bitsPerOffset ?? 0) / 8
  const valueBytes = valueBits !== undefined ? valueBits / 8 : 0
  const perValue = l.value.kind === 'general' ? l.value : null
  let o = 0

  while (o < data.byteLength) {
    const word = readUint(data, o, ctrlBytes)
    o += ctrlBytes

    const rep = l.bitsDef ? Math.floor(word / 2 ** l.bitsDef) : word
    const def = l.bitsDef ? word & mask : 0

    if (hasRep) reps.push(rep)

    if (l.bitsDef) defs.push(def)

    if (def > maxVisibleDef) continue

    if (valueBits !== undefined) {
      items.push(data.subarray(o, o + valueBytes))
      o += valueBytes
    } else if (def === 0) {
      const len = readUint(data, o, lenBytes)
      o += lenBytes

      let v = data.subarray(o, o + len)
      o += len

      if (perValue) v = decompress(perValue.scheme, v, ctx)
      items.push(v)
    } else {
      items.push(null)
    }
  }

  let vals: Value[]

  if (valueBits !== undefined) {
    // a vector with item nulls stores ceil(dim / 8) validity bytes in front of each value
    const fsl = l.value.kind === 'fsl' ? l.value : null
    const dim = fsl?.dim ?? 0
    const validBytes = fsl?.validity ? Math.ceil(dim / 8) : 0
    const dataBytes = valueBytes - validBytes
    const bytes = new Uint8Array(items.length * dataBytes)
    const itemValid = validBytes ? new Uint8Array(items.length * dim) : null

    items.forEach((b, i) => {
      if (!b) return

      bytes.set(b.subarray(validBytes), i * dataBytes)

      if (itemValid) itemValid.set(unpackBits(b, dim), i * dim)
    })

    const elemBits = dim ? (dataBytes * 8) / dim : valueBits
    const fixed = elemBits % 8 === 0 && elemBits <= 64 && elemBits !== 24 ? words(bytes, elemBits) : bytes
    const block: Block = { bits: elemBits, fixed }

    if (dim) block.dim = dim

    if (itemValid) block.itemValid = itemValid

    vals = convert(block, items.length)
  } else {
    // variable width: stitch into offsets and bytes
    const offsets = new Uint32Array(items.length + 1)
    let total = 0

    items.forEach((b, i) => {
      offsets[i] = total
      total += b ? b.length : 0
    })
    offsets[items.length] = total

    const bytes = new Uint8Array(total)

    items.forEach((b, i) => {
      if (b) bytes.set(b, offsets[i])
    })

    const fsst = l.value.kind === 'fsst' ? l.value : perValue?.values.kind === 'fsst' ? perValue.values : null
    const block: Block = fsst ? decodeBlock(fsst, [], items.length, ctx, { i: 0 }, { offsets, bytes }) : { offsets, bytes }

    vals = convert(block, items.length)
  }

  if (!hasRep && !l.bitsDef) return vals

  return unravel(vals, hasRep ? Uint16Array.from(reps) : null, l.bitsDef ? Uint16Array.from(defs) : null, l.layers)
}

/**
 * Blob columns store (position, size) descriptors; the bytes sit at that absolute offset in the
 * same data file. Every blob comes back lazy. A null is stored as size 0 at a non-zero position.
 */
export function blobValues(block: Block, n: number, io: PageIO): Value[] {
  const [pos, size] = block.packed ?? []

  if (!pos || !size) throw new Error('blob page has no descriptors')

  const out = new Array<Value>(n)

  for (let i = 0; i < n; i++) {
    const p = Number(pos[i])
    const s = Number(size[i])
    const lazy: LazyValue = { byteLength: s, read: async (signal) => (s ? (await io.readMany([[p, s]], signal))[0] : new Uint8Array(0)) }

    out[i] = s === 0 && p !== 0 ? null : lazy
  }

  return out
}

async function readFullZipLazy(
  page: PageRef,
  l: FullZipLayout,
  n: number,
  at: (i: number) => number,
  io: PageIO,
  ctx: DecodeContext,
  convert: Convert,
): Promise<Value[]> {
  const dataOff = page.offsets[0]
  // each row is [control][length][value]; sizes below count only the value
  const framing = controlBytes(l) + (l.bitsPerOffset ?? 0) / 8
  const small: number[] = []
  const out = new Array<Value>(n)

  for (let i = 0; i < n; i++) {
    const a = at(i)
    const b = at(i + 1)
    const size = Math.max(0, b - a - framing)

    if (size <= ctx.maxInlineBytes) {
      small.push(i)
      continue
    }

    const lazy: LazyValue = {
      byteLength: size,
      async read(signal) {
        const [buf] = await io.readMany([[dataOff + a, b - a]], signal)
        const [value] = readFullZipSpan(l, buf, ctx, bytesOnly)

        if (!(value instanceof Uint8Array)) throw new Error('lazy value is null')

        return value
      },
    }

    out[i] = lazy
  }

  const bufs = await io.readMany(
    small.map((i): [number, number] => [dataOff + at(i), at(i + 1) - at(i)]),
    ctx.signal,
  )

  small.forEach((i, k) => {
    out[i] = readFullZipSpan(l, bufs[k], ctx, convert)[0]
  })

  return out
}

/** lazy values hand back raw bytes whatever the logical type */
const bytesOnly: Convert = (block, n) => {
  const { offsets, bytes: data } = block

  if (!offsets || !data) throw new Error('lazy value has no bytes')

  return Array.from({ length: n }, (_, i) => data.subarray(Number(offsets[i]), Number(offsets[i + 1])))
}

function maxVisibleDefOf(ls: Layer[]): number {
  // def levels below the first list layer are visible
  let level = 0

  for (const x of ls) {
    if (x.includes('list')) break

    if (x === 'nullitem') level += 1
  }

  return level
}
