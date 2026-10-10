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

// the browser entry plus fzstd, the way an app reading zstd columns or deletion files would ship it
const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/index.ts'; export { decompress as zstd } from 'fzstd'",
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
})

const hub = await startHub()

const browser = await chromium.launch()

try {
  const page = await browser.newPage()

  await page.route('**/tinylance.js', (route) => route.fulfill({ body: outputFiles[0].text, contentType: 'text/javascript' }))
  await page.goto(`${hub.endpoint}/`)

  for (const name of FIXTURES) {
    const url = hubUrl(`${name}.lance`)
    const nodeRows = await lanceRead(await lanceOpen(hfSource(url, { endpoint: hub.endpoint })), { offset: 7, limit: 20 })

    const browserRows = await page.evaluate(
      async ({ url, endpoint, serializer }) => {
        const tl = await import(`${endpoint}/tinylance.js`)
        const serialize = new Function(`return ${serializer}`)()
        const ds = await tl.lanceOpen(tl.hfSource(url, { endpoint }), { decompressors: { zstd: tl.zstd } })

        return serialize(await tl.lanceRead(ds, { offset: 7, limit: 20 }))
      },
      { url, endpoint: hub.endpoint, serializer: serialize.toString() },
    )

    assert.equal(browserRows, serialize(nodeRows), `${name} differs between Chromium and Node`)
    console.log(`ok ${name}`)
  }
} finally {
  await browser.close()
  await hub.close()
}
