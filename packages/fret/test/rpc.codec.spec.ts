import { describe, it } from 'mocha'
import { encodeJson, decodeJson } from '../src/rpc/protocols.js'

describe('RPC codec round-trip', () => {
  it('neighbor snapshot roundtrip', async () => {
    const obj = { v: 1, from: 'peer', timestamp: Date.now(), successors: ['a'], predecessors: ['b'], sig: '' }
    const enc = await encodeJson(obj)
    const dec = await decodeJson(enc)
    if ((dec as any).from !== 'peer') throw new Error('mismatch')
  })

  it('maybeAct message roundtrip', async () => {
    const obj = { v: 1, key: 'AA', want_k: 3, ttl: 3, min_sigs: 2, correlation_id: 'xyz', timestamp: Date.now(), signature: '' }
    const enc = await encodeJson(obj)
    const dec = await decodeJson(enc)
    if ((dec as any).want_k !== 3) throw new Error('mismatch')
  })
})

