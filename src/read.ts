// Reading rows: fragments -> fields -> columns -> pages.
import { toNumbers } from './codecs.ts'
import { converter } from './convert.ts'
import { deletedRows, fileMeta, stateOf } from './dataset.ts'
import type { LanceDataFile, LanceDataset, LanceField, LanceFragment } from './dataset.ts'
import type { FileMeta, Page } from './file.ts'
import { STRUCT_NULL } from './repdef.ts'
import { decode20 } from './v20.ts'
import type { BufferReader } from './v20.ts'
import { readPage21 } from './v21.ts'
import type { PageIO } from './v21.ts'
import type { Block, Convert, DecodeContext, LazyValue, Row, Value } from './types.ts'

export interface LanceReadOptions {
  /** top-level columns to read; defaults to all */
  columns?: string[]
  /** first row (deleted rows don't count); defaults to 0 */
  offset?: number
  /** number of rows; defaults to the rest of the dataset */
  limit?: number
  /** binary values larger than this come back as LazyValue handles instead of bytes */
  maxInlineBytes?: number
  signal?: AbortSignal
  /** called with each fragment's rows as soon as they are decoded */
  onChunk?: (chunk: { offset: number; rows: Row[] }) => void
}

/** Read rows of the selected columns. */
export async function lanceRead(ds: LanceDataset, options: LanceReadOptions = {}): Promise<Row[]> {
  const fields = options.columns ? options.columns.map((c) => columnField(ds, c)) : ds.schema

  const ctx: DecodeContext = {
    zstd: stateOf(ds).decompressors.zstd,
    maxInlineBytes: options.maxInlineBytes ?? Infinity,
    wholePageBytes: 256 * 1024,
    dictCache: new WeakMap(),
    signal: options.signal,
  }

  const rowStart = Math.max(0, options.offset ?? 0)
  const rowEnd = Math.min(ds.numRows, options.limit === undefined ? ds.numRows : rowStart + Math.max(0, options.limit))
  const tasks: Promise<Row[]>[] = []
  let at = 0

  for (const frag of ds.fragments) {
    const fs = at
    const fe = at + frag.rows
    at = fe

    if (fe <= rowStart || fs >= rowEnd || !frag.rows) continue

    const offset = Math.max(rowStart, fs)

    tasks.push(
      readFragment(ds, frag, fields, offset - fs, Math.min(rowEnd, fe) - fs, ctx).then((rows) => {
        options.onChunk?.({ offset, rows })

        return rows
      }),
    )
  }

  options.signal?.throwIfAborted()

  return (await Promise.all(tasks)).flat()
}

function columnField(ds: LanceDataset, name: string): LanceField {
  const f = ds.schema.find((x) => x.name === name)

  if (!f) throw new Error(`no column "${name}" (columns: ${ds.schema.map((x) => x.name).join(', ')})`)

  return f
}

async function readFragment(ds: LanceDataset, frag: LanceFragment, fields: readonly LanceField[], a: number, b: number, ctx: DecodeContext): Promise<Row[]> {
  // map logical rows [a, b) to physical rows, skipping deleted ones
  const deleted = await deletedRows(ds, frag, ctx)
  let keep: number[] | null = null
  let ps = a
  let pe = b

  if (deleted.length) {
    const phys: number[] = []
    let d = 0

    for (let p = 0, logical = 0; p < frag.physicalRows && logical < b; p++) {
      while (d < deleted.length && deleted[d] < p) d++

      if (d < deleted.length && deleted[d] === p) continue

      if (logical >= a) phys.push(p)
      logical++
    }

    ps = phys[0]
    pe = phys[phys.length - 1] + 1
    keep = phys.map((p) => p - ps)
  }

  const cols = await Promise.all(fields.map((f) => readField(ds, frag, f, ps, pe, ctx, 0)))
  const n = keep ? keep.length : pe - ps
  const rows = new Array<Row>(n)

  for (let i = 0; i < n; i++) {
    const r: Row = {}
    const src = keep ? keep[i] : i

    fields.forEach((f, k) => {
      r[f.name] = cols[k][src]
    })
    rows[i] = r
  }

  return rows
}

function locate(frag: LanceFragment, field: LanceField): { file: LanceDataFile; column: number } | null {
  for (const file of frag.files) {
    const i = file.fields.indexOf(field.id)

    if (i >= 0) return { file, column: file.columns[i] }
  }

  return null
}

const isList = (t: string): boolean => t.startsWith('list') || t.startsWith('large_list')

async function readField(ds: LanceDataset, frag: LanceFragment, field: LanceField, s: number, e: number, ctx: DecodeContext, depth: number): Promise<Value[]> {
  if (field.type === 'struct') {
    const children = await Promise.all(field.children.map((c) => readField(ds, frag, c, s, e, ctx, depth)))

    return zipStruct(
      field.children.map((c) => c.name),
      children,
      depth,
    )
  }

  const loc = locate(frag, field)

  if (isList(field.type)) {
    const meta = loc && loc.column >= 0 ? await fileMeta(ds, loc.file, ctx) : null
    const item = field.children[0]

    if (!item) throw new Error(`list column "${field.name}" has no item field`)

    if (meta && loc && !meta.v21) return readList20(ds, frag, item, meta, loc.column, s, e, ctx)

    // 2.1+: the leaf columns carry repetition levels, so the item reader returns nested arrays
    return readField(ds, frag, item, s, e, ctx, depth + 1)
  }

  // a column missing from this fragment was added later (schema evolution)
  if (!loc || loc.column < 0) return new Array<Value>(e - s).fill(null)

  return readColumn(ds, await fileMeta(ds, loc.file, ctx), loc.column, s, e, converter(field.type), ctx)
}

function zipStruct(names: string[], children: Value[][], depth: number): Value[] {
  if (depth > 0) {
    // one level of list per depth: zip each row's lists element by element
    return children[0].map((v, i) => {
      if (!Array.isArray(v)) return v

      const lists: Value[][] = children.map((c) => {
        const x = c[i]

        return Array.isArray(x) ? x : []
      })

      return zipStruct(names, lists, depth - 1)
    })
  }

  const n = children[0]?.length ?? 0
  const out = new Array<Value>(n)

  for (let i = 0; i < n; i++) {
    if (children.some((c) => c[i] === STRUCT_NULL)) {
      out[i] = null
      continue
    }

    const o: { [field: string]: Value } = {}

    names.forEach((name, k) => {
      o[name] = children[k][i]
    })
    out[i] = o
  }

  return out
}

function pageIO(ds: LanceDataset, path: string): PageIO {
  const source = stateOf(ds).source

  return { readMany: (ranges, signal) => Promise.all(ranges.map(([o, l]) => source.read(path, o, l, signal))) }
}

async function readColumn(ds: LanceDataset, meta: FileMeta, column: number, s: number, e: number, convert: Convert, ctx: DecodeContext): Promise<Value[]> {
  const col = meta.columns[column]
  const io = pageIO(ds, meta.path)
  const parts: Promise<Value[]>[] = []

  for (const page of col.pages) {
    const ps = page.rowStart
    const pe = ps + page.rows

    if (pe <= s || ps >= e || !page.rows) continue

    const ls = Math.max(s, ps) - ps
    const le = Math.min(e, pe) - ps
    const enc = page.encoding

    if (enc.v === 21) parts.push(readPage21(page, enc.layout, ls, le, io, ctx, convert))
    else if (enc.v === 20) parts.push(decode20(enc.enc, ls, le, bufferReader(ds, meta, column, page), ctx).then((b) => blockToValues(b, le - ls, convert)))
    else parts.push(Promise.resolve(new Array<Value>(le - ls).fill(null)))
  }

  const res = await Promise.all(parts)

  return res.length === 1 ? res[0] : res.flat()
}

function bufferReader(ds: LanceDataset, meta: FileMeta, column: number, page: Page): BufferReader {
  const source = stateOf(ds).source
  const col = meta.columns[column]

  return (ref, from, to, signal) => {
    const [off, size] =
      ref.type === 0 ? [page.offsets[ref.index], page.sizes[ref.index]] : ref.type === 1 ? col.buffers[ref.index] : meta.globalBuffers[ref.index]

    const end = Math.min(to, size)

    return source.read(meta.path, off + from, end - from, signal)
  }
}

function blockToValues(block: Block, n: number, convert: Convert): Value[] {
  if (block.allNull) return new Array<Value>(n).fill(null)

  if (block.packed) {
    // 2.0 blob columns store (position, size) descriptors; values live elsewhere in the file
    const [pos, size] = block.packed

    return pos.map((p, i) => ({ position: Number(p), size: Number(size[i]) }))
  }

  let vals: Value[]

  if (block.dictIndices && block.items) {
    const items = block.items
    const count = items.offsets ? items.offsets.length - 1 : (items.fixed?.length ?? 0)
    const decoded = blockToValues(items, count, convert)

    vals = toNumbers(block.dictIndices).map((k) => (k === 0 ? null : decoded[k - 1]))
  } else {
    vals = convert(block, n)
  }

  if (block.lazy) {
    block.lazy.forEach((v: LazyValue, i) => {
      vals[i] = v
    })
  }

  if (block.valid) for (let i = 0; i < n; i++) if (!block.valid[i]) vals[i] = null

  return vals
}

async function readList20(
  ds: LanceDataset,
  frag: LanceFragment,
  item: LanceField,
  meta: FileMeta,
  column: number,
  s: number,
  e: number,
  ctx: DecodeContext,
): Promise<Value[]> {
  // per page: cumulative end offsets into the item column; values >= nullAdjust mean null
  const col = meta.columns[column]
  const lists: { valid: boolean; start: number; end: number }[] = []
  let itemBase = 0

  for (const page of col.pages) {
    const ps = page.rowStart
    const pe = ps + page.rows
    const enc = page.encoding

    if (enc.v !== 20 || enc.enc.kind !== 'list') throw new Error('expected a Lance 2.0 list page')

    const list = enc.enc

    if (pe > s && ps < e) {
      const ls = Math.max(s, ps) - ps
      const le = Math.min(e, pe) - ps
      const block = await decode20(list.offsets, Math.max(0, ls - 1), le, bufferReader(ds, meta, column, page), ctx)

      if (!block.fixed) throw new Error('list page has no offsets')

      const raw = toNumbers(block.fixed)
      const adj = list.nullAdjust
      const norm = (v: number): number => (adj ? v % adj : v)
      let prev = ls === 0 ? 0 : norm(raw[0])

      for (let i = ls === 0 ? 0 : 1; i < raw.length; i++) {
        const end = norm(raw[i])
        lists.push({ valid: !adj || raw[i] < adj, start: itemBase + prev, end: itemBase + end })
        prev = end
      }
    }

    itemBase += list.numItems

    if (ps >= e) break
  }

  if (!lists.length) return []

  const lo = Math.min(...lists.map((l) => l.start))
  const hi = Math.max(...lists.map((l) => l.end))
  const items = hi > lo ? await readField(ds, frag, item, lo, hi, ctx, 0) : []

  return lists.map((l) => (l.valid ? items.slice(l.start - lo, l.end - lo) : null))
}
