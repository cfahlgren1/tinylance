// Request budgets over real HTTP, against a local server that behaves like the Hub.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { hfSource, lanceOpen, lanceRead } from '../src/node.ts'
import type { Fetch } from '../src/node.ts'
import { datasets, expectedRows, normalizeRows } from './helpers.ts'
import { hubUrl, startHub } from './server.ts'
import type { HubServer } from './server.ts'

let hub: HubServer

before(async () => {
  hub = await startHub()
})

after(() => hub.close())

/** a hub source that records every fetch it makes */
function counted(fixture: string) {
  const calls: string[] = []

  const countingFetch: Fetch = (input, init) => {
    calls.push(String(input))

    return fetch(input, init)
  }

  return { source: hfSource(hubUrl(fixture), { endpoint: hub.endpoint, fetch: countingFetch }), calls }
}

test('opening a dataset takes 2 requests: one listing and one manifest read', async () => {
  for (const { dir } of datasets) {
    const fixture = dir.slice(dir.lastIndexOf('/') + 1)
    const { source, calls } = counted(fixture)

    await lanceOpen(source)
    assert.equal(calls.length, 2, `${fixture}: ${calls.join(', ')}`)
  }
})

test('a pinned version opens without the latest version', async () => {
  const { source } = counted('deletions-v2.1.lance')
  const ds = await lanceOpen(source, { version: 2 })

  assert.equal(ds.version, 2)
})

// Upper bounds on requests for the first page and a middle page of 20 rows. They are the
// measured counts; same-tick coalescing makes blobs-v2.0 vary between 5 and 6.
const PAGE_BUDGETS = new Map([
  ['blobs-v2.0', [6, 5]],
  ['blobs-v2.1', [4, 4]],
  ['blobs-v2.2', [4, 4]],
  ['deletions-v2.0', [3, 3]],
  ['deletions-v2.1', [3, 3]],
  ['deletions-v2.2', [3, 3]],
  ['lists-v2.0', [6, 4]],
  ['lists-v2.1', [3, 3]],
  ['lists-v2.2', [3, 2]],
  ['nested-v2.0', [4, 3]],
  ['nested-v2.1', [2, 1]],
  ['nested-v2.2', [2, 1]],
  ['scalars-v2.0', [2, 1]],
  ['scalars-v2.1', [2, 1]],
  ['scalars-v2.2', [2, 1]],
  ['strings-v2.0', [5, 6]],
  ['strings-v2.1', [2, 1]],
  ['strings-v2.2', [1, 0]],
  ['vectors-v2.0', [2, 2]],
  ['vectors-v2.1', [2, 1]],
  ['vectors-v2.2', [2, 1]],
  ['zstd-v2.1', [1, 0]],
  ['zstd-v2.2', [1, 0]],
])

for (const { scenario, version, dir } of datasets) {
  const name = `${scenario}-v${version}`

  test(`${name}: pages of 20 rows stay within their request budget`, async () => {
    const [firstBudget, middleBudget] = PAGE_BUDGETS.get(name) ?? [0, 0]
    const { source, calls } = counted(dir.slice(dir.lastIndexOf('/') + 1))
    const ds = await lanceOpen(source)

    const page = async (offset: number): Promise<number> => {
      const before = calls.length
      const rows = await lanceRead(ds, { offset, limit: 20 })

      assert.deepEqual(normalizeRows(rows), expectedRows(scenario).slice(offset, offset + 20))

      return calls.length - before
    }

    assert.ok((await page(0)) <= firstBudget, `first page: ${calls.join('\n')}`)
    assert.ok((await page(Math.floor(ds.numRows / 2))) <= middleBudget, `middle page: ${calls.join('\n')}`)
  })
}

test('an aborted read rejects and stops fetching', async () => {
  const { source, calls } = counted('strings-v2.1.lance')
  const ds = await lanceOpen(source)
  const controller = new AbortController()
  const read = lanceRead(ds, { signal: controller.signal })

  controller.abort()
  await assert.rejects(read, { name: 'AbortError' })

  const made = calls.length

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls.length, made)
})
