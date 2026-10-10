// Public value types, plus the decoded "block" that every page decoder produces internally.

/**
 * A value left on the server: blob columns, and values larger than `maxInlineBytes`.
 * `byteLength` is the size as stored, which can be smaller than what `read()` returns when the
 * value is compressed. It is undefined when unknown (an external blob stored without a size).
 */
export interface LazyValue {
  readonly byteLength: number | undefined
  read(signal?: AbortSignal): Promise<Uint8Array>
}

export type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array

/**
 * A decoded value: int8–32, uint8–32 and floats are numbers; int64 and uint64 are bigints;
 * timestamps and dates are Dates; strings are strings and binary is Uint8Array; fixed-size lists
 * of numbers (vectors) are typed-array views, or arrays when they hold nulls; lists are arrays;
 * structs are objects; blob columns and large values are LazyValues.
 */
export type Value = null | boolean | number | bigint | string | Date | TypedArray | LazyValue | Value[] | { [field: string]: Value }

export type Row = { [column: string]: Value }

/** unsigned machine words as stored on disk */
export type Words = Uint8Array | Uint16Array | Uint32Array | BigUint64Array

export type PackedChild = (number | bigint | Uint8Array)[]

export interface Block {
  /** bits per value of `fixed` */
  bits?: number
  /** fixed-width values (or raw bytes for widths that are not a power of two) */
  fixed?: Words
  /** variable-width values: offsets (n + 1) into `bytes` */
  offsets?: ArrayLike<number>
  bytes?: Uint8Array
  /** 1 = valid, 0 = null */
  valid?: Uint8Array
  /** fixed-size list dimension */
  dim?: number
  /** fixed-size list items: 1 = valid, 0 = null (one per item, n * dim) */
  itemValid?: Uint8Array
  /** one value repeated for every row */
  constant?: Uint8Array
  allNull?: boolean
  /** packed struct children, one array per child */
  packed?: PackedChild[]
  /** dictionary encoding (2.0): 1-based indices into `items`, 0 = null */
  dictIndices?: Words
  items?: Block
  lazy?: Map<number, LazyValue>
}

export type Zstd = (compressed: Uint8Array) => Uint8Array

export interface Decompressors {
  zstd?: Zstd
}

export interface DecodeContext {
  zstd: Zstd | undefined
  maxInlineBytes: number
  /** pages up to this size are fetched whole instead of metadata first, then chunks */
  wholePageBytes: number
  dictCache: WeakMap<object, Promise<Block>>
  signal: AbortSignal | undefined
}

export type Convert = (block: Block, n: number) => Value[]
