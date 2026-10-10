// The published entry points resolve the way runtimes and bundlers will load them. Importing
// 'tinylance' from inside this checkout resolves through package.json exports (self-reference).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

const root = new URL('..', import.meta.url).pathname

async function bundle(conditions: string[], platform: 'browser' | 'node' | 'neutral'): Promise<string[]> {
  const { metafile } = await build({
    stdin: { contents: "export * from 'tinylance'", resolveDir: root },
    bundle: true,
    write: false,
    metafile: true,
    platform,
    conditions,
    format: 'esm',
    external: ['node:*'],
    logLevel: 'silent',
  })

  return Object.keys(metafile.inputs)
}

test('browsers and workers get the entry without node built-ins', async () => {
  for (const [conditions, platform] of [
    [['browser'], 'browser'],
    [['worker', 'workerd'], 'neutral'],
    [[], 'neutral'],
  ] as const) {
    const inputs = await bundle([...conditions], platform)

    assert.ok(
      inputs.some((f) => f.endsWith('dist/index.js')),
      `${conditions.join(',') || 'no conditions'}: ${inputs.join(', ')}`,
    )
    assert.ok(!inputs.some((f) => f.endsWith('dist/node.js') || f.startsWith('node:')), `${conditions.join(',') || 'no conditions'} pulled in node code`)
  }
})

test('node gets the entry with local files and zstd', async () => {
  const inputs = await bundle([], 'node')

  assert.ok(inputs.some((f) => f.endsWith('dist/node.js')))
})
