// Errors for data that breaks the Lance format's rules. Internal checks share these short
// messages to keep the bundle small; errors users can act on stay descriptive at their call site.

/** the file is corrupt, or uses something this reader doesn't know about */
export function corrupt(what: string): never {
  throw new Error(`corrupt or unknown Lance data: ${what}`)
}

/** a valid Lance feature tinylance doesn't read yet */
export function unsupported(what: string): never {
  throw new Error(`tinylance doesn't support ${what} yet`)
}
