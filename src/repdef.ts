// Rebuild nested rows from Lance repetition/definition levels.
//
// layers: inner-most first, each one of item | nullitem | list | nulllist | emptylist | nullemptylist.
// def level 0 = valid at every layer; levels are numbered from the inner-most layer outwards.
// rep level r > 0 starts a new list at the r-th list layer counted from the inside
// (r == number of list layers starts a new row).
// values: one per visible level entry (item nulls are visible, null and empty lists are not).
import type { Value } from './types.ts'

export type Layer = 'item' | 'list' | 'nullitem' | 'nulllist' | 'emptylist' | 'nullemptylist'

/** Marks a leaf whose enclosing struct is null, so struct assembly can null the whole struct. Compared by identity. */
export const STRUCT_NULL: { readonly [field: string]: Value } = Object.freeze({})

const isList = (x: Layer): boolean => x.includes('list')

export function unravel(values: Value[], rep: Uint16Array | null, def: Uint16Array | null, layers: Layer[]): Value[] {
  // def level -> the layer it nulls or empties
  const defMeaning: ({ k: number; what: 'null' | 'empty' } | null)[] = [null]

  layers.forEach((x, k) => {
    if (x === 'nullitem' || x === 'nulllist') defMeaning.push({ k, what: 'null' })
    else if (x === 'emptylist') defMeaning.push({ k, what: 'empty' })
    else if (x === 'nullemptylist') defMeaning.push({ k, what: 'null' }, { k, what: 'empty' })
  })

  // list index (1 = inner-most list) for each layer, 0 for non-list layers
  const listIndex: number[] = []
  let lists = 0

  layers.forEach((x, k) => {
    listIndex[k] = isList(x) ? ++lists : 0
  })

  // a layer above k that is a list hides nulls below it from the value stream
  const visibleBelow = layers.map((_, k) => !layers.slice(0, k).some(isList))
  const rows: Value[] = []
  // the open array per list index; start with sinks so a chunk that opens mid-row (a preamble) is skipped
  const current: Value[][] = Array.from({ length: lists + 1 }, () => [])
  const n = rep ? rep.length : (def?.length ?? 0)
  let vi = 0

  for (let i = 0; i < n; i++) {
    const r = rep ? rep[i] : lists
    const d = def ? def[i] : 0
    const cut = d ? defMeaning[d] : null
    let parent = rows

    for (let k = layers.length - 1; k >= 0; k--) {
      const j = listIndex[k]

      if (j) {
        if (j > r) {
          parent = current[j] // continuing an open list
          continue
        }

        if (cut && cut.k === k) {
          parent.push(cut.what === 'null' ? null : [])
          break
        }

        if (cut && cut.k > k) break // masked by an outer null, already pushed

        const arr: Value[] = []
        parent.push(arr)
        current[j] = arr
        parent = arr
        continue
      }

      if (cut && cut.k === k) {
        // a null item (k == 0) or null struct; it consumes a value unless a list sits below it
        if (visibleBelow[k]) vi++
        parent.push(k === 0 ? null : STRUCT_NULL)
        break
      }

      if (k === 0) parent.push(values[vi++])
    }
  }

  return rows
}
