// tinylance: read Lance datasets anywhere JavaScript runs.
import { openDataset } from './dataset.ts'
import type { LanceDataset, LanceOpenOptions } from './dataset.ts'
import { lanceRead } from './read.ts'
import type { LanceReadOptions } from './read.ts'
import { fromUri, isUri } from './source.ts'
import type { Source } from './source.ts'
import type { Row } from './types.ts'

/** A dataset URI (hf://, s3://, gs://, https://) or a source object. */
export type SourceLike = string | Source

/** Open a dataset: finds the latest (or requested) version and reads its manifest, usually 2 requests. */
export async function lanceOpen(source: SourceLike, options: LanceOpenOptions = {}): Promise<LanceDataset> {
  return openDataset(isUri(source) ? await fromUri(source) : source, options)
}

/** Open and read in one call. Prefer lanceOpen + lanceRead when reading more than once. */
export async function readRows(source: SourceLike, options: LanceReadOptions & LanceOpenOptions = {}): Promise<Row[]> {
  return lanceRead(await lanceOpen(source, options), options)
}

export { lanceRead }

export type { LanceDataFile, LanceDataset, LanceField, LanceFragment, LanceOpenOptions } from './dataset.ts'

export type { LanceReadOptions } from './read.ts'

export { hfSource, httpSource } from './source.ts'

export type { Fetch, HfSourceOptions, HttpSourceOptions, Source, SourceEntry } from './source.ts'

export type { Decompressors, LazyValue, Row, TypedArray, Value, Zstd } from './types.ts'
