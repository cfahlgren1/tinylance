// tinylance/lancedb: a LanceDB database is a directory of Lance tables. Newer ones list their
// tables in a `__manifest` Lance table (a directory namespace); older ones are just `<name>.lance`
// directories.
import { openDataset } from './dataset.ts'
import type { LanceDataset, LanceOpenOptions } from './dataset.ts'
import type { SourceLike } from './index.ts'
import { lanceRead } from './read.ts'
import { abortable, fromUri, isUri, memo } from './source.ts'
import type { Source } from './source.ts'
import type { Value } from './types.ts'

export interface LanceDbTable {
  /** the table's id in the database, e.g. "animals" */
  name: string
  /** its directory, relative to the database */
  location: string
}

export interface LanceDb {
  /** every table, from the `__manifest` table or else a directory listing */
  tables(options?: { signal?: AbortSignal | undefined }): Promise<LanceDbTable[]>
  open(name: string, options?: LanceOpenOptions): Promise<LanceDataset>
}

const isText = (v: Value): v is string => typeof v === 'string'

/** a view of `source` rooted at one of its directories */
function subSource(source: Source, dir: string): Source {
  const at = (path: string): string => `${dir}/${path}`
  const sub: Source = { read: (path, offset, length, signal) => source.read(at(path), offset, length, signal) }
  const { size, list } = source

  if (size) sub.size = (path, signal) => size.call(source, at(path), signal)

  if (list) sub.list = (path, signal) => list.call(source, at(path), signal)

  return sub
}

/** Connect to a LanceDB database: `hf://`, `https://`, `s3://` or `gs://`, or a source (e.g. `fileSource(dir)` in Node). */
export function lancedbConnect(database: SourceLike, options: LanceOpenOptions = {}): LanceDb {
  const root = memo(new Map<string, Promise<Source>>(), '', async () => (isUri(database) ? fromUri(database) : database))
  const listed = new Map<string, Promise<LanceDbTable[]>>()

  async function listTables(signal: AbortSignal | undefined): Promise<LanceDbTable[]> {
    const source = await root
    const entries = source.list ? await source.list('', signal) : []

    // without listing permission, the manifest is still worth trying
    if (!source.list || entries.some((e) => e.name === '__manifest')) {
      const manifest = await openDataset(subSource(source, '__manifest'), { ...options, signal })
      const rows = await lanceRead(manifest, { columns: ['object_id', 'object_type', 'location'], signal })

      const tables = rows.flatMap((r) =>
        r.object_type === 'table' && isText(r.object_id) ? [{ name: r.object_id, location: isText(r.location) ? r.location : `${r.object_id}.lance` }] : [],
      )

      // an empty manifest (the Hub keeps one for every dataset) falls back to the listing
      if (tables.length) return tables
    }

    return entries.flatMap((e) => (e.name.endsWith('.lance') ? [{ name: e.name.slice(0, -'.lance'.length), location: e.name }] : []))
  }

  const db: LanceDb = {
    // the listing is shared by every caller, so it runs without any one caller's signal
    tables: (opts = {}) =>
      abortable(
        memo(listed, '', () => listTables(undefined)),
        opts.signal,
      ),
    async open(name, openOptions = {}) {
      const source = await root
      const table = (await db.tables({ signal: openOptions.signal })).find((t) => t.name === name)

      if (!table) throw new Error(`no table "${name}" in this LanceDB database`)

      return openDataset(subSource(source, table.location), { ...options, ...openOptions })
    },
  }

  return db
}
