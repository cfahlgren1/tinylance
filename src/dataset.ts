// Datasets: _versions/*.manifest -> schema, fragments, deletion files.
import { parseDeletionFile } from './deletions.ts'
import { readFileMetadata } from './file.ts'
import type { FileMeta } from './file.ts'
import { all, bytes, decode, int32, msg, num, packed, str, u64 } from './proto.ts'
import type { Proto } from './proto.ts'
import { abortable, cachedSource, memo } from './source.ts'
import type { CachedSource, Source } from './source.ts'
import type { DecodeContext, Decompressors, Zstd } from './types.ts'
import { loadZstd } from './zstd.ts'

const utf8 = new TextDecoder()

const U64_MAX = (1n << 64n) - 1n

export interface LanceField {
  readonly name: string
  readonly id: number
  /** Arrow type as Lance writes it, e.g. "int64", "string", "fixed_size_list:float:768", "struct" */
  readonly type: string
  readonly nullable: boolean
  readonly metadata: Readonly<Record<string, string>>
  readonly children: readonly LanceField[]
}

export interface LanceDataFile {
  readonly path: string
  /** field ids stored in this file */
  readonly fields: readonly number[]
  /** column index in the file for each field id (-1 = not stored) */
  readonly columns: readonly number[]
  readonly size: number | undefined
}

export interface LanceFragment {
  readonly id: number
  /** live rows, deleted rows already subtracted */
  readonly rows: number
  readonly physicalRows: number
  readonly files: readonly LanceDataFile[]
  readonly deletion: { readonly type: 'arrow' | 'bitmap'; readonly readVersion: number; readonly id: string; readonly count: number } | undefined
}

export interface LanceDataset {
  readonly version: number
  /** live rows, deleted rows already subtracted */
  readonly numRows: number
  readonly schema: readonly LanceField[]
  readonly schemaMetadata: Readonly<Record<string, string>>
  readonly fragments: readonly LanceFragment[]
  /** Lance file format of the data files, e.g. "2.1" */
  readonly format: string
  readonly writer: string | undefined
  readonly timestamp: Date | undefined
}

export interface LanceOpenOptions {
  /** a specific dataset version; defaults to the latest */
  version?: number
  signal?: AbortSignal
  decompressors?: Decompressors
}

/** internal state kept off the public dataset object */
export interface DatasetState {
  source: CachedSource
  decompressors: Decompressors
  files: Map<string, Promise<FileMeta>>
  /** by deletion file path */
  deletions: Map<string, Promise<Uint32Array>>
  /** the bundled zstd decoder, loaded the first time this dataset needs it */
  zstdLoad: Map<string, Promise<Zstd>>
}

const states = new WeakMap<LanceDataset, DatasetState>()

export function stateOf(ds: LanceDataset): DatasetState {
  const s = states.get(ds)

  if (!s) throw new Error('not a dataset opened with lanceOpen')

  return s
}

/** Open a dataset: usually one listing and one range read of the manifest. */
export async function openDataset(source: Source, options: LanceOpenOptions = {}): Promise<LanceDataset> {
  options.signal?.throwIfAborted()

  const cached = cachedSource(source)
  const { path, size } = await findManifest(cached, options.version, options.signal)
  const ds = await readManifest(cached, path, size, options.signal)

  states.set(ds, { source: cached, decompressors: options.decompressors ?? {}, files: new Map(), deletions: new Map(), zstdLoad: new Map() })

  return ds
}

async function findManifest(
  source: CachedSource,
  version: number | undefined,
  signal: AbortSignal | undefined,
): Promise<{ path: string; size: number | undefined }> {
  if (source.list) {
    const manifests = (await source.list('_versions', signal)).flatMap((e) => {
      if (!e.name.endsWith('.manifest')) return []

      const n = BigInt(e.name.slice(0, -'.manifest'.length))

      // v2 naming stores U64_MAX - version so that names sort newest first
      return [{ name: e.name, size: e.size, version: n > 1n << 62n ? U64_MAX - n : n }]
    })

    manifests.sort((a, b) => (b.version > a.version ? 1 : b.version < a.version ? -1 : 0))

    const hit = version === undefined ? manifests[0] : manifests.find((e) => e.version === BigInt(version))

    if (!hit) throw new Error(version === undefined ? 'no manifests found under _versions/' : `version ${version} not found`)

    return { path: `_versions/${hit.name}`, size: hit.size }
  }

  // no listing (plain HTTP, or a bucket without list permission): use the version hint
  let v = version

  if (v === undefined) {
    const hint = await source.read('_versions/latest_version_hint.json', 0, 1024, signal).catch(() => null)

    signal?.throwIfAborted()

    if (!hint) throw new Error('cannot list _versions/ and there is no latest_version_hint.json; pass { version }')

    const parsed: { version: number } = JSON.parse(utf8.decode(hint).replace(/\0+$/, ''))
    v = parsed.version
  }

  for (const name of [`${U64_MAX - BigInt(v)}`.padStart(20, '0'), String(v)]) {
    const path = `_versions/${name}.manifest`
    const size = await source.size(path, signal).catch(() => null)

    signal?.throwIfAborted()

    if (size !== null) return { path, size }
  }

  throw new Error(`manifest for version ${v} not found`)
}

interface FlatField {
  name: string
  id: number
  parentId: number
  type: string
  nullable: boolean
  metadata: Record<string, string>
  children: FlatField[]
}

function keyValues(list: Uint8Array[]) {
  return Object.fromEntries(
    list.map((e) => {
      const kv = decode(e)

      return [str(kv, 1), utf8.decode(bytes(kv, 2) ?? new Uint8Array(0))]
    }),
  )
}

/** build the field tree from the flat field list (parent id -1 = top level) */
function fieldTree(list: Uint8Array[]): LanceField[] {
  const fields = list.map((b): FlatField => {
    const f = decode(b)

    return { name: str(f, 2), id: int32(f, 3), parentId: int32(f, 4), type: str(f, 5), nullable: !!num(f, 6), metadata: keyValues(all(f, 10)), children: [] }
  })

  const byId = new Map(fields.map((f) => [f.id, f]))
  const roots: FlatField[] = []

  for (const f of fields) {
    if (f.parentId === -1) roots.push(f)
    else byId.get(f.parentId)?.children.push(f)
  }

  const strip = (f: FlatField): LanceField => ({
    name: f.name,
    id: f.id,
    type: f.type,
    nullable: f.nullable,
    metadata: f.metadata,
    children: f.children.map(strip),
  })

  return roots.map(strip)
}

function fragment(raw: Uint8Array): LanceFragment {
  const fr = decode(raw)
  const del = msg(fr, 3)
  const physicalRows = num(fr, 4)
  const deletion = del && { type: num(del, 1) === 1 ? ('bitmap' as const) : ('arrow' as const), readVersion: num(del, 2), id: u64(del, 3), count: num(del, 4) }

  const files = all(fr, 2).map((d): LanceDataFile => {
    const df = decode(d)

    return { path: str(df, 1), fields: packed(df, 2), columns: packed(df, 3), size: num(df, 6) || undefined }
  })

  return { id: num(fr, 1), rows: physicalRows - (deletion?.count ?? 0), physicalRows, files, deletion }
}

async function readManifest(source: CachedSource, path: string, size: number | undefined, signal: AbortSignal | undefined): Promise<LanceDataset> {
  const { start, bytes: tail, size: fileSize } = await source.tail(path, size, signal)

  if (utf8.decode(tail.subarray(tail.byteLength - 4)) !== 'LANC') throw new Error(`${path} is not a Lance manifest`)

  const pos = Number(new DataView(tail.buffer, tail.byteOffset + tail.byteLength - 16, 8).getBigUint64(0, true))
  const body = pos >= start ? tail.subarray(pos - start) : await source.read(path, pos, fileSize - pos, signal)
  const len = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true)
  const m = decode(body.subarray(4, 4 + len))
  const fragments = all(m, 2).map(fragment)
  const files = fragments.flatMap((f) => f.files)

  return {
    version: num(m, 3),
    numRows: fragments.reduce((a, f) => a + f.rows, 0),
    schema: fieldTree(all(m, 1)),
    schemaMetadata: keyValues(all(m, 5)),
    fragments,
    format: formatOf(msg(m, 15), files),
    writer: writerOf(msg(m, 13)),
    timestamp: timestampOf(msg(m, 7)),
  }
}

function formatOf(fmt: Proto | undefined, files: LanceDataFile[]): string {
  const v = fmt ? str(fmt, 2) : ''

  // older manifests leave the format version unset; "legacy" means 2.0 files
  if (v && v !== 'legacy') return v

  return files.length ? '2.0' : ''
}

function writerOf(w: Proto | undefined): string | undefined {
  return w ? `${str(w, 1)} ${str(w, 2)}` : undefined
}

function timestampOf(t: Proto | undefined): Date | undefined {
  return t ? new Date(num(t, 1) * 1000 + Math.floor(num(t, 2) / 1e6)) : undefined
}

// file metadata and deletion files are shared by every read of the dataset: they are fetched
// without a caller's signal, and each caller's signal only stops its own wait

export function fileMeta(ds: LanceDataset, file: LanceDataFile, ctx: DecodeContext): Promise<FileMeta> {
  const state = stateOf(ds)
  const path = `data/${file.path}`

  return abortable(
    memo(state.files, path, () => readFileMetadata(state.source, path, file.size)),
    ctx.signal,
  )
}

/** the dataset's zstd decoder: the one passed to lanceOpen, or the bundled one, loaded once */
export function zstdFor(ds: LanceDataset): Promise<Zstd> {
  const state = stateOf(ds)
  const given = state.decompressors.zstd

  return given ? Promise.resolve(given) : memo(state.zstdLoad, 'zstd', loadZstd)
}

/** sorted physical row offsets deleted from a fragment (empty if none) */
export function deletedRows(ds: LanceDataset, frag: LanceFragment, ctx: DecodeContext): Promise<Uint32Array> {
  const d = frag.deletion

  if (!d) return Promise.resolve(new Uint32Array(0))

  const { source, deletions } = stateOf(ds)
  const path = `_deletions/${frag.id}-${d.readVersion}-${d.id}.${d.type === 'bitmap' ? 'bin' : 'arrow'}`

  return abortable(
    memo(deletions, path, async () => parseDeletionFile(await source.read(path, 0, await source.size(path)), d.type, () => zstdFor(ds))),
    ctx.signal,
  )
}
