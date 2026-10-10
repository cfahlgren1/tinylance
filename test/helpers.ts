// Shared test helpers: fixture discovery and the comparison format written by scripts/fixtures.py.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Row, Value } from '../src/node.ts'

export const FIXTURES = join(import.meta.dirname, 'fixtures')

/** every fixture dataset, e.g. { scenario: 'scalars', version: '2.1', dir: '.../scalars-v2.1.lance' } */
export const datasets = readdirSync(FIXTURES)
  .flatMap((name) => {
    const m = /^(.+)-v(\d\.\d)\.lance$/.exec(name)

    return m ? [{ scenario: m[1], version: m[2], dir: join(FIXTURES, name) }] : []
  })
  .sort((a, b) => a.dir.localeCompare(b.dir))

export type Expected = ExpectedValue[]

type ExpectedValue = null | boolean | number | string | ExpectedValue[] | { [k: string]: ExpectedValue }

const expectedCache = new Map<string, { [column: string]: ExpectedValue }[]>()

/** pylance's to_table() output for a scenario */
export function expectedRows(scenario: string): { [column: string]: ExpectedValue }[] {
  let rows = expectedCache.get(scenario)

  if (!rows) {
    rows = JSON.parse(gunzipSync(readFileSync(join(FIXTURES, `${scenario}.expected.json.gz`))).toString())
    expectedCache.set(scenario, rows ?? [])
  }

  return rows ?? []
}

const isBigInt = (v: Value): v is bigint => typeof v === 'bigint'

const isNumber = (v: Value): v is number => typeof v === 'number'

/** tinylance's output in the same encoding as the fixtures */
export function normalize(v: Value): ExpectedValue {
  if (v === null || v === true || v === false) return v

  if (v instanceof Date) return { $date: v.getTime() }

  if (v instanceof Uint8Array) return { $bytes: v.length, sha1: createHash('sha1').update(v).digest('hex') }

  if (ArrayBuffer.isView(v)) {
    const out: ExpectedValue[] = []

    for (const x of v) out.push(normalize(x))

    return out
  }

  if (Array.isArray(v)) return v.map(normalize)

  if (isBigInt(v)) return v >= -(2n ** 53n) && v <= 2n ** 53n ? Number(v) : { $int: String(v) }

  if (isNumber(v)) return Number.isNaN(v) ? 'NaN' : v

  if (v instanceof Object && !('read' in v) && !('position' in v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]))

  return String(v)
}

export const normalizeRows = (rows: Row[]): ExpectedValue[] => rows.map((r) => normalize(r))
