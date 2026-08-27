import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { openProtocolStream, isLimitedConnection } from '../src/network/open-protocol-stream.js';
import { requestResponse, sendOneWay } from '../src/cohort-topic/stream-util.js';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';

/**
 * Every stream-opening entry point in `db-p2p` must reach a peer that is only dialable through a
 * circuit relay — the normal case for a NAT'd or mobile peer. That needs three things libp2p does
 * not do by default: opt in with `runOnLimitedConnection: true`, skip connections libp2p has not
 * yet evicted from its index but that are no longer open, and prefer a direct connection over a
 * resettable relayed one.
 *
 * They all delegate to one `openProtocolStream`, but each is driven through the whole scenario set
 * so a future divergence fails here rather than in production. A new call site joins the sweep by
 * adding one row to `ENTRY_POINTS`.
 */
describe('openProtocolStream: connection selection across every entry point', () => {
	const PROTOCOL = '/test/1.0.0';
	const FRAME = new Uint8Array([1]);

	/** A stream that accepts a frame and yields one framed empty body (a lone `0x00` varint prefix),
	 * so `requestResponse`'s `readFramed` resolves with an empty reply rather than a truncation error. */
	function makeStream() {
		return {
			send: () => {},
			close: async () => {},
			[Symbol.asyncIterator]: async function* () {
				yield new Uint8Array([0x00]);
			},
		} as any;
	}

	interface ConnStub {
		status: string;
		remoteAddr: { toString: () => string };
		newStream: (protocols: string[], options?: any) => Promise<unknown>;
		opened: boolean;
		lastOptions?: any;
	}

	function makeConn(kind: 'direct' | 'limited', status = 'open'): ConnStub {
		const conn: ConnStub = {
			status,
			remoteAddr: { toString: () => (kind === 'limited' ? '/ip4/1.2.3.4/tcp/1/p2p-circuit' : '/ip4/1.2.3.4/tcp/1') },
			opened: false,
			newStream: (_protocols: string[], options?: any) => {
				conn.opened = true;
				conn.lastOptions = options;
				return Promise.resolve(makeStream());
			},
		};
		return conn;
	}

	/**
	 * A node whose fresh-dial path records its options, and fails loudly if not expected.
	 *
	 * Carries the event-listener surface `Libp2pKeyPeerNetwork`'s constructor touches, so one stub
	 * drives both the bare helper and the key network's `connect`. Deliberately has no `peerStore`:
	 * the self-relay pre-dial check then holds no addresses and dials, which is the condition every
	 * scenario below is written against.
	 */
	function makeNode(conns: ConnStub[], expectDial: boolean, selfPeerId: PeerId) {
		const state: { dialOptions?: any; dialed: boolean } = { dialed: false };
		const node = {
			peerId: selfPeerId,
			getConnections: () => conns,
			getMultiaddrs: () => [],
			addEventListener: () => {},
			removeEventListener: () => {},
			services: {},
			dialProtocol: (_peer: unknown, _protocols: string[], options?: any) => {
				if (!expectDial) throw new Error('should not dial fresh when a reusable connection exists');
				state.dialed = true;
				state.dialOptions = options;
				return Promise.resolve(makeStream());
			},
		} as any;
		return { node, state };
	}

	let peerId: PeerId;
	let selfPeerId: PeerId;
	beforeEach(async () => {
		peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		selfPeerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
	});

	/** Every entry point that opens a protocol stream. Add a row when a new one appears. */
	const ENTRY_POINTS: Array<[string, (node: any, peer: PeerId) => Promise<unknown>]> = [
		['openProtocolStream', (node, peer) => openProtocolStream(node, peer, PROTOCOL)],
		['cohort-topic requestResponse', (node, peer) => requestResponse(node, peer, PROTOCOL, FRAME)],
		['cohort-topic sendOneWay', (node, peer) => sendOneWay(node, peer, PROTOCOL, FRAME)],
		[
			'Libp2pKeyPeerNetwork.connect',
			(node, peer) => new Libp2pKeyPeerNetwork(node, 16, undefined, 'forming').connect(peer, PROTOCOL),
		],
	];

	for (const [name, call] of ENTRY_POINTS) {
		describe(name, () => {
			it('opts in to limited connections when reusing an existing connection', async () => {
				const conn = makeConn('direct');
				const { node } = makeNode([conn], false, selfPeerId);

				await call(node, peerId);

				expect(conn.lastOptions).to.deep.include({ runOnLimitedConnection: true });
			});

			it('opts in to limited connections when dialing fresh', async () => {
				const { node, state } = makeNode([], true, selfPeerId);

				await call(node, peerId);

				expect(state.dialed).to.equal(true);
				expect(state.dialOptions).to.deep.include({ runOnLimitedConnection: true });
			});

			it('uses the relayed connection when it is the only open path', async () => {
				const relayed = makeConn('limited');
				const { node } = makeNode([relayed], false, selfPeerId);

				await call(node, peerId);

				expect(relayed.opened).to.equal(true);
				expect(relayed.lastOptions).to.deep.include({ runOnLimitedConnection: true });
			});

			it('prefers a direct connection over a relayed one', async () => {
				const relayed = makeConn('limited');
				const direct = makeConn('direct');
				const { node } = makeNode([relayed, direct], false, selfPeerId);

				await call(node, peerId);

				expect(direct.opened).to.equal(true);
				expect(relayed.opened).to.equal(false);
			});

			it('skips a connection libp2p has not yet evicted but that is no longer open', async () => {
				const closing = makeConn('direct', 'closing');
				const healthy = makeConn('direct');
				const { node } = makeNode([closing, healthy], false, selfPeerId);

				await call(node, peerId);

				expect(healthy.opened).to.equal(true);
				expect(closing.opened).to.equal(false);
			});

			it('dials fresh when every indexed connection is closed', async () => {
				const closed = makeConn('direct', 'closed');
				const { node, state } = makeNode([closed], true, selfPeerId);

				await call(node, peerId);

				expect(state.dialed).to.equal(true);
				expect(closed.opened).to.equal(false);
			});
		});
	}

	// --- Behaviour only the helper itself exposes ------------------------------------------
	describe('option construction', () => {
		it('omits `negotiateFully` entirely when the caller does not pass it', async () => {
			const conn = makeConn('direct');
			const { node } = makeNode([conn], false, selfPeerId);

			await openProtocolStream(node, peerId, PROTOCOL);

			// Present-and-`undefined` is not the same as absent: libp2p reads the key, so an
			// explicit `undefined` would suppress the default this omission is choosing.
			expect(conn.lastOptions).to.not.have.property('negotiateFully');
		});

		it('forwards `negotiateFully: false` when the caller passes it', async () => {
			const conn = makeConn('direct');
			const { node } = makeNode([conn], false, selfPeerId);

			await openProtocolStream(node, peerId, PROTOCOL, { negotiateFully: false });

			expect(conn.lastOptions).to.have.property('negotiateFully', false);
		});

		it('omits `signal` entirely when the caller does not pass one', async () => {
			const conn = makeConn('direct');
			const { node } = makeNode([conn], false, selfPeerId);

			await openProtocolStream(node, peerId, PROTOCOL);

			expect(conn.lastOptions).to.not.have.property('signal');
		});

		it('forwards `signal` on the reuse path', async () => {
			const conn = makeConn('direct');
			const { node } = makeNode([conn], false, selfPeerId);
			const controller = new AbortController();

			await openProtocolStream(node, peerId, PROTOCOL, { signal: controller.signal });

			expect(conn.lastOptions?.signal).to.equal(controller.signal);
		});

		it('forwards `signal` on the dial path', async () => {
			const { node, state } = makeNode([], true, selfPeerId);
			const controller = new AbortController();

			await openProtocolStream(node, peerId, PROTOCOL, { signal: controller.signal });

			expect(state.dialOptions?.signal).to.equal(controller.signal);
		});

		it('treats a node with no `getConnections` at all as holding none, and dials', async () => {
			const { node, state } = makeNode([], true, selfPeerId);
			delete node.getConnections;

			await openProtocolStream(node, peerId, PROTOCOL);

			expect(state.dialed).to.equal(true);
		});

		it('skips a connection entry whose `newStream` is not callable', async () => {
			const healthy = makeConn('direct');
			const halfTornDown = { status: 'open', remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1' } } as any;
			const { node } = makeNode([halfTornDown, healthy], false, selfPeerId);

			await openProtocolStream(node, peerId, PROTOCOL);

			expect(healthy.opened).to.equal(true);
		});
	});

	describe('cancellation', () => {
		it('throws the signal reason before selecting a connection or dialing', async () => {
			const conn = makeConn('direct');
			const { node } = makeNode([conn], false, selfPeerId);
			const reason = new Error('caller gave up');
			const controller = new AbortController();
			controller.abort(reason);
			let beforeDialCalls = 0;

			const err = await openProtocolStream(node, peerId, PROTOCOL, {
				signal: controller.signal,
				beforeDial: () => { beforeDialCalls++; },
			}).then(() => undefined, (e: unknown) => e);

			expect(err, 'the caller is owed ITS reason, not a failure from deeper in libp2p').to.equal(reason);
			expect(conn.opened, 'nothing may be opened once the caller has given up').to.equal(false);
			expect(beforeDialCalls).to.equal(0);
		});
	});

	describe('beforeDial', () => {
		it('runs exactly once, immediately before a fresh dial', async () => {
			const order: string[] = [];
			const { node, state } = makeNode([], true, selfPeerId);
			const dialProtocol = node.dialProtocol;
			node.dialProtocol = (...args: any[]) => { order.push('dial'); return dialProtocol(...args); };

			await openProtocolStream(node, peerId, PROTOCOL, { beforeDial: () => { order.push('beforeDial'); } });

			expect(order).to.deep.equal(['beforeDial', 'dial']);
			expect(state.dialed).to.equal(true);
		});

		it('never runs when an existing connection is reused', async () => {
			// The warm path is the case this helper exists to make cheap; a pre-dial check
			// (`assertNotSelfRelayOnly` costs a `peerStore.get`) must not intrude on it.
			let calls = 0;
			const conn = makeConn('direct');
			const { node } = makeNode([conn], false, selfPeerId);

			await openProtocolStream(node, peerId, PROTOCOL, { beforeDial: () => { calls++; } });

			expect(calls).to.equal(0);
			expect(conn.opened).to.equal(true);
		});

		it('propagates a throw and never dials', async () => {
			const { node, state } = makeNode([], false, selfPeerId);
			const refusal = new Error('every address routes back through us');

			const err = await openProtocolStream(node, peerId, PROTOCOL, {
				beforeDial: () => { throw refusal; },
			}).then(() => undefined, (e: unknown) => e);

			expect(err).to.equal(refusal);
			expect(state.dialed).to.equal(false);
		});
	});

	describe('isLimitedConnection', () => {
		it('detects a relayed connection by the `limits` stamp libp2p puts on one', () => {
			const conn = { limits: { bytes: 128n * 1024n }, remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1' } } as any;
			expect(isLimitedConnection(conn)).to.equal(true);
		});

		it('detects a relayed connection by `/p2p-circuit` when `limits` is unpopulated', () => {
			const conn = { remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1/p2p-circuit/p2p/QmTarget' } } as any;
			expect(isLimitedConnection(conn)).to.equal(true);
		});

		it('reports a direct connection as not limited', () => {
			const conn = { remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/1' } } as any;
			expect(isLimitedConnection(conn)).to.equal(false);
		});

		it('reports a connection with no `remoteAddr` as not limited', () => {
			expect(isLimitedConnection({} as any)).to.equal(false);
		});
	});
});
