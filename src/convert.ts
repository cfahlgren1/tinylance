// Logical types: turn decoded blocks into JS values. Lance stores Arrow types as strings in the
// schema, e.g. "int64", "string", "fixed_size_list:float:768", "timestamp:us:UTC", "date32:day".
import { asBytes, toNumbers, words } from './codecs.ts'
import type { Block, Convert, TypedArray, Value, Words } from './types.ts'

const utf8 = new TextDecoder()

type LeafKind = 'string' | 'binary' | 'fsb' | 'fixed'

export function leafKind(type: string): LeafKind {
  if (type === 'string' || type === 'large_string' || type === 'utf8' || type === 'large_utf8') return 'string'

  if (type === 'binary' || type === 'large_binary') return 'binary'

  if (type.startsWith('fixed_size_binary')) return 'fsb'

  return 'fixed'
}

/** reinterpret unsigned words as the logical numeric type (a view, no copy) */
function numeric(type: string, fixed: Words): TypedArray | number[] {
  const { buffer, byteOffset } = fixed
  const n = fixed.length

  // every timestamp and 64-bit time is a signed int64
  if (type.startsWith('timestamp:')) return new BigInt64Array(buffer, byteOffset, n)

  switch (type) {
    case 'int8':
      return new Int8Array(buffer, byteOffset, n)
    case 'int16':
      return new Int16Array(buffer, byteOffset, n)
    case 'int32':
    case 'date32:day':
    case 'time32:s':
    case 'time32:ms':
      return new Int32Array(buffer, byteOffset, n)
    case 'int64':
    case 'date64:ms':
    case 'time64:us':
    case 'time64:ns':
      return new BigInt64Array(buffer, byteOffset, n)
    case 'float':
      return new Float32Array(buffer, byteOffset, n)
    case 'double':
      return new Float64Array(buffer, byteOffset, n)
    case 'halffloat':
      return toNumbers(fixed).map(half)
    default:
      return fixed
  }
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff

  if (e === 0) return s * 2 ** -14 * (f / 1024)

  if (e === 31) return f ? NaN : s * Infinity

  return s * 2 ** (e - 15) * (1 + f / 1024)
}

const TIME_UNIT_MS = new Map([
  ['s', 1000],
  ['ms', 1],
  ['us', 1e-3],
  ['ns', 1e-6],
])

/** per-value conversion for types that are not plain numbers */
function scalar(type: string): ((v: number | bigint) => Value) | null {
  if (type === 'bool') return (v) => v === 1

  if (type.startsWith('timestamp:')) {
    const mul = TIME_UNIT_MS.get(type.split(':')[1]) ?? 1

    return (v) => new Date(Number(v) * mul)
  }

  if (type === 'date32:day') return (v) => new Date(Number(v) * 86_400_000)

  if (type === 'date64:ms') return (v) => new Date(Number(v))

  return null
}

/** `count` values of a fixed-width block; a constant block repeats its single value */
function fixedWords(block: Block, count: number): Words {
  if (block.fixed) return block.fixed

  const c = block.constant

  if (!c) throw new Error('block has no values')

  return words(c.slice(), (c.length * 8) / count, count)
}

/** the flat values of `count` fixed-size list items; numbers stay one typed-array view */
function flat(type: string, block: Block, count: number): TypedArray | Value[] {
  const conv = scalar(type)
  const typed = numeric(type, fixedWords(block, count))

  if (!conv) return Array.isArray(typed) ? typed : typed.subarray(0, count)

  return Array.from({ length: count }, (_, i) => conv(typed[i]))
}

/** Build a converter for a leaf field: (block, n) => n JS values. */
export function converter(type: string): Convert {
  const convert = leafConverter(type)

  return (block, n) => (block.allNull ? new Array<Value>(n).fill(null) : convert(block, n))
}

function leafConverter(type: string): Convert {
  const fsl = /^fixed_size_list:(.+):(\d+)$/.exec(type)

  if (fsl) {
    const inner = fsl[1]
    const dim = Number(fsl[2])
    const innerFsl = inner.startsWith('fixed_size_list:') ? converter(inner) : null

    return (block, n) => {
      if (innerFsl) {
        const items = innerFsl(block, n * dim)

        return Array.from({ length: n }, (_, i) => items.slice(i * dim, (i + 1) * dim))
      }

      // a constant page stores one vector; every row shares its values
      const values = flat(inner, block, block.constant ? dim : n * dim)
      const step = block.constant ? 0 : dim
      const valid = block.itemValid

      // with null items a vector becomes a plain array holding nulls
      if (valid || Array.isArray(values)) {
        return Array.from({ length: n }, (_, i) => Array.from({ length: dim }, (_, k): Value => (valid && !valid[i * step + k] ? null : values[i * step + k])))
      }

      // otherwise each vector is a view into one buffer, not a copy
      return Array.from({ length: n }, (_, i) => values.subarray(i * step, i * step + dim))
    }
  }

  const kind = leafKind(type)

  if (kind === 'string' || kind === 'binary') {
    const asString = kind === 'string'

    return (block, n) => {
      if (block.constant) {
        const c = block.constant

        return new Array<Value>(n).fill(asString ? utf8.decode(c) : c)
      }

      const { offsets, bytes } = block

      if (!offsets || !bytes) throw new Error(`${type} column has no offsets`)

      const out = new Array<Value>(n)

      for (let i = 0; i < n; i++) {
        const v = bytes.subarray(Number(offsets[i]), Number(offsets[i + 1]))
        out[i] = asString ? utf8.decode(v) : v
      }

      return out
    }
  }

  if (kind === 'fsb') {
    const width = Number(type.split(':')[1])

    return (block, n) => {
      if (block.constant) return Array.from({ length: n }, () => block.constant?.slice() ?? null)

      if (!block.fixed) throw new Error(`${type} column has no values`)

      const bytes = asBytes(block.fixed)

      return Array.from({ length: n }, (_, i) => bytes.subarray(i * width, (i + 1) * width))
    }
  }

  const conv = scalar(type)

  return (block, n) => {
    if (block.constant) {
      const v = numeric(type, fixedWords(block, 1))[0]

      return new Array<Value>(n).fill(conv ? conv(v) : v)
    }

    if (!block.fixed) throw new Error(`${type} column has no values`)

    const typed = numeric(type, block.fixed)
    const out = new Array<Value>(n)

    for (let i = 0; i < n; i++) out[i] = conv ? conv(typed[i]) : typed[i]

    return out
  }
}
