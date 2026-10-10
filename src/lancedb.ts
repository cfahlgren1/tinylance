// tinylance/lancedb: a LanceDB database is a directory of Lance tables. Newer ones list their
// tables in a `__manifest` Lance table (a directory namespace); older ones are just `<name>.lance`
// directories.
import { openDataset } from './dataset.ts'
import type { LanceDataset, LanceOpenOptions } from './dataset.ts'
import type { SourceLike } from './index.ts'
import { lanceRead } from './read.ts'
import { abortable, fromUri, isUri, memo } from './source.ts'
import type { Fetch, Source } from './source.ts'
import type { Decompressors, Value } from './types.ts'

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

/** a view of `source` rooted at one of its directories; without `list` when listing is denied */
function subSource(source: Source, dir: string, canList = true): Source {
  const at = (path: string): string => `${dir}/${path}`
  const sub: Source = { read: (path, offset, length, signal) => source.read(at(path), offset, length, signal) }
  const { size, list } = source

  if (size) sub.size = (path, signal) => size.call(source, at(path), signal)

  if (list && canList) sub.list = (path, signal) => list.call(source, at(path), signal)

  return sub
}

/** options for every table opened through a connection */
export interface LanceDbOptions {
  decompressors?: Decompressors
  /** used for blobs stored at external URLs; defaults to the global fetch */
  fetch?: Fetch
}

/** Connect to a LanceDB database: `hf://`, `https://`, `s3://` or `gs://`, or a source (e.g. `fileSource(dir)` in Node). */
export function lancedbConnect(database: SourceLike, options: LanceDbOptions = {}): LanceDb {
  const root = memo(new Map<string, Promise<Source>>(), '', async () => (isUri(database) ? fromUri(database) : database))
  const listed = new Map<string, Promise<LanceDbTable[]>>()

  // without listing, the manifest's latest version comes from its version hint file
  async function readManifest(source: Source, canList: boolean): Promise<LanceDbTable[]> {
    const manifest = await openDataset(subSource(source, '__manifest', canList), options)
    const rows = await lanceRead(manifest, { columns: ['object_id', 'object_type', 'location'] })

    return rows.flatMap((r) =>
      r.object_type === 'table' && isText(r.object_id) ? [{ name: r.object_id, location: isText(r.location) ? r.location : `${r.object_id}.lance` }] : [],
    )
  }

  async function listTables(): Promise<LanceDbTable[]> {
    const source = await root
    // a store that can't list (no permission, or plain HTTP) may still have a readable manifest
    const listing = source.list ? await source.list('').catch((error: Error) => error) : null
    const entries = Array.isArray(listing) ? listing : []

    if (!Array.isArray(listing) || entries.some((e) => e.name === '__manifest')) {
      const fromManifest = await readManifest(source, Array.isArray(listing)).catch((error: Error) => {
        // with no listing either, say why both ways of finding tables failed
        if (!Array.isArray(listing))
          throw new Error(
            `cannot find this database's tables: ${listing ? `listing failed (${listing.message}), ` : ''}reading __manifest failed (${error.message})`,
          )

        return []
      })

      // an empty manifest (the Hub keeps one for every dataset) falls back to the listing
      if (fromManifest.length || !Array.isArray(listing)) return fromManifest
    }

    return entries.flatMap((e) => (e.name.endsWith('.lance') ? [{ name: e.name.slice(0, -'.lance'.length), location: e.name }] : []))
  }

  const db: LanceDb = {
    // the listing is shared by every caller, so it runs without any one caller's signal
    tables: (opts = {}) => abortable(memo(listed, '', listTables), opts.signal),
    async open(name, openOptions = {}) {
      const source = await root
      const table = (await db.tables({ signal: openOptions.signal })).find((t) => t.name === name)

      if (!table) throw new Error(`no table "${name}" in this LanceDB database`)

      return openDataset(subSource(source, table.location), { ...options, ...openOptions })
    },
  }

  return db
}
