import { expect } from 'chai'
import { routingKeyForBlob, routingKeyForBlock } from '../src/network/routing-key.js'
import { cidOfPiece, parseBlobRef, rootPieceId } from '../src/index.js'
import type { ClusterPeers, IKeyNetwork, PeerId } from '../src/index.js'

describe('routingKeyForBlock', () => {
	it('is the raw utf8 of the block id, never a digest of it', () => {
		const id = 'Zm9vYmFyYmF6-block_id'
		expect([...routingKeyForBlock(id)]).to.deep.equal([...new TextEncoder().encode(id)])
		expect([...routingKeyForBlock('é')], 'non-ASCII ids are utf8-encoded').to.deep.equal([0xc3, 0xa9])
	})

	// The brand is the invariant: `tsc` type-checks this file (db-core's tsconfig includes `test`), so if a
	// bare byte array ever type-checks as a key network argument again, the `@ts-expect-error` lines fail the build.
	it('is the only byte array the key network accepts', async () => {
		const seen: Uint8Array[] = []
		const net: IKeyNetwork = {
			async findCoordinator(key) { seen.push(key); return undefined as unknown as PeerId },
			async findCluster(key): Promise<ClusterPeers> { seen.push(key); return {} },
		}
		await net.findCluster(routingKeyForBlock('block-1'))
		// @ts-expect-error hand-encoded bytes are not a routing key
		await net.findCluster(new TextEncoder().encode('block-1'))
		// @ts-expect-error a pre-hashed digest is not a routing key
		await net.findCoordinator(new Uint8Array(32))
		expect(seen).to.have.length(3)
	})
})

describe('routingKeyForBlob', () => {
	it('is the 32-byte digest inside the reference, not hashed again', () => {
		const ref = parseBlobRef('bafybeiexg2oqkfnj56l7fcmawswqbijt5shq4b5rg6a546uwpkqqzwjioi')
		const key = routingKeyForBlob(ref)
		expect(key.byteLength).to.equal(32)
		expect([...key]).to.deep.equal([...cidOfPiece(rootPieceId(ref)).multihash.digest])
	})
})
