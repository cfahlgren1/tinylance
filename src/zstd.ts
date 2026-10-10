// zstd for runtimes without one built in (browsers, Workers). Loaded with a dynamic import the
// first time a dataset needs it, so datasets without zstd never download the decoder.
import type { Zstd } from './types.ts'

export async function loadZstd(): Promise<Zstd> {
  const { decompress } = await import('./vendor/fzstd/index.ts')

  return (compressed) => decompress(compressed)
}
