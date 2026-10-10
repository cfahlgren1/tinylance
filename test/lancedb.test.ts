// LanceDB databases: tables listed by a __manifest table or by directory, over files and HTTP.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { lancedbConnect } from '../src/lancedb.ts'
import { fileSource, hfSource, lanceRead } from '../src/node.ts'
import type { Source } from '../src/node.ts'
import { FIXTURES } from './helpers.ts'
import { hubUrl, startHub } from './server.ts'
import type { HubServer } from './server.ts'

let hub: HubServer

before(async () => {
  hub = await startHub()
})

after(() => hub.close())

const TABLES = [
  { name: 'animals', location: 'animals.lance' },
  { name: 'numbers', location: 'numbers.lance' },
]

for (const dir of ['lancedb', 'lancedb-plain']) {
  test(`${dir}: lists its tables and opens them`, async () => {
    const db = lancedbConnect(fileSource(join(FIXTURES, dir)))

    assert.deepEqual(
      (await db.tables()).sort((a, b) => a.name.localeCompare(b.name)),
      TABLES,
    )

    const animals = await lanceRead(await db.open('animals'))

    assert.deepEqual(
      animals.map((r) => r.name),
      ['cat', 'dog', 'bird'],
    )
  })
}

test('works over HTTP against a Hub-like server', async () => {
  const db = lancedbConnect(hfSource(hubUrl('lancedb'), { endpoint: hub.endpoint }))
  const numbers = await lanceRead(await db.open('numbers'))

  assert.deepEqual(
    numbers.map((r) => r.n),
    [1n, 2n, 3n, 4n],
  )
})

test('unknown tables fail with a clear error', async () => {
  await assert.rejects(lancedbConnect(fileSource(join(FIXTURES, 'lancedb'))).open('nope'), /no table "nope"/)
})

test('the __manifest table is enough when the store cannot list directories', async () => {
  const files = fileSource(join(FIXTURES, 'lancedb'))
  const noListing: Source = { read: files.read }

  if (files.size) noListing.size = files.size

  const tables = await lancedbConnect(noListing).tables()

  assert.deepEqual(
    tables.sort((a, b) => a.name.localeCompare(b.name)),
    TABLES,
  )
})

test('tables come from __manifest when listing is forbidden', async () => {
  const files = fileSource(join(FIXTURES, 'lancedb'))
  const forbidden: Source = { ...files, list: async () => Promise.reject(new Error('403 ListBucket forbidden')) }
  const tables = await lancedbConnect(forbidden).tables()

  assert.deepEqual(
    tables.sort((a, b) => a.name.localeCompare(b.name)),
    TABLES,
  )
  await assert.rejects(
    lancedbConnect({ ...forbidden, read: async () => Promise.reject(new Error('404')) }).tables(),
    /listing failed \(403 ListBucket forbidden\), reading __manifest failed/,
  )
})
