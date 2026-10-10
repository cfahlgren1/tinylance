<div align="center">

# tinylance

**Read [Lance](https://github.com/lance-format/lance) datasets anywhere JavaScript runs.** Browsers, Node, Bun, Deno and Workers, in {{SIZE}} KB with zero dependencies.

<img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT">
<img src="https://img.shields.io/badge/gzip-{{SIZE}}%20KB-orange" alt="{{SIZE}} KB gzip">
<img src="https://img.shields.io/badge/dependencies-0-blue" alt="0 dependencies">

</div>

## Use it

```js
import { lanceOpen, lanceRead } from 'tinylance'

const dataset = await lanceOpen('hf://datasets/lance-format/mnist-lance/data/train.lance')
dataset.numRows // 60000

const rows = await lanceRead(dataset, { columns: ['image', 'label'], offset: 0, limit: 20 })
// [{ image: Uint8Array, label: 5 }, ...]
```

Or in one call: `await readRows(url, { limit: 20 })`. Datasets can be `hf://`, `https://`, `s3://` or `gs://` URLs, or a local path in Node. For private buckets, pass a source from `tinylance/buckets`.

tinylance fetches only the byte ranges it needs. Opening a dataset takes 2 requests, and a page of 20 rows a few more. Pass `maxInlineBytes` and large values (videos, images) come back as lazy handles you `read()` when needed. Every call takes an `AbortSignal`.

## Why

|                    | Runs in the browser | Size                 | Dependencies    |
| ------------------ | ------------------- | -------------------- | --------------- |
| **tinylance**      | ✅                  | **{{SIZE}} KB** gzip | **0**           |
| `@lancedb/lancedb` | ❌ (Node only)      | ~254 MB native       | native + Arrow  |

{{HUB}}

## Supports

- Lance file formats 2.0, 2.1 and 2.2, with deletions and schema evolution
- Every encoding pylance writes by default, including FSST, RLE, dictionary, bitpacking, LZ4 and zstd\*
- Numbers, strings, binary, timestamps, lists, structs and fixed-size lists (vectors come back as typed arrays)
- Blob columns, as lazy values

\* zstd is built into Node ≥ 22.15. In browsers, pass one in: `lanceOpen(url, { decompressors: { zstd } })`, for example `decompress` from [fzstd](https://github.com/101arrowz/fzstd). Datasets with deleted rows need it too.

**Not yet:** blob v2 columns (Lance 2.2), vector and full-text search, filters, writing.

## Develop

    npm install
    npm test                              # pylance fixtures, request budgets, API
    npm run test:browser                  # the same reads in Chromium
    npm run lint && npm run format:check  # oxlint (with anti-slop) and oxfmt
    npm run size                          # bundle budget
    uv run scripts/fixtures.py            # regenerate fixtures with pylance

Not affiliated with LanceDB. MIT licensed.
