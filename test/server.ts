// A local stand-in for the Hugging Face Hub over real HTTP: the tree API for listings, and
// /resolve/ URLs that redirect to a CDN path serving byte ranges, like huggingface.co does.
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, normalize } from 'node:path'
import { FIXTURES } from './helpers.ts'

export interface HubServer {
  endpoint: string
  /** requests the server received, e.g. "GET /cdn/scalars-v2.1.lance/_versions/1.manifest bytes=0-99" */
  log: string[]
  close(): Promise<void>
}

const REPO = '/datasets/test/fixtures'

export async function startHub(): Promise<HubServer> {
  const log: string[] = []

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = decodeURIComponent(url.pathname)

    log.push(`${req.method} ${path}${req.headers.range ? ` ${req.headers.range}` : ''}`)

    try {
      const tree = `/api${REPO}/tree/main/`

      if (path.startsWith(tree)) {
        const dir = safe(path.slice(tree.length))
        const entries = await readdir(dir, { withFileTypes: true })

        const body = await Promise.all(
          entries.map(async (e) => {
            const rel = join(path.slice(tree.length), e.name)

            return e.isDirectory() ? { type: 'directory', path: rel } : { type: 'file', path: rel, size: (await stat(join(dir, e.name))).size }
          }),
        )

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))

        return
      }

      const resolve = `${REPO}/resolve/main/`

      if (path.startsWith(resolve)) {
        res.writeHead(302, { location: `/cdn/${path.slice(resolve.length)}` })
        res.end()

        return
      }

      if (path.startsWith('/cdn/')) {
        const file = safe(path.slice('/cdn/'.length))
        const { size } = await stat(file)
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')

        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-length': size })
          res.end()

          return
        }

        if (!range) {
          res.writeHead(200, { 'content-length': size })
          createReadStream(file).pipe(res)

          return
        }

        const start = Number(range[1])
        const end = Math.min(Number(range[2]), size - 1)

        res.writeHead(206, { 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` })
        createReadStream(file, { start, end }).pipe(res)

        return
      }

      res.writeHead(404)
      res.end()
    } catch {
      res.writeHead(404)
      res.end()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  // SAFETY: listen() on a TCP port always yields an AddressInfo, never a pipe name or null
  const { port } = server.address() as AddressInfo

  return {
    endpoint: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

function safe(rel: string): string {
  const p = normalize(join(FIXTURES, rel))

  if (!p.startsWith(FIXTURES)) throw new Error('path escapes the fixtures directory')

  return p
}

/** the hf:// URL of a fixture served by startHub */
export const hubUrl = (fixture: string): string => `hf:/${REPO}/${fixture}`
