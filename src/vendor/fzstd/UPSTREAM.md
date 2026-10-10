# fzstd (vendored)

- Source: https://github.com/101arrowz/fzstd, tag v0.1.1 (commit 4527daeb1fd8e5c3cff89262fc0d779593e5f2fd), `src/index.ts`
- License: MIT (LICENSE in this directory)
- Why vendored: browsers have no zstd decoder, and tinylance has no runtime dependencies. It is loaded
  with a dynamic import only when a dataset uses zstd (src/zstd.ts).
- Deviations: a `// @ts-nocheck` line at the top, since upstream is not written for strict mode.
