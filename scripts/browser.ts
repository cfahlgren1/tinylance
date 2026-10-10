// Browser smoke test: bundle the browser entry, run it in Chromium against the local Hub
// stand-in, and check it returns the same rows as Node.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { hfSource, lanceOpen, lanceRead } from '../src/node.ts'
import type { Value } from '../src/node.ts'
import { hubUrl, startHub } from '../test/server.ts'

const FIXTURES = [
  'scalars-v2.0',
  'scalars-v2.1',
  'strings-v2.0',
  'strings-v2.2',
  'nested-v2.1',
  'vectors-v2.1',
  'lists-v2.0',
  'deletions-v2.1',
  'zstd-v2.2',
  'blobs-v2.1',
]

/** a JSON-safe view of rows that is identical in Node and the browser */
function serialize(v: Value): string {
  return JSON.stringify(v, (_, x: Value) => {
    if (x instanceof Uint8Array) return { bytes: x.length, head: Array.from(x.subarray(0, 8)) }

    if (ArrayBuffer.isView(x)) return Array.from(x, String)

    if (x instanceof Date) return { date: x.getTime() }

    return x === null || x instanceof Object ? x : String(x)
  })
}

// the browser entry split into chunks the way an app bundler ships it, so the zstd decoder and
// bucket sources load on demand
const { outputFiles } = await build({
  entryPoints: { tinylance: new URL('../src/index.ts', import.meta.url).pathname },
  bundle: true,
  splitting: true,
  outdir: '/chunks',
  format: 'esm',
  platform: 'browser',
  write: false,
})

const chunks = new Map(outputFiles.map((f) => [f.path.slice(f.path.lastIndexOf('/') + 1), f.text]))

const zstdChunk = [...chunks].find(([, text]) => text.includes('ZstdErrorCode'))?.[0]

assert.ok(zstdChunk, 'the zstd decoder should be its own chunk')

const hub = await startHub()

const browser = await chromium.launch()

try {
  const page = await browser.newPage()

  const loaded: string[] = []

  await page.route('**/chunks/*.js', (route) => {
    const name = route.request().url().split('/').pop() ?? ''

    loaded.push(name)

    return route.fulfill({ body: chunks.get(name) ?? '', contentType: 'text/javascript' })
  })
  await page.goto(`${hub.endpoint}/`)

  for (const name of FIXTURES) {
    const url = hubUrl(`${name}.lance`)
    const nodeRows = await lanceRead(await lanceOpen(hfSource(url, { endpoint: hub.endpoint })), { offset: 7, limit: 20 })

    const browserRows = await page.evaluate(
      async ({ url, endpoint, serializer }) => {
        const tl = await import(`${endpoint}/chunks/tinylance.js`)
        const serialize = new Function(`return ${serializer}`)()
        const ds = await tl.lanceOpen(tl.hfSource(url, { endpoint }))

        return serialize(await tl.lanceRead(ds, { offset: 7, limit: 20 }))
      },
      { url, endpoint: hub.endpoint, serializer: serialize.toString() },
    )

    assert.equal(browserRows, serialize(nodeRows), `${name} differs between Chromium and Node`)

    // the decoder loads only once a dataset needs it (zstd columns, compressed deletion files)
    if (name === 'scalars-v2.0') assert.ok(!loaded.includes(zstdChunk), 'zstd loaded for a dataset without zstd')

    console.log(`ok ${name}`)
  }

  assert.ok(loaded.includes(zstdChunk), 'zstd was never loaded')
} finally {
  await browser.close()
  await hub.close()
}
