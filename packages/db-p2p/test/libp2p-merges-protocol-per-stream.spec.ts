/**
 * The libp2p-level premise behind `src/network/protocol-merge-throttle.ts`, pinned as an executable
 * fact: libp2p merges a stream's protocol into the remote peer's peerStore record on EVERY stream, on
 * both ends, through `peerStore.merge(remotePeer, { protocols: [protocol] })`.
 *
 * Two plain libp2p nodes over loopback TCP open two streams of one protocol, with each node's
 * `peerStore.merge` wrapped to record what it is called with. No throttle is installed.
 *
 * It fails in two ways, and each says what to do:
 * - **Fewer merges than streams**: the libp2p release carrying libp2p/js-libp2p#3692, which merges
 *   each protocol once per connection, has landed. Delete `protocol-merge-throttle.ts` and its
 *   installation in `createLibp2pNodeBase`, then this spec.
 * - **The merges are not in the shape `isProtocolOnlyMerge` matches, or go somewhere other than
 *   `peerStore.merge`**: libp2p moved the call, so the throttle no longer intercepts it and the
 *   per-stream cost is back. Re-aim the throttle at the new call, or delete it if the cost went with it.
 *
 * The counterpart for third-party address learning is `relay-third-party-address-gap.spec.ts`.
 */
import { expect } from 'chai';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import type { PeerData } from '@libp2p/interface';
import { openProtocolStream } from '../src/network/open-protocol-stream.js';
import { registerProtocolHandler } from '../src/network/register-protocol-handler.js';
import { isProtocolOnlyMerge } from '../src/network/protocol-merge-throttle.js';

const PROTOCOL = '/optimystic-test/merge-per-stream/1.0.0';
const STREAMS = 2;

async function spawnNode(): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()]
	});
}

/** Every merge `node`'s peerStore receives that names {@link PROTOCOL}, in the order received. */
function recordProtocolMerges(node: Libp2p): PeerData[] {
	const seen: PeerData[] = [];
	const merge = node.peerStore.merge;
	node.peerStore.merge = async (id, data, options) => {
		if (data.protocols?.includes(PROTOCOL) === true) seen.push(data);
		return await merge.call(node.peerStore, id, data, options);
	};
	return seen;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for the listener to handle every stream');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

describe('libp2p merges a stream\'s protocol into the peerStore on every stream', function () {
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

	it('once per stream on each end, in the shape the throttle intercepts', async () => {
		let handled = 0;
		await registerProtocolHandler(listener, PROTOCOL, async stream => {
			handled++;
			await stream.close();
		});
		const dialerMerges = recordProtocolMerges(dialer);
		const listenerMerges = recordProtocolMerges(listener);

		await dialer.dial(listener.getMultiaddrs()[0]!, { signal: AbortSignal.timeout(10_000) });
		for (let i = 0; i < STREAMS; i++) {
			const stream = await openProtocolStream(dialer, listener.peerId, PROTOCOL, { signal: AbortSignal.timeout(10_000) });
			await stream.close();
		}
		// The answering end merges before it runs the handler, so every handled stream has merged.
		await waitFor(() => handled === STREAMS, 10_000);

		expect(dialerMerges, 'dialer: one merge per stream').to.have.length(STREAMS);
		expect(listenerMerges, 'listener: one merge per stream').to.have.length(STREAMS);
		for (const data of [...dialerMerges, ...listenerMerges]) {
			expect(isProtocolOnlyMerge(data), `throttle predicate matches ${JSON.stringify(data)}`).to.equal(true);
		}
	});
});
