import { describe, it } from 'mocha'
import * as fc from 'fast-check'
import { DigitreeStore } from '../src/store/digitree-store.js'

function coordOf(n: number): Uint8Array {
  const u = new Uint8Array(32)
  u[31] = n & 0xff
  u[30] = (n >>> 8) & 0xff
  return u
}

describe('DigitreeStore neighbors', () => {
  it('neighborsRight wraps around and yields unique ids', () => {
    const s = new DigitreeStore()
    for (let i = 0; i < 5; i++) s.upsert(`p${i}`, coordOf(i * 10))
    const ids = s.neighborsRight(coordOf(200), 7)
    const set = new Set(ids)
    if (ids.length !== set.size) throw new Error('duplicates')
    if (ids.length !== 5) throw new Error('should cap at size')
  })

  it('neighborsLeft wraps around from start', () => {
    const s = new DigitreeStore()
    for (let i = 0; i < 3; i++) s.upsert(`p${i}`, coordOf(i * 50))
    const ids = s.neighborsLeft(coordOf(1), 4)
    if (ids.length !== 3) throw new Error('should return all')
  })

  it('successor and predecessor are consistent with ordering', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 3, maxLength: 20 }), async (vals) => {
        const s = new DigitreeStore()
        for (let i = 0; i < vals.length; i++) s.upsert(`p${i}`, coordOf(vals[i]!))
        const probe = coordOf(500)
        const succ = s.successorOfCoord(probe)
        const pred = s.predecessorOfCoord(probe)
        if (!succ || !pred) return false
        // succ should be in neighborsRight first slot; pred in neighborsLeft first slot
        const right = s.neighborsRight(probe, 1)[0]
        const left = s.neighborsLeft(probe, 1)[0]
        return succ.id === right && pred.id === left
      })
    )
  })
})

