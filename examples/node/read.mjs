// Read a few rows of Lance datasets on the Hugging Face Hub from Node.
// Run with `node examples/node/read.mjs` after `npm install tinylance` (or `npm run build` in this repo).
import { lanceOpen, lanceRead } from 'tinylance'
import { lancedbConnect } from 'tinylance/lancedb'

// 1. Images, labels and embeddings
const mnist = await lanceOpen('hf://datasets/lance-format/mnist-lance/data/train.lance')

const digits = await lanceRead(mnist, { columns: ['label', 'image', 'image_emb'], limit: 3 })

console.log(`mnist: ${mnist.numRows} rows`)

for (const { label, image, image_emb } of digits) console.log(`  label ${label}, ${image.length}-byte PNG, ${image_emb.length}-d embedding`)

// 2. Any page of 1.5 billion rows of text, without downloading the dataset
const fineweb = await lanceOpen('hf://datasets/lance-format/fineweb-edu/data/train.lance')

const [doc] = await lanceRead(fineweb, { columns: ['url', 'text'], offset: 1_000_000_000, limit: 1 })

console.log(`fineweb-edu: ${fineweb.numRows} rows; row 1,000,000,000 is ${doc.url}`)

// 3. A LanceDB database: list its tables and open one
const db = lancedbConnect('hf://datasets/lance-format/mnist-lance/data')

const tables = await db.tables()

const test = await db.open('test')

console.log(`lancedb: tables ${tables.map((t) => t.name).join(', ')}; test has ${test.numRows} rows`)
