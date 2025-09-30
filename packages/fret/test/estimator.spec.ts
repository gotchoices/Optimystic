import { describe, it } from 'mocha'
import { DigitreeStore } from '../src/store/digitree-store.js'
import { estimateSizeAndConfidence } from '../src/estimate/size-estimator.js'

function coordOfBigInt(v: bigint): Uint8Array {
  const u = new Uint8Array(32)
  let x = v
  for (let i = 31; i >= 0; i--) { u[i] = Number(x & 0xffn); x >>= 8n }
  return u
}

describe('size estimator', () => {
  it('estimates n close to count for uniformly spaced peers', () => {
    const s = new DigitreeStore()
    const n = 16
    const ring = 1n << 256n
    const step = ring / BigInt(n)
    for (let i = 0; i < n; i++) s.upsert(`p${i}`, coordOfBigInt(BigInt(i) * step))
    const { n: est, confidence } = estimateSizeAndConfidence(s, 8)
    if (Math.abs(est - n) > Math.ceil(n * 0.25)) throw new Error(`n estimate off: ${est}`)
    if (confidence <= 0) throw new Error('confidence should be positive')
  })
})

