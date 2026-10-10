// Fails if the browser bundle grows past its budget or the package gains runtime dependencies.
// Measured like an app would ship it: lanceOpen + lanceRead, minified, with code splitting, so
// lazily loaded parts (S3 / GCS support) don't count until a bucket URI is opened.
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'

// an alarm for bloat, not a target to shave bytes against
const BUDGET_GZIP = 20 * 1024

const root = new URL('..', import.meta.url).pathname

const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))

const deps = Object.keys(pkg.dependencies ?? {})

if (deps.length) throw new Error(`tinylance must have zero runtime dependencies, found: ${deps.join(', ')}`)

const { outputFiles, metafile } = await build({
  stdin: { contents: "export { lanceOpen, lanceRead } from './src/index.ts'", resolveDir: root, loader: 'ts' },
  bundle: true,
  splitting: true,
  outdir: '/virtual',
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  metafile: true,
})

// the entry plus every chunk it imports statically is what loads before the first read
const files = new Map(outputFiles.map((f) => [f.path.slice(f.path.lastIndexOf('/') + 1), f]))

const outputs = new Map(Object.entries(metafile.outputs).map(([path, o]) => [path.slice(path.lastIndexOf('/') + 1), o]))

const eager = new Set(['stdin.js'])

for (const name of eager)
  for (const i of outputs.get(name)?.imports ?? []) if (i.kind === 'import-statement') eager.add(i.path.slice(i.path.lastIndexOf('/') + 1))

let eagerGzip = 0

for (const [name, file] of files) {
  const gzip = gzipSync(file.contents, { level: 9 }).length

  if (eager.has(name)) eagerGzip += gzip
  console.log(
    `${eager.has(name) ? 'loaded up front' : 'lazy'} ${name}: ${(file.contents.length / 1024).toFixed(1)} KB min, ${(gzip / 1024).toFixed(1)} KB gzip`,
  )
}

console.log(`total up front: ${(eagerGzip / 1024).toFixed(1)} KB gzip (budget ${BUDGET_GZIP / 1024} KB)`)

if (eagerGzip > BUDGET_GZIP) throw new Error(`the browser bundle is ${eagerGzip} bytes gzipped up front, over the ${BUDGET_GZIP} byte budget`)
