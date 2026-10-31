import { expect } from 'chai';
import type { AbortOptions, Peer, PeerData, PeerId } from '@libp2p/interface';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { throttleProtocolMerges, PROTOCOL_MERGE_INTERVAL_MS } from '../src/network/protocol-merge-throttle.js';

/** Counts what reaches the store; `merge` reads `this`, so a wrapper that drops it fails here. */
class CountingStore {
	readonly merged: Array<{ id: string, data: PeerData }> = [];

	async merge(id: PeerId, data: PeerData, _options?: AbortOptions): Promise<Peer> {
		this.merged.push({ id: id.toString(), data });
		return { id, protocols: [...(data.protocols ?? [])] } as unknown as Peer;
	}

	async delete(_id: PeerId, _options?: AbortOptions): Promise<void> {}
}

describe('protocol merge throttle', () => {
	let clock: number;
	let store: CountingStore;
	let peer: PeerId;

	beforeEach(async () => {
		clock = 1_000_000;
		store = new CountingStore();
		throttleProtocolMerges(store, { now: () => clock });
		peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
	});

	it('lets one per-stream merge per peer and protocol reach the store per interval', async () => {
		const first = await store.merge(peer, { protocols: ['/a/1.0.0'] });
		expect(store.merged, 'the first stream records its protocol').to.have.length(1);

		clock += PROTOCOL_MERGE_INTERVAL_MS - 1;
		expect(await store.merge(peer, { protocols: ['/a/1.0.0'] })).to.equal(first);
		expect(store.merged, 'a stream inside the interval does not reach the store').to.have.length(1);

		await store.merge(peer, { protocols: ['/b/1.0.0'] });
		expect(store.merged, 'another protocol has its own interval').to.have.length(2);

		clock += 1;
		await store.merge(peer, { protocols: ['/a/1.0.0'] });
		expect(store.merged, 'a stream after the interval reaches the store').to.have.length(3);
	});

	it('forgets a deleted peer, so its next stream re-creates the record', async () => {
		await store.merge(peer, { protocols: ['/a/1.0.0'] });
		await store.delete(peer);
		await store.merge(peer, { protocols: ['/a/1.0.0'] });
		expect(store.merged).to.have.length(2);
	});
});
