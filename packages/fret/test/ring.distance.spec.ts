import { describe, it } from 'mocha'
import * as fc from 'fast-check'
import { xorDistance, lexLess, clockwiseDistance } from '../src/ring/distance.js'

function padTo32(u8: Uint8Array): Uint8Array {
  if (u8.length === 32) return u8
  const out = new Uint8Array(32)
  out.set(u8, 32 - u8.length)
  return out
}

describe('ring distance properties', () => {
  it('xorDistance is symmetric and zero iff equal', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 32 }), fc.uint8Array({ minLength: 1, maxLength: 32 }), async (a, b) => {
        const aa = padTo32(a)
        const bb = padTo32(b)
        const dab = xorDistance(aa, bb)
        const dba = xorDistance(bb, aa)
        // symmetry
        for (let i = 0; i < 32; i++) if (dab[i] !== dba[i]) return false
        // zero distance iff equal
        let zero = true
        for (let i = 0; i < 32; i++) if (dab[i] !== 0) { zero = false; break }
        const eq = aa.every((v, i) => v === bb[i])
        return zero === eq
      })
    )
  })

  it('lexLess provides a total preorder consistent with byte order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        async (a, b, c) => {
          // antisymmetry-like: if a < b then not b < a
          const ab = lexLess(a, b)
          const ba = lexLess(b, a)
          if (ab && ba) return false
          // transitivity-ish: if a < b and b < c then a < c
          const bc = lexLess(b, c)
          const ac = lexLess(a, c)
          if (ab && bc && !ac) return false
          return true
        }
      )
    )
  })

  it('clockwiseDistance(a,a) is zero', () => {
    const a = new Uint8Array(32)
    a[0] = 1
    const d = clockwiseDistance(a, a)
    for (let i = 0; i < 32; i++) if (d[i] !== 0) throw new Error('non-zero')
  })
})

