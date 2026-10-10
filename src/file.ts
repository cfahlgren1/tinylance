// Data files: 40-byte footer -> column metadata -> pages.
import { corrupt, unsupported } from './errors.ts'
import { decode, msg, num, packed, str, all, bytes } from './proto.ts'
import type { Proto } from './proto.ts'
import type { CachedSource } from './source.ts'
import { arrayEncodingUsesZstd, parseArrayEncoding } from './v20.ts'
import type { Enc20 } from './v20.ts'
import { layoutUsesZstd, parseLayout } from './v21.ts'
import type { Layout } from './v21.ts'

const utf8 = new TextDecoder()

export type PageEncoding = { v: 20; enc: Enc20 } | { v: 21; layout: Layout } | { v: 'none' }

export interface Page {
  offsets: number[]
  sizes: number[]
  rows: number
  rowStart: number
  encoding: PageEncoding
  /** decoding needs zstd */
  zstd: boolean
}

export interface Column {
  pages: Page[]
  /** column-level buffers as [offset, size] */
  buffers: [number, number][]
}

export interface FileMeta {
  path: string
  v21: boolean
  columns: Column[]
  /** file-level buffers as [offset, size] */
  globalBuffers: [number, number][]
}

const u64 = (dv: DataView, o: number): number => Number(dv.getBigUint64(o, true))

export async function readFileMetadata(source: CachedSource, path: string, size: number | undefined, signal?: AbortSignal): Promise<FileMeta> {
  const { start, bytes: tail, size: fileSize } = await source.tail(path, size, signal)
  const footer = tail.subarray(tail.byteLength - 40)
  const dv = new DataView(footer.buffer, footer.byteOffset, 40)

  if (utf8.decode(footer.subarray(36)) !== 'LANC') throw new Error(`${path} is not a Lance data file`)

  const colMetaStart = u64(dv, 0)
  const cmoTable = u64(dv, 8)
  const gboTable = u64(dv, 16)
  const numGlobal = dv.getUint32(24, true)
  const numColumns = dv.getUint32(28, true)
  let major = dv.getUint16(32, true)
  let minor = dv.getUint16(34, true)

  // the 2.0 format is stamped 0.3 on disk
  if (major === 0 && minor === 3) {
    major = 2
    minor = 0
  }

  if (major !== 2 || minor > 2) throw new Error(`${path}: Lance file format ${major}.${minor} is not supported`)

  // everything from the column metadata to the end is metadata, usually already inside the tail
  const meta = colMetaStart >= start ? tail.subarray(colMetaStart - start) : await source.read(path, colMetaStart, fileSize - colMetaStart, signal)
  const mdv = new DataView(meta.buffer, meta.byteOffset, meta.byteLength)
  const at = (o: number): number => o - colMetaStart
  const globalBuffers: [number, number][] = []

  for (let i = 0; i < numGlobal; i++) globalBuffers.push([u64(mdv, at(gboTable) + i * 16), u64(mdv, at(gboTable) + i * 16 + 8)])

  const v21 = minor >= 1
  const columns: Column[] = []

  for (let c = 0; c < numColumns; c++) {
    const pos = u64(mdv, at(cmoTable) + c * 16)
    const len = u64(mdv, at(cmoTable) + c * 16 + 8)
    const cm = decode(meta.subarray(at(pos), at(pos) + len))
    let rowStart = 0

    const pages = all(cm, 2).map((raw): Page => {
      const p = decode(raw)
      const encoding = pageEncoding(msg(p, 4), v21)
      const zstd = encoding.v === 21 ? layoutUsesZstd(encoding.layout) : encoding.v === 20 && arrayEncodingUsesZstd(encoding.enc)
      const page: Page = { offsets: packed(p, 1), sizes: packed(p, 2), rows: num(p, 3), rowStart, encoding, zstd }
      rowStart += page.rows

      return page
    })

    const offsets = packed(cm, 3)
    const sizes = packed(cm, 4)

    columns.push({ pages, buffers: offsets.map((o, i): [number, number] => [o, sizes[i]]) })
  }

  return { path, v21, columns, globalBuffers }
}

function pageEncoding(enc: Proto | undefined, v21: boolean): PageEncoding {
  // Encoding { oneof { Deferred indirect = 1; Direct direct = 2; None none = 3 } }
  if (!enc) return { v: 'none' }

  if (enc.has(1)) unsupported('deferred page encodings')

  const direct = msg(enc, 2)
  const anyBytes = direct && bytes(direct, 1)

  if (!anyBytes) return { v: 'none' }

  // google.protobuf.Any { string type_url = 1; bytes value = 2 }
  const any = decode(anyBytes)
  const url = str(any, 1)
  const value = bytes(any, 2) ?? new Uint8Array(0)

  if (v21 && url.endsWith('encodings21.PageLayout')) return { v: 21, layout: parseLayout(value) }

  if (!v21 && url.endsWith('encodings.ArrayEncoding')) return { v: 20, enc: parseArrayEncoding(value) }

  return corrupt(url)
}
