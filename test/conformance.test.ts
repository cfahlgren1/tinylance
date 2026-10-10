// Every fixture, every format version: tinylance reads exactly what pylance's to_table() returns.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lanceOpen, lanceRead } from '../src/node.ts'
import { datasets, expectedRows, normalizeRows } from './helpers.ts'

for (const { scenario, version, dir } of datasets) {
  test(`${scenario} v${version} matches pylance`, async () => {
    const ds = await lanceOpen(dir)
    const expected = expectedRows(scenario)

    assert.equal(ds.numRows, expected.length)
    assert.equal(ds.format, version)
    assert.deepEqual(normalizeRows(await lanceRead(ds)), expected)
  })
}
