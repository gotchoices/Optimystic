import { describe, it } from 'mocha'
import { createMemoryNode } from './helpers/libp2p.js'
import { registerMaybeAct } from '../src/rpc/maybe-act.js'
import { PROTOCOL_MAYBE_ACT } from '../src/rpc/protocols.js'

describe('RPC codec fuzzing (maybeAct)', function () {
	this.timeout(10000)

	it('malformed payload does not crash handler', async () => {
		const a = await createMemoryNode(); await a.start()
		registerMaybeAct(a, async (_msg: any) => ({ v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 1, confidence: 0 }))
		const b = await createMemoryNode(); await b.start(); await b.dial(a.getMultiaddrs()[0]!)
		// send malformed payload
		const conn = await (b as any).dialProtocol(a.peerId, [PROTOCOL_MAYBE_ACT])
		const stream = conn.stream ?? conn
		await stream.sink((async function*(){ yield new TextEncoder().encode('{ not: json }') })())
		// read or timeout after short delay then close
		const timer = setTimeout(() => { try { stream.abort?.() } catch {} }, 500)
		try { for await (const _ of stream.source) break } catch {}
		clearTimeout(timer)
		await b.stop(); await a.stop()
	})
})


