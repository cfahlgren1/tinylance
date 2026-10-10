// Runs examples/browser/index.html in Chromium against the real Hugging Face Hub, with the import
// map's tinylance URLs answered by a bundle of this checkout, and checks each example renders.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = new URL('..', import.meta.url).pathname

const page = readFileSync(`${root}examples/browser/index.html`, 'utf8')

const { outputFiles } = await build({
  entryPoints: { tinylance: `${root}src/index.ts`, lancedb: `${root}src/lancedb.ts` },
  bundle: true,
  splitting: true,
  outdir: '/chunks',
  format: 'esm',
  platform: 'browser',
  write: false,
})

const chunks = new Map(outputFiles.map((f) => [f.path.slice(f.path.lastIndexOf('/') + 1), f.text]))

// serve the page from localhost (a secure context, like the Space), plus this checkout's chunks
const server = createServer((req, res) => {
  const chunk = /^\/chunks\/([\w.-]+\.js)$/.exec(req.url ?? '')

  res.writeHead(200, { 'content-type': chunk ? 'text/javascript' : 'text/html' })
  res.end(chunk ? (chunks.get(chunk[1]) ?? '') : page)
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

// SAFETY: listen() on a TCP port always yields an AddressInfo, never a pipe name or null
const origin = `http://localhost:${(server.address() as AddressInfo).port}`

const browser = await chromium.launch()

try {
  const tab = await browser.newPage({ viewport: { width: 1200, height: 820 }, deviceScaleFactor: 2 })
  const errors: string[] = []

  tab.on('pageerror', (e) => errors.push(e.message))

  // the import map's esm.sh URLs answered by this checkout's build
  await tab.route('https://esm.sh/tinylance@0.1/lancedb', (route) =>
    route.fulfill({ body: `export * from "${origin}/chunks/lancedb.js"`, contentType: 'text/javascript' }),
  )
  await tab.route('https://esm.sh/tinylance@0.1', (route) =>
    route.fulfill({ body: `export * from "${origin}/chunks/tinylance.js"`, contentType: 'text/javascript' }),
  )
  await tab.goto(`${origin}/`)

  const examples = await tab.locator('.examples button').allTextContents()

  for (const [i, name] of examples.entries()) {
    await tab.locator('.examples button').nth(i).click()
    await tab.waitForFunction(() => document.body.dataset.state === 'ready' || document.body.dataset.state === 'error', null, { timeout: 60_000 })

    const state = await tab.evaluate(() => document.body.dataset.state)
    const status = (await tab.locator('#status').textContent()) ?? ''
    const rows = await tab.locator('#rows tr').count()

    assert.equal(state, 'ready', `${name}: ${status}`)
    assert.ok(rows > 1, `${name}: no rows rendered`)

    // MNIST images are rendered from the bytes tinylance returns
    if (i === 0)
      await tab.waitForFunction(() =>
        [...document.querySelectorAll('#rows img')].some((img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0),
      )

    if (process.env.SCREENSHOTS) await tab.screenshot({ path: `${process.env.SCREENSHOTS}/example-${i + 1}.png`, fullPage: true })

    console.log(`ok ${name}: ${status}`)
  }

  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  server.close()
}
