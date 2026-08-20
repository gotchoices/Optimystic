import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { MockNode, waitFor } from '../../src/testing/cohort-topic-mesh-harness.js';
import { handleRequestResponse, requestResponse, sendOneWay } from '../../src/cohort-topic/stream-util.js';
import { registerPushStateGossipHandler } from '../../src/reactivity/push-state-gossip.js';

/**
 * The two halves of the stream framing must agree, and "no result" must be representable.
 *
 * `readFramed` treats end-of-stream before a whole frame as a truncation error, so a handler that
 * simply closes without writing is no longer a valid way to say "nothing to report" — the dialer
 * would see a failure instead. `handleRequestResponse` therefore replies with an explicit
 * zero-length frame. That contract is what every consumer's "no result" branch rests on
 * (`membership-source.fetch` checks `reply.length > 0`, the matchmaking seeker maps an empty frame
 * to an empty advisory reply), so it is pinned here rather than only in the gated real-libp2p
 * integration suite.
 */
describe('cohort-topic: stream-util framing round trip', () => {
	const PROTOCOL = '/test/framing/1.0.0';

	/** Two in-process nodes on one registry, so a real dial drives the other's real handler. */
	async function makePair(): Promise<{ client: MockNode; server: MockNode; serverPeer: PeerId }> {
		const registry = new Map<string, MockNode>();
		const down = new Set<string>();
		const keys = await Promise.all([generateKeyPair('Ed25519'), generateKeyPair('Ed25519')]);
		const [client, server] = keys.map(k => new MockNode(peerIdFromPrivateKey(k), registry, down)) as [MockNode, MockNode];
		for (const node of [client, server]) {
			registry.set(node.peerId.toString(), node);
		}
		return { client, server, serverPeer: server.peerId };
	}

	it('carries a request and its reply verbatim through both framing halves', async () => {
		const { client, server, serverPeer } = await makePair();
		const request = new Uint8Array([1, 2, 3, 0, 255]);
		let seen: Uint8Array | undefined;
		let seenFrom: string | undefined;
		handleRequestResponse(server as never, PROTOCOL, (frame, from) => {
			seen = frame;
			seenFrom = from.toString();
			return Promise.resolve(new Uint8Array([...frame].reverse()));
		});

		const reply = await requestResponse(client as never, serverPeer, PROTOCOL, request);

		expect([...seen!], 'the handler read exactly the bytes the dialer framed').to.deep.equal([...request]);
		expect(seenFrom, 'the handler attributes the frame to the dialing peer').to.equal(client.peerId.toString());
		expect([...reply], 'the dialer read exactly the bytes the handler framed').to.deep.equal([...request].reverse());
	});

	it('an empty request frame survives the round trip (0x00 prefix, no body)', async () => {
		const { client, server, serverPeer } = await makePair();
		let seenLength: number | undefined;
		handleRequestResponse(server as never, PROTOCOL, frame => {
			seenLength = frame.length;
			return Promise.resolve(new Uint8Array(0));
		});

		const reply = await requestResponse(client as never, serverPeer, PROTOCOL, new Uint8Array(0));

		expect(seenLength, 'an empty body reads back as empty, not as a truncated stream').to.equal(0);
		expect(reply.length).to.equal(0);
	});

	it('a handler returning undefined resolves the dialer with empty bytes, not a truncation error', async () => {
		const { client, server, serverPeer } = await makePair();
		handleRequestResponse(server as never, PROTOCOL, () => Promise.resolve(undefined));

		const reply = await requestResponse(client as never, serverPeer, PROTOCOL, new Uint8Array([7]));

		expect(reply, 'no-result travels in-band as a zero-length frame').to.be.instanceOf(Uint8Array);
		expect(reply.length).to.equal(0);
	});

	it('a handler that throws aborts the stream, and the dialer sees a truncation error', async () => {
		const { client, server, serverPeer } = await makePair();
		handleRequestResponse(server as never, PROTOCOL, () => Promise.reject(new Error('serve exploded')));

		const err = await requestResponse(client as never, serverPeer, PROTOCOL, new Uint8Array([7]))
			.then(() => undefined, (e: unknown) => e as Error);

		expect(err?.name, 'a genuine failure stays distinguishable from an empty reply').to.equal('FrameTruncationError');
	});

	it('rejects an over-ceiling reply at its length prefix', async () => {
		const { client, server, serverPeer } = await makePair();
		handleRequestResponse(server as never, PROTOCOL, () => Promise.resolve(new Uint8Array(64)));

		const err = await requestResponse(client as never, serverPeer, PROTOCOL, new Uint8Array([7]), 4)
			.then(() => undefined, (e: unknown) => e as Error);

		expect(err?.name).to.equal('PayloadTooLargeError');
	});

	/**
	 * The one-way seam has no reply to prove the framing agreed, so it is asserted from the
	 * receiving driver instead. `push-state-gossip` is the arm of it with no other stream-level
	 * coverage; `notify-transport` covers the sibling arm in its own spec.
	 */
	it('sendOneWay delivers the exact frame to a push-state-gossip handler', async () => {
		const { client, server, serverPeer } = await makePair();
		const frame = new Uint8Array([9, 8, 7, 0, 0, 6]);
		const delivered: Array<{ from: string; frame: Uint8Array }> = [];
		registerPushStateGossipHandler(server as never, PROTOCOL, { deliver: (from, f) => { delivered.push({ from, frame: f }); } });

		await sendOneWay(client as never, serverPeer, PROTOCOL, frame);
		await waitFor(() => delivered.length === 1);

		expect(delivered, 'the one-way frame arrived exactly once').to.have.length(1);
		expect(delivered[0]!.from).to.equal(client.peerId.toString());
		expect([...delivered[0]!.frame], 'the receiver unframed exactly what the sender framed').to.deep.equal([...frame]);
	});
});
