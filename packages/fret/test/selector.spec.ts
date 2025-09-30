import { describe, it } from 'mocha'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { chooseNextHop } from '../src/selector/next-hop.js'

function coordOf(n: number): Uint8Array {
  const u = new Uint8Array(32)
  u[31] = n & 0xff
  return u
}

describe('next hop selector', () => {
  it('prefers connected peer if within tolerance of best distance', () => {
    const s = new DigitreeStore()
    // target is near 200
    const target = coordOf(200)
    s.upsert('near-but-disconnected', coordOf(201))
    s.upsert('slightly-farther-connected', coordOf(205))
    const candidates = ['near-but-disconnected', 'slightly-farther-connected']
    const isConnected = (id: string) => id === 'slightly-farther-connected'
    const linkQ = (_id: string) => 0.5
    const chosen = chooseNextHop(s, target, candidates, isConnected, linkQ, 1)
    if (chosen !== 'slightly-farther-connected') throw new Error(`unexpected choice: ${chosen}`)
  })
})

