// Hub locations: hf:// URIs and huggingface.co links as copied from the browser.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { hfSource, hfUri, lanceOpen, lanceRead } from '../src/node.ts'
import { expectedRows, normalizeRows } from './helpers.ts'
import { startHub } from './server.ts'
import type { HubServer } from './server.ts'

let hub: HubServer

before(async () => {
  hub = await startHub()
})

after(() => hub.close())

const TABLE = 'hf://datasets/lance-format/fineweb-edu/data/train.lance'

const FRAGMENT = 'data/train.lance/data/000000000001110101001001b13a4341249764c3d505e0524a.lance'

test('huggingface.co links resolve to the hf:// URI of their dataset', () => {
  const cases: [string, string][] = [
    // already an hf:// URI
    [TABLE, TABLE],
    [`${TABLE}/`, TABLE],
    // the page for each kind of link
    ['https://huggingface.co/datasets/lance-format/fineweb-edu/tree/main/data/train.lance', TABLE],
    ['https://huggingface.co/datasets/lance-format/fineweb-edu/tree/main/data/train.lance/', TABLE],
    ['https://huggingface.co/datasets/lance-format/fineweb-edu/resolve/main/data/train.lance', TABLE],
    [`https://huggingface.co/datasets/lance-format/fineweb-edu/blob/main/${FRAGMENT}`, TABLE],
    [`https://huggingface.co/datasets/lance-format/fineweb-edu/resolve/main/${FRAGMENT}?download=true`, TABLE],
    [`https://huggingface.co/datasets/lance-format/fineweb-edu/delete/main/${FRAGMENT}`, TABLE],
    [`https://huggingface.co/datasets/lance-format/fineweb-edu/edit/main/${FRAGMENT}`, TABLE],
    ['https://huggingface.co/datasets/lance-format/fineweb-edu/tree/main/data/train.lance/_versions', TABLE],
    ['https://huggingface.co/datasets/lance-format/fineweb-edu/tree/main/data/train.lance#readme', TABLE],
    // other hosts and schemes for the Hub
    ['https://hf.co/datasets/lance-format/fineweb-edu/tree/main/data/train.lance', TABLE],
    ['https://www.huggingface.co/datasets/lance-format/fineweb-edu/tree/main/data/train.lance', TABLE],
    ['http://huggingface.co/datasets/lance-format/fineweb-edu/tree/main/data/train.lance', TABLE],
    // a fragment inside an hf:// URI
    [`hf://datasets/lance-format/fineweb-edu/${FRAGMENT}`, TABLE],
    // revisions: kept unless main, slashes encoded
    ['https://huggingface.co/datasets/o/n/tree/v1.0/t.lance', 'hf://datasets/o/n@v1.0/t.lance'],
    ['https://huggingface.co/datasets/o/n/tree/refs%2Fconvert%2Flance/t.lance', 'hf://datasets/o/n@refs%2Fconvert%2Flance/t.lance'],
    ['hf://datasets/o/n@v1.0/t.lance', 'hf://datasets/o/n@v1.0/t.lance'],
    // a LanceDB database (a folder of tables) and a whole repo
    ['https://huggingface.co/datasets/lance-format/mnist-lance/tree/main/data', 'hf://datasets/lance-format/mnist-lance/data'],
    ['https://huggingface.co/datasets/lance-format/mnist-lance', 'hf://datasets/lance-format/mnist-lance'],
    ['https://huggingface.co/datasets/lance-format/mnist-lance/tree/main', 'hf://datasets/lance-format/mnist-lance'],
    // models have no prefix in links; spaces do
    ['https://huggingface.co/owner/model/blob/main/vectors.lance/data/0.lance', 'hf://models/owner/model/vectors.lance'],
    ['https://huggingface.co/spaces/owner/app/tree/main/vectors.lance', 'hf://spaces/owner/app/vectors.lance'],
    // escaped characters in paths
    ['https://huggingface.co/datasets/o/n/tree/main/my%20data/t.lance', 'hf://datasets/o/n/my data/t.lance'],
  ]

  for (const [input, expected] of cases) assert.equal(hfUri(input), expected, input)
})

test('a URL that names no repo is rejected', () => {
  for (const url of [
    'hf://datasets/only-owner',
    'https://huggingface.co/',
    'https://huggingface.co/datasets',
    's3://bucket/t.lance',
    'https://huggingface.co/datasets/o/n/tree/main/100%.lance',
  ]) {
    assert.throws(() => hfUri(url), /not a Hugging Face Hub URL/, url)
  }
})

test('a dataset opens from any kind of link to it, including a link to one of its files', async () => {
  const repo = `${hub.endpoint}/datasets/test/fixtures`
  const fragment = 'data/101000100000101001111010b4215e4a36ac2608b0c7b14265.lance'
  const expected = expectedRows('scalars')

  for (const link of [
    `${repo}/tree/main/scalars-v2.1.lance`,
    `${repo}/resolve/main/scalars-v2.1.lance/`,
    `${repo}/blob/main/scalars-v2.1.lance/${fragment}`,
    `${repo}/delete/main/scalars-v2.1.lance/${fragment}?x=1`,
    `${repo}/tree/main/scalars-v2.1.lance/_versions`,
  ]) {
    const ds = await lanceOpen(hfSource(link))

    assert.deepEqual(normalizeRows(await lanceRead(ds)), expected, link)
  }
})
