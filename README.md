<div align="center">

# tinylance

**Read [Lance](https://github.com/lance-format/lance) datasets anywhere JavaScript runs.** Browsers, Node, Bun, Deno and Workers, in 17 KB with zero dependencies.

<a href="https://www.npmjs.com/package/tinylance"><img src="https://img.shields.io/npm/v/tinylance" alt="npm"></a>
<img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT">
<img src="https://img.shields.io/badge/gzip-17%20KB-orange" alt="17 KB gzip">
<img src="https://img.shields.io/badge/dependencies-0-blue" alt="0 dependencies">

</div>

## Install

```sh
npm install tinylance        # or: pnpm add tinylance, bun add tinylance, deno add npm:tinylance
```

Node 22 or later. In a browser without a bundler, import it from a CDN:

```html
<script type="module">
  import { lanceOpen, lanceRead } from 'https://esm.sh/tinylance'
</script>
```

## Use it

```js
import { lanceOpen, lanceRead } from 'tinylance'

const dataset = await lanceOpen('hf://datasets/lance-format/mnist-lance/data/train.lance')
dataset.numRows // 60000

const rows = await lanceRead(dataset, { columns: ['image', 'label'], offset: 0, limit: 20 })
// [{ image: Uint8Array, label: 5 }, ...]
```

Or in one call: `await readRows(url, { limit: 20 })`. Datasets can be `hf://`, `https://`, `s3://` or `gs://` URLs, or a local path in Node. For private buckets, pass a source from `tinylance/buckets`.

For a LanceDB database (a folder of tables):

```js
import { lancedbConnect } from 'tinylance/lancedb'

const db = lancedbConnect('hf://datasets/lance-format/mnist-lance/data')
await db.tables() // [{ name: 'test', location: 'test.lance' }, { name: 'train', ... }]
const train = await db.open('train')
```

tinylance fetches only the byte ranges it needs. Opening a dataset takes 2 requests, and a page of 20 rows a few more.

| `lanceRead` option | |
| --- | --- |
| `columns` | top-level columns to read (default: all) |
| `offset`, `limit` | the rows to read; deleted rows don't count |
| `maxInlineBytes` | values larger than this (videos, images) come back as lazy handles |
| `signal` | an `AbortSignal` to cancel the read |
| `onChunk` | called with each fragment's rows as soon as they're decoded |

Large values and blob columns come back as lazy handles: `{ byteLength, read() }`.

```js
const [row] = await lanceRead(dataset, { columns: ['video'], limit: 1, maxInlineBytes: 1 << 20 })
row.video.byteLength // 48213004
const bytes = await row.video.read() // fetched only now
```

## Why

|                    | Runs in the browser | Size                 | Dependencies    |
| ------------------ | ------------------- | -------------------- | --------------- |
| **tinylance**      | ✅                  | **17 KB** gzip | **0**           |
| `@lancedb/lancedb` | ❌ (Node only)      | ~254 MB native       | native + Arrow  |

Checked against pylance on the 176 Lance tables found on the Hugging Face Hub in October 2026: the first and a middle page of 20 rows match exactly on 173. The other three read without errors but were too large to diff. Opening takes a median of 2 requests, and a 20-row page 7 more.

## Supports

- Lance file formats 2.0, 2.1 and 2.2, with deletions and schema evolution
- Every encoding pylance writes by default, including FSST, RLE, dictionary, bitpacking, LZ4 and zstd
- Numbers, strings, binary, timestamps, lists, structs and fixed-size lists (vectors come back as typed arrays)
- Blob columns (v1 and v2), as lazy values: inline, packed and dedicated blob files, and external `https://` blobs

zstd uses Node's built-in decoder. Browsers and Workers have none, so tinylance loads a bundled one ([fzstd](https://github.com/101arrowz/fzstd), 3.7 KB) the first time a dataset needs it.

**Not yet:** vector and full-text search, filters, writing.

## Develop

    npm install
    npm test                              # pylance fixtures, request budgets, API
    npm run test:browser                  # the same reads in Chromium
    npm run lint && npm run format:check  # oxlint (with anti-slop) and oxfmt
    npm run size                          # bundle budget
    uv run scripts/fixtures.py            # regenerate fixtures with pylance

Releases: bump `version` in package.json, then `gh release create v<version> --generate-notes`. The release workflow checks, tests and publishes that version to npm with provenance.

Not affiliated with LanceDB. MIT licensed.
