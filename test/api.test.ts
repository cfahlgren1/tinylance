// The public API: sources, options, lazy values and errors.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileSource, lanceOpen, lanceRead, readRows } from '../src/node.ts'
import type { LazyValue, Source, Value } from '../src/node.ts'
import { expectedRows, FIXTURES, normalizeRows } from './helpers.ts'

const fixture = (name: string): string => join(FIXTURES, name)

test('a local path, a file source and readRows all read the same rows', async () => {
  const expected = expectedRows('scalars').slice(10, 15)
  const fromPath = await lanceRead(await lanceOpen(fixture('scalars-v2.1.lance')), { offset: 10, limit: 5 })
  const fromSource = await lanceRead(await lanceOpen(fileSource(fixture('scalars-v2.1.lance'))), { offset: 10, limit: 5 })
  const oneShot = await readRows(fixture('scalars-v2.1.lance'), { offset: 10, limit: 5 })

  assert.deepEqual(normalizeRows(fromPath), expected)
  assert.deepEqual(normalizeRows(fromSource), expected)
  assert.deepEqual(normalizeRows(oneShot), expected)
})

test('the dataset describes its schema, rows and version', async () => {
  const ds = await lanceOpen(fixture('nested-v2.1.lance'))

  assert.equal(ds.numRows, 2000)
  assert.equal(ds.format, '2.1')
  assert.deepEqual(
    ds.schema.map((f) => [f.name, f.type]),
    [
      ['id', 'int64'],
      ['ints', 'list'],
      ['tags', 'list'],
      ['point', 'struct'],
      ['boxes', 'list'],
    ],
  )
  assert.deepEqual(
    ds.schema[3].children.map((f) => f.name),
    ['x', 'y', 'name'],
  )
})

test('columns selects and orders the returned fields', async () => {
  const rows = await readRows(fixture('strings-v2.2.lance'), { columns: ['uniq', 'label'], limit: 3 })

  assert.deepEqual(
    rows.map((r) => Object.keys(r)),
    [
      ['uniq', 'label'],
      ['uniq', 'label'],
      ['uniq', 'label'],
    ],
  )
})

test('offset and limit are clamped to the dataset', async () => {
  const ds = await lanceOpen(fixture('scalars-v2.0.lance'))

  assert.equal((await lanceRead(ds, { offset: 1995, limit: 100 })).length, 5)
  assert.equal((await lanceRead(ds, { offset: 5000 })).length, 0)
  assert.equal((await lanceRead(ds, { limit: 0 })).length, 0)

  const withDeletions = await lanceOpen(fixture('deletions-v2.0.lance'))

  assert.equal((await lanceRead(withDeletions, { offset: 10, limit: 0 })).length, 0)
})

test('onChunk reports each fragment as it is decoded', async () => {
  const ds = await lanceOpen(fixture('deletions-v2.1.lance'))
  const chunks: { offset: number; rows: number }[] = []
  const rows = await lanceRead(ds, { onChunk: ({ offset, rows: r }) => chunks.push({ offset, rows: r.length }) })

  assert.equal(chunks.length, ds.fragments.length)
  assert.equal(
    chunks.reduce((n, c) => n + c.rows, 0),
    rows.length,
  )
})

const isLazy = (v: Value): v is LazyValue => v instanceof Object && 'read' in v && 'byteLength' in v

for (const version of ['2.0', '2.1', '2.2']) {
  test(`maxInlineBytes returns lazy handles that read the exact bytes (v${version})`, async () => {
    const ds = await lanceOpen(fixture(`blobs-v${version}.lance`))
    const [row] = await lanceRead(ds, { columns: ['image'], offset: 3, limit: 1, maxInlineBytes: 1000 })
    const image = row.image
    const expected = expectedRows('blobs')[3].image

    assert.ok(isLazy(image), 'image should be lazy')

    const bytes = await image.read()

    assert.deepEqual({ $bytes: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') }, expected)
    assert.equal(image.byteLength, bytes.length)
  })
}

test('unknown columns and missing datasets fail with clear errors', async () => {
  const ds = await lanceOpen(fixture('scalars-v2.1.lance'))

  await assert.rejects(lanceRead(ds, { columns: ['nope'] }), /no column "nope"/)
  await assert.rejects(lanceOpen(fixture('does-not-exist.lance')), /ENOENT/)
  await assert.rejects(lanceOpen(fixture('scalars-v2.1.lance'), { version: 99 }), /version 99 not found/)
})

test('blob columns come back as lazy values that read their bytes', async () => {
  for (const version of ['2.0', '2.1']) {
    const rows = await readRows(fixture(`blobfiles-v${version}.lance`), { columns: ['blob'] })
    const expected = expectedRows('blobfiles')

    for (const [i, { blob }] of rows.entries()) {
      if (expected[i].blob === null) {
        assert.equal(blob, null)
        continue
      }

      assert.ok(isLazy(blob))

      const bytes = await blob.read()

      assert.equal(blob.byteLength, bytes.length)
      assert.deepEqual({ $bytes: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') }, expected[i].blob)
    }
  }
})

test('blob v2 columns fail with a clear error instead of returning empty values', async () => {
  const ds = await lanceOpen(fixture('blobv2-v2.2.lance'))

  await assert.rejects(lanceRead(ds), /column "blob" uses Lance blob v2/)
  assert.equal((await lanceRead(ds, { columns: ['id'] })).length, 12)
})

test('a failed request is retried by the next read instead of being cached', async () => {
  const files = fileSource(fixture('deletions-v2.1.lance'))
  let failures = 1

  const flaky: Source = {
    ...files,
    size: async (path) => {
      if (path.startsWith('_deletions/') && failures-- > 0) throw new Error('temporary failure')

      return files.size?.(path) ?? 0
    },
  }

  const ds = await lanceOpen(flaky)

  await assert.rejects(lanceRead(ds), /temporary failure/)
  assert.equal((await lanceRead(ds)).length, ds.numRows)
})
