import { expect } from 'chai';
import type { FretService } from 'p2p-fret';
import { ArachnodeFretAdapter, type ArachnodeInfo } from '../src/storage/arachnode-fret-adapter.js';

/** An adapter over a FRET whose `listPeers` answers these peers; the adapter reads nothing else here. */
function adapterOver(peers: Array<{ id: string; metadata?: Record<string, unknown> }>): ArachnodeFretAdapter {
	return new ArachnodeFretAdapter({ listPeers: () => peers } as unknown as FretService);
}

/** A peer advertising `info` under the key the adapter stores its own metadata at. */
function peer(id: string, info: ArachnodeInfo): { id: string; metadata: Record<string, unknown> } {
	return { id, metadata: { arachnode: info } };
}

describe('ArachnodeFretAdapter.getRingStats', () => {
	it('leaves a peer that advertises no capacity out of both the count and the average', () => {
		const stats = adapterOver([
			peer('a', { ringDepth: 0, capacity: { total: 200, used: 0, available: 200 }, status: 'active' }),
			peer('b', { ringDepth: 0, capacity: { total: 100, used: 0, available: 100 }, status: 'active' }),
			// Cannot measure its storage, so it claims nothing. Counting it as a peer offering 0
			// would halve the ring's average and silently understate what the network can hold.
			peer('c', { ringDepth: 0, status: 'active' })
		]).getRingStats();

		expect(stats).to.deep.equal([{ ringDepth: 0, peerCount: 2, avgCapacity: 150 }]);
	});

	it('yields no stat for a ring where nobody advertised capacity', () => {
		// Not a ring with avgCapacity 0, which `RingSelector.estimateNetworkData` would read as real
		// demand; no stat at all, which falls through to its bootstrap estimate.
		expect(adapterOver([peer('a', { ringDepth: 3, status: 'active' })]).getRingStats()).to.deep.equal([]);
	});
});
