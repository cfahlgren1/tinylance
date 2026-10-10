// Schemaless protobuf wire decoder: decode(bytes) maps each field number to its values.
// Varints are numbers, or bigints once they pass 2^53 (random u64 ids). Length-delimited
// fields stay as Uint8Array views so nested messages are decoded only when read.

export type ProtoValue = number | bigint | Uint8Array

export type Proto = Map<number, ProtoValue[]>

const utf8 = new TextDecoder()

export function decode(bytes: Uint8Array): Proto {
  const out: Proto = new Map()
  const n = bytes.length
  let i = 0

  while (i < n) {
    let key = 0
    let shift = 0
    let b: number

    do {
      b = bytes[i++]
      key += (b & 0x7f) * 2 ** shift
      shift += 7
    } while (b & 0x80)

    const field = Math.floor(key / 8)
    const wire = key & 7
    let v: ProtoValue

    if (wire === 0) {
      const start = i
      let num = 0
      shift = 0

      do {
        b = bytes[i++]
        num += (b & 0x7f) * 2 ** shift
        shift += 7
      } while (b & 0x80)

      v = shift > 49 ? bigVarint(bytes, start) : num
    } else if (wire === 2) {
      let len = 0
      shift = 0

      do {
        b = bytes[i++]
        len += (b & 0x7f) * 2 ** shift
        shift += 7
      } while (b & 0x80)

      v = bytes.subarray(i, i + len)
      i += len
    } else if (wire === 1) {
      v = new DataView(bytes.buffer, bytes.byteOffset + i, 8).getBigUint64(0, true)
      i += 8
    } else if (wire === 5) {
      v = new DataView(bytes.buffer, bytes.byteOffset + i, 4).getUint32(0, true)
      i += 4
    } else {
      throw new Error(`protobuf: unsupported wire type ${wire}`)
    }

    const list = out.get(field)

    if (list) list.push(v)
    else out.set(field, [v])
  }

  return out
}

function bigVarint(bytes: Uint8Array, start: number): bigint {
  let r = 0n
  let s = 0n
  let i = start
  let b: number

  do {
    b = bytes[i++]
    r |= BigInt(b & 0x7f) << s
    s += 7n
  } while (b & 0x80)

  return BigInt.asUintN(64, r)
}

export const has = (m: Proto, k: number): boolean => m.has(k)

/** the first value of a field as raw bytes (a string, bytes or a nested message) */
export function bytes(m: Proto, k: number): Uint8Array | undefined {
  const v = m.get(k)?.[0]

  if (v === undefined) return undefined

  if (!(v instanceof Uint8Array)) throw new Error(`protobuf: field ${k} is not length-delimited`)

  return v
}

/** every value of a repeated length-delimited field */
export function all(m: Proto, k: number): Uint8Array[] {
  const out: Uint8Array[] = []

  for (const v of m.get(k) ?? []) {
    if (!(v instanceof Uint8Array)) throw new Error(`protobuf: field ${k} is not length-delimited`)
    out.push(v)
  }

  return out
}

/** the first value decoded as a nested message */
export function msg(m: Proto, k: number): Proto | undefined {
  const b = bytes(m, k)

  return b ? decode(b) : undefined
}

/** a number field, with the proto3 default of 0 */
export function num(m: Proto, k: number): number {
  const v = m.get(k)?.[0]

  if (v === undefined) return 0

  if (v instanceof Uint8Array) throw new Error(`protobuf: field ${k} is not a number`)

  return Number(v)
}

/** an unsigned 64-bit field as an exact decimal string */
export function u64(m: Proto, k: number): string {
  const v = m.get(k)?.[0]

  if (v === undefined) return '0'

  if (v instanceof Uint8Array) throw new Error(`protobuf: field ${k} is not a number`)

  return String(v)
}

/** an int32 field; negative values are sign-extended to 64 bits on the wire */
export function int32(m: Proto, k: number): number {
  const v = m.get(k)?.[0]

  if (v === undefined) return 0

  if (v instanceof Uint8Array) throw new Error(`protobuf: field ${k} is not a number`)

  return Number(BigInt.asIntN(32, BigInt(v)))
}

export function str(m: Proto, k: number): string {
  const b = bytes(m, k)

  return b ? utf8.decode(b) : ''
}

/** a repeated varint field, packed (the proto3 default) or not; values are signed 64-bit */
export function packed(m: Proto, k: number): number[] {
  const res: number[] = []

  for (const v of m.get(k) ?? []) {
    if (!(v instanceof Uint8Array)) {
      res.push(Number(BigInt.asIntN(64, BigInt(v))))
      continue
    }

    let i = 0

    while (i < v.length) {
      const start = i
      let r = 0
      let shift = 0
      let b: number

      do {
        b = v[i++]
        r += (b & 0x7f) * 2 ** shift
        shift += 7
      } while (b & 0x80)

      res.push(shift > 49 ? Number(BigInt.asIntN(64, bigVarint(v, start))) : r)
    }
  }

  return res
}

/** the field number of the single field set in a protobuf `oneof` wrapper */
export function oneofTag(m: Proto): number {
  const first = m.keys().next()

  if (first.done) throw new Error('protobuf: empty oneof')

  return first.value
}
