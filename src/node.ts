// Node entry: everything in the browser entry, plus local files and zstd from node:zlib.
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { lanceOpen as open_, readRows as readRows_ } from './index.ts'
import { isUri } from './source.ts'
import type { SourceLike } from './index.ts'
import type { LanceDataset, LanceOpenOptions } from './dataset.ts'
import type { LanceReadOptions } from './read.ts'
import type { Source } from './source.ts'
import type { Row, Zstd } from './types.ts'

export * from './index.ts'

/** A dataset directory on the local filesystem. */
export function fileSource(dir: string): Source {
  return {
    async read(path, offset, length, signal) {
      signal?.throwIfAborted()

      const fh = await open(join(dir, path))

      try {
        const b = new Uint8Array(length)
        const { bytesRead } = await fh.read(b, 0, length, offset)

        return b.subarray(0, bytesRead)
      } finally {
        await fh.close()
      }
    },
    async size(path, signal) {
      signal?.throwIfAborted()

      return (await stat(join(dir, path))).size
    },
    async list(sub, signal) {
      signal?.throwIfAborted()

      const entries = await readdir(join(dir, sub), { withFileTypes: true })

      return Promise.all(
        entries.map(async (e) => ({
          name: e.name,
          size: e.isFile() ? (await stat(join(dir, sub, e.name))).size : 0,
          type: e.isDirectory() ? ('directory' as const) : ('file' as const),
        })),
      )
    },
  }
}

/** zstd from node:zlib (Node >= 22.15), undefined on older versions */
export const nodeZstd: Zstd | undefined = zlib.zstdDecompressSync ? (b) => new Uint8Array(zlib.zstdDecompressSync(b)) : undefined

const scheme = /^[a-z][a-z0-9+.-]*:\/\//i

/** strings without a scheme are local paths */
function resolve(source: SourceLike): SourceLike {
  return isUri(source) && !scheme.test(source) ? fileSource(source) : source
}

function withZstd(options: LanceOpenOptions): LanceOpenOptions {
  const zstd = options.decompressors?.zstd ?? nodeZstd

  return zstd ? { ...options, decompressors: { ...options.decompressors, zstd } } : options
}

/** Like the browser lanceOpen, but also opens local paths and decompresses zstd out of the box. */
export function lanceOpen(source: SourceLike, options: LanceOpenOptions = {}): Promise<LanceDataset> {
  return open_(resolve(source), withZstd(options))
}

export function readRows(source: SourceLike, options: LanceReadOptions & LanceOpenOptions = {}): Promise<Row[]> {
  return readRows_(resolve(source), withZstd(options))
}
