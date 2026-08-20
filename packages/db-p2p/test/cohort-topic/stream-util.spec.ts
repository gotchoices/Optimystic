import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { requestResponse, sendOneWay } from '../../src/cohort-topic/stream-util.js';

/**
 * `stream-util` must reach a peer that is only dialable through a circuit relay — the normal case
 * for a NAT'd or mobile cohort member. That requires three things libp2p does not do by default:
 * opt in with `runOnLimitedConnection: true`, skip connections libp2p has not yet evicted but that
 * are no longer open, and prefer a direct connection over a resettable relayed one.
 *
 * Both helpers share one `openStream`, but each is exercised on each path so a future divergence
 * between them fails here rather than in production.
 */
describe('cohort-topic: stream-util connection selection', () => {
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

	/** A node whose fresh-dial path records its options, and fails loudly if not expected. */
	function makeNode(conns: ConnStub[], expectDial: boolean) {
		const state: { dialOptions?: any; dialed: boolean } = { dialed: false };
		const node = {
			getConnections: () => conns,
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
	beforeEach(async () => {
		peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
	});

	/** Drives each helper through the same scenario, so neither can regress independently. */
	const HELPERS: Array<[string, (node: any, peer: PeerId) => Promise<unknown>]> = [
		['requestResponse', (node, peer) => requestResponse(node, peer, PROTOCOL, FRAME)],
		['sendOneWay', (node, peer) => sendOneWay(node, peer, PROTOCOL, FRAME)],
	];

	for (const [name, call] of HELPERS) {
		describe(name, () => {
			it('opts in to limited connections when reusing an existing connection', async () => {
				const conn = makeConn('direct');
				const { node } = makeNode([conn], false);

				await call(node, peerId);

				expect(conn.lastOptions).to.deep.include({ runOnLimitedConnection: true });
			});

			it('opts in to limited connections when dialing fresh', async () => {
				const { node, state } = makeNode([], true);

				await call(node, peerId);

				expect(state.dialed).to.equal(true);
				expect(state.dialOptions).to.deep.include({ runOnLimitedConnection: true });
			});

			it('uses the relayed connection when it is the only open path', async () => {
				const relayed = makeConn('limited');
				const { node } = makeNode([relayed], false);

				await call(node, peerId);

				expect(relayed.opened).to.equal(true);
				expect(relayed.lastOptions).to.deep.include({ runOnLimitedConnection: true });
			});

			it('prefers a direct connection over a relayed one', async () => {
				const relayed = makeConn('limited');
				const direct = makeConn('direct');
				const { node } = makeNode([relayed, direct], false);

				await call(node, peerId);

				expect(direct.opened).to.equal(true);
				expect(relayed.opened).to.equal(false);
			});

			it('skips a connection libp2p has not yet evicted but that is no longer open', async () => {
				const closing = makeConn('direct', 'closing');
				const healthy = makeConn('direct');
				const { node } = makeNode([closing, healthy], false);

				await call(node, peerId);

				expect(healthy.opened).to.equal(true);
				expect(closing.opened).to.equal(false);
			});

			it('dials fresh when every indexed connection is closed', async () => {
				const closed = makeConn('direct', 'closed');
				const { node, state } = makeNode([closed], true);

				await call(node, peerId);

				expect(state.dialed).to.equal(true);
				expect(closed.opened).to.equal(false);
			});
		});
	}
});
