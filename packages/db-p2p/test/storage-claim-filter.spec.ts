/**
 * A peer that only sends this node storage requests is not recorded as serving storage
 * (`src/network/storage-claim-filter.ts`).
 *
 * Two real libp2p nodes over loopback TCP, each running identify and the storage-claim filter. The
 * listener serves this network's `repo` protocol; the dialer registers no storage protocol and sends
 * requests on the listener's. libp2p merges each stream's protocol into the remote peer's peerStore
 * record on both ends (`libp2p-merges-protocol-per-stream.spec.ts`), so without the filter the
 * listener's record of the dialer names `repo` after the first request, and the key network
 * classifies the dialer as serving. Identify settles on both ends before the first stream, so a later
 * identify patch cannot erase the merge and hide that.
 */
import { expect } from 'chai';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import type { PeerId } from '@libp2p/interface';
import { openProtocolStream } from '../src/network/open-protocol-stream.js';
import { registerProtocolHandler } from '../src/network/register-protocol-handler.js';
import { filterStorageClaimMerges } from '../src/network/storage-claim-filter.js';
import { storageServingProtocols } from '../src/network/storage-protocols.js';

/** Distinct per spec: the identify protocol ids are network-scoped, so a shared name lets specs cross-talk. */
const NETWORK = 'storage-claim-filter-spec';
const PREFIX = `/optimystic/${NETWORK}`;
const [REPO] = storageServingProtocols(PREFIX);
/** Not a storage protocol, so the filter lets its merge through. */
const OTHER = `${PREFIX}/sync/1.0.0`;
const STREAMS = 2;

async function spawnNode(): Promise<Libp2p> {
	const node = await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		// Slash-less: @libp2p/identify prepends the slash itself, as in `libp2p-node-base.ts`.
		services: { identify: identify({ protocolPrefix: `optimystic/${NETWORK}` }) }
	});
	filterStorageClaimMerges(node.peerStore, node.peerId, PREFIX);
	return node;
}

function identified(node: Libp2p, remote: PeerId): Promise<void> {
	return new Promise(resolve => {
		const onIdentify = (event: CustomEvent<{ peerId: PeerId }>): void => {
			if (!event.detail.peerId.equals(remote)) return;
			node.removeEventListener('peer:identify', onIdentify);
			resolve();
		};
		node.addEventListener('peer:identify', onIdentify);
	});
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for the listener to handle every stream');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

async function protocolsOf(node: Libp2p, peer: PeerId): Promise<string[]> {
	return (await node.peerStore.get(peer)).protocols;
}

describe('storage-claim filter', function () {
	this.timeout(20_000);

	let dialer: Libp2p;
	let listener: Libp2p;

	before(async () => {
		dialer = await spawnNode();
		listener = await spawnNode();
	});

	after(async () => {
		await dialer?.stop();
		await listener?.stop();
	});

	it('records a requester\'s storage protocol only from its own identify', async () => {
		let handled = 0;
		for (const protocol of [REPO, OTHER]) {
			await registerProtocolHandler(listener, protocol, async stream => {
				handled++;
				await stream.close();
			});
		}
		expect(await protocolsOf(listener, listener.peerId), 'a merge into self passes through, so identify advertises it')
			.to.include(REPO);

		const bothIdentified = Promise.all([identified(dialer, listener.peerId), identified(listener, dialer.peerId)]);
		await dialer.dial(listener.getMultiaddrs()[0]!, { signal: AbortSignal.timeout(10_000) });
		await bothIdentified;

		for (let i = 0; i < STREAMS; i++) {
			for (const protocol of [REPO, OTHER]) {
				const stream = await openProtocolStream(dialer, listener.peerId, protocol, { signal: AbortSignal.timeout(10_000) });
				await stream.close();
			}
		}
		// The answering end merges before it runs the handler, so every handled stream has merged.
		await waitFor(() => handled === STREAMS * 2, 10_000);

		const dialerAtListener = await protocolsOf(listener, dialer.peerId);
		expect(dialerAtListener, 'the requester is not recorded as serving storage').to.not.include(REPO);
		expect(dialerAtListener, 'other protocols are still recorded per stream').to.include(OTHER);
		expect(await protocolsOf(dialer, listener.peerId), 'the server\'s own identify still records it serving')
			.to.include(REPO);
	});
});
