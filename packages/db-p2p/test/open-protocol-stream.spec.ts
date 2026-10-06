import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { openProtocolStream, isLimitedConnection, DeadConnectionError, DEAD_CONNECTION_ERROR_CODE, type StreamOpenLog } from '../src/network/open-protocol-stream.js';
import { requestResponse, sendOneWay } from '../src/cohort-topic/stream-util.js';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
 *
 * The helper's own branching — the hedge across connections and onto a fresh dial, and the
 * condemnation of a connection whose open never answers (GitHub #32) — is covered below over the
 * same stubs with short injected delays; `half-open-connection-does-not-strand-a-peer.spec.ts`
 * covers the real-libp2p shape.
 */
describe('openProtocolStream: connection selection across every entry point', () => {
	const PROTOCOL = '/test/1.0.0';
	const FRAME = new Uint8Array([1]);

	interface StreamStub {
		closes: number;
		send(): void;
		close(): Promise<void>;
		[Symbol.asyncIterator](): AsyncGenerator<Uint8Array>;
	}

	/** A stream that accepts a frame and yields one framed empty body (a lone `0x00` varint prefix),
	 * so `requestResponse` resolves a no-result reply (`undefined`) rather than a truncation error. */
	function makeStream(): StreamStub {
		const stream: StreamStub = {
			closes: 0,
			send: () => {},
			close: async () => { stream.closes++; },
			[Symbol.asyncIterator]: async function* () {
				yield new Uint8Array([0x00]);
			},
		};
		return stream;
	}

	/**
	 * How a stub's `newStream` / `dialProtocol` answers. A hang ends only when the signal it was handed
	 * aborts, which is how libp2p's own negotiation behaves on a half-open connection.
	 */
	type Behaviour = 'opens' | 'hangs' | { opensAfterMs: number } | { rejectsWith: Error };

	function behave(behaviour: Behaviour, options: { signal?: AbortSignal } | undefined, stream: StreamStub): Promise<StreamStub> {
		if (behaviour === 'opens') return Promise.resolve(stream);
		if (behaviour === 'hangs') {
			return new Promise((_resolve, reject) => {
				const signal = options?.signal;
				if (signal === undefined) return;
				if (signal.aborted) reject(signal.reason);
				else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
			});
		}
		if ('rejectsWith' in behaviour) return Promise.reject(behaviour.rejectsWith);
		return sleep(behaviour.opensAfterMs).then(() => stream);
	}

	interface ConnStub {
		id: string;
		status: string;
		direction: 'inbound' | 'outbound';
		timeline: { open: number };
		remoteAddr: { toString: () => string };
		newStream: (protocols: string[], options?: any) => Promise<unknown>;
		abort: (err: Error) => void;
		opened: boolean;
		aborts: Error[];
		streams: StreamStub[];
		lastOptions?: any;
	}

	let nextConnId = 0;
	function makeConn(kind: 'direct' | 'limited', status = 'open', behaviour: Behaviour = 'opens', openedAt = 0): ConnStub {
		const conn: ConnStub = {
			id: `conn-${++nextConnId}`,
			status,
			direction: 'inbound',
			timeline: { open: openedAt },
			remoteAddr: { toString: () => (kind === 'limited' ? '/ip4/1.2.3.4/tcp/1/p2p-circuit' : '/ip4/1.2.3.4/tcp/1') },
			opened: false,
			aborts: [],
			streams: [],
			newStream: (_protocols: string[], options?: any) => {
				conn.opened = true;
				conn.lastOptions = options;
				const stream = makeStream();
				conn.streams.push(stream);
				return behave(behaviour, options, stream);
			},
			// libp2p's `abort` moves the connection off `open` synchronously; that is what makes the
			// condemnation of one connection by two concurrent opens report once.
			abort: (err: Error) => {
				conn.aborts.push(err);
				conn.status = 'aborted';
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
	function makeNode(conns: ConnStub[], expectDial: boolean, selfPeerId: PeerId, dialBehaviour: Behaviour = 'opens') {
		const state: { dialOptions?: any; dialed: boolean; dialStream?: StreamStub } = { dialed: false };
		const node = {
			peerId: selfPeerId,
			getConnections: () => conns,
			getMultiaddrs: () => [],
			addEventListener: () => {},
			removeEventListener: () => {},
			services: {},
			dialProtocol: (_peer: unknown, _protocols: string[], options?: any) => {
				state.dialed = true;
				if (!expectDial) throw new Error('should not dial fresh when a reusable connection exists');
				state.dialOptions = options;
				const stream = makeStream();
				state.dialStream = stream;
				return behave(dialBehaviour, options, stream);
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
			(node, peer) => new Libp2pKeyPeerNetwork(node, 16, undefined, undefined).connect(peer, PROTOCOL),
		],
	];

	for (const [name, call] of ENTRY_POINTS) {
		describe(name, () => {
			it('opts in to limited connections when reusing an existing connection', async () => {
				const conn = makeConn('direct');
				const { node, state } = makeNode([conn], false, selfPeerId);

				await call(node, peerId);

				expect(conn.lastOptions).to.deep.include({ runOnLimitedConnection: true });
				expect(state.dialed).to.equal(false);
			});

			it('opts in to limited connections when dialing fresh', async () => {
				const { node, state } = makeNode([], true, selfPeerId);

				await call(node, peerId);

				expect(state.dialed).to.equal(true);
				expect(state.dialOptions).to.deep.include({ runOnLimitedConnection: true });
			});

			it('uses the relayed connection when it is the only open path', async () => {
				const relayed = makeConn('limited');
				const { node, state } = makeNode([relayed], false, selfPeerId);

				await call(node, peerId);

				expect(relayed.opened).to.equal(true);
				expect(relayed.lastOptions).to.deep.include({ runOnLimitedConnection: true });
				expect(state.dialed).to.equal(false);
			});

			it('prefers a direct connection over a relayed one', async () => {
				const relayed = makeConn('limited');
				const direct = makeConn('direct');
				const { node, state } = makeNode([relayed, direct], false, selfPeerId);

				await call(node, peerId);

				expect(direct.opened).to.equal(true);
				expect(relayed.opened).to.equal(false);
				expect(state.dialed).to.equal(false);
			});

			it('skips a connection libp2p has not yet evicted but that is no longer open', async () => {
				const closing = makeConn('direct', 'closing');
				const healthy = makeConn('direct');
				const { node, state } = makeNode([closing, healthy], false, selfPeerId);

				await call(node, peerId);

				expect(healthy.opened).to.equal(true);
				expect(closing.opened).to.equal(false);
				expect(state.dialed).to.equal(false);
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

		it('always hands the stream open a signal of its own, so libp2p never judges the connection on its default negotiation timeout', async () => {
			const conn = makeConn('direct');
			const { node } = makeNode([conn], false, selfPeerId);

			await openProtocolStream(node, peerId, PROTOCOL);

			expect(conn.lastOptions?.signal).to.be.instanceOf(AbortSignal);
		});

		it('runs an open on an existing connection under its own signal, never the caller\'s', async () => {
			// The caller's deadline is no evidence that the connection is dead; the dead-connection
			// delay is (see the fallback cases below).
			const conn = makeConn('direct');
			const { node } = makeNode([conn], false, selfPeerId);
			const controller = new AbortController();

			await openProtocolStream(node, peerId, PROTOCOL, { signal: controller.signal });

			expect(conn.lastOptions?.signal).to.be.instanceOf(AbortSignal);
			expect(conn.lastOptions?.signal).to.not.equal(controller.signal);
		});

		it('dials fresh with `force`, so libp2p opens a new connection instead of handing back an existing one', async () => {
			const { node, state } = makeNode([], true, selfPeerId);

			await openProtocolStream(node, peerId, PROTOCOL);

			expect(state.dialOptions).to.include({ force: true });
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

		it('cancels a fresh dial with the caller\'s reason when the caller gives up during it', async () => {
			const { node, state } = makeNode([], true, selfPeerId, 'hangs');
			const reason = new Error('caller gave up');
			const controller = new AbortController();

			const open = openProtocolStream(node, peerId, PROTOCOL, { signal: controller.signal });
			await sleep(10);
			controller.abort(reason);

			expect(await open.then(() => undefined, (e: unknown) => e)).to.equal(reason);
			expect(state.dialOptions?.signal.aborted).to.equal(true);
			expect(state.dialOptions?.signal.reason).to.equal(reason);
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

	// --- The hedge across connections and the dead-connection judgment (GitHub #32) ---------
	describe('fallback across connections, then a fresh dial', () => {
		const HEDGE = 40;
		const DEAD = 120;
		const deadlines = { hedgeDelayMs: HEDGE, deadConnectionDelayMs: DEAD };
		let lines: string[];
		let log: StreamOpenLog;
		beforeEach(() => {
			lines = [];
			log = (fmt: string) => { lines.push(fmt); };
		});
		const deadLines = () => lines.filter(l => l.startsWith('open-stream:connection-dead'));
		const outcome = (open: Promise<unknown>) => open.then(() => undefined, (e: unknown) => e);

		it('hedges onto the next connection when the first open stays pending, and aborts nothing yet', async () => {
			const hung = makeConn('direct', 'open', 'hangs', 2);
			const healthy = makeConn('direct', 'open', 'opens', 1);
			const { node, state } = makeNode([hung, healthy], false, selfPeerId);
			const started = Date.now();

			const stream = await openProtocolStream(node, peerId, PROTOCOL, { deadlines, log });

			expect(Date.now() - started, 'the second connection is tried only after the hedge delay').to.be.at.least(HEDGE - 2);
			expect(stream).to.equal(healthy.streams[0]);
			expect(hung.opened).to.equal(true);
			expect(hung.aborts, 'a pending open is not yet evidence that the connection is dead').to.deep.equal([]);
			expect(state.dialed, 'the fresh dial is the last path, after every connection').to.equal(false);
			await sleep(DEAD + 40);
		});

		it('aborts a connection whose open stays pending for the dead-connection delay, once, and reports it once', async () => {
			const hung = makeConn('direct', 'open', 'hangs', 2);
			const healthy = makeConn('direct', 'open', 'opens', 1);
			const { node } = makeNode([hung, healthy], false, selfPeerId);

			// Two requests meet the same dead connection before either has condemned it.
			await Promise.all([
				openProtocolStream(node, peerId, PROTOCOL, { deadlines, log }),
				openProtocolStream(node, peerId, PROTOCOL, { deadlines, log }),
			]);
			expect(hung.aborts).to.deep.equal([]);
			await sleep(DEAD + 40);

			expect(hung.aborts).to.have.length(1);
			expect(hung.aborts[0]).to.be.instanceOf(DeadConnectionError);
			expect((hung.aborts[0] as DeadConnectionError).code).to.equal(DEAD_CONNECTION_ERROR_CODE);
			expect(hung.status).to.equal('aborted');
			expect(deadLines()).to.have.length(1);
			expect(healthy.aborts).to.deep.equal([]);
		});

		it('moves on at once when the first connection rejects, instead of waiting out the hedge', async () => {
			const reset = makeConn('direct', 'open', { rejectsWith: new Error('stream reset') }, 2);
			const healthy = makeConn('direct', 'open', 'opens', 1);
			const { node } = makeNode([reset, healthy], false, selfPeerId);
			const started = Date.now();

			const stream = await openProtocolStream(node, peerId, PROTOCOL, { deadlines: { hedgeDelayMs: 5000, deadConnectionDelayMs: 10_000 }, log });

			expect(stream).to.equal(healthy.streams[0]);
			expect(Date.now() - started).to.be.below(1000);
			expect(reset.aborts, 'a connection that answered, even with a failure, is not dead').to.deep.equal([]);
		});

		it('tries direct connections before limited ones, and the newest first within each', async () => {
			const oldDirect = makeConn('direct', 'open', 'hangs', 1);
			const newDirect = makeConn('direct', 'open', 'hangs', 2);
			const newLimited = makeConn('limited', 'open', 'hangs', 3);
			const { node, state } = makeNode([newLimited, oldDirect, newDirect], true, selfPeerId);
			const order: string[] = [];
			for (const conn of [oldDirect, newDirect, newLimited]) {
				const newStream = conn.newStream;
				conn.newStream = (protocols, options) => { order.push(conn.id); return newStream(protocols, options); };
			}

			await openProtocolStream(node, peerId, PROTOCOL, { deadlines: { hedgeDelayMs: 10, deadConnectionDelayMs: DEAD }, log });

			expect(order).to.deep.equal([newDirect.id, oldDirect.id, newLimited.id]);
			expect(state.dialed, 'the fresh dial comes after every connection').to.equal(true);
			await sleep(DEAD + 40);
			expect(deadLines()).to.have.length(3);
		});

		it('dials fresh, forcing a new connection, once every open connection has been tried', async () => {
			const hung = makeConn('direct', 'open', 'hangs');
			const { node, state } = makeNode([hung], true, selfPeerId);
			const order: string[] = [];

			const stream = await openProtocolStream(node, peerId, PROTOCOL, { deadlines, log, beforeDial: () => { order.push(`beforeDial opened=${hung.opened}`); } });

			expect(state.dialed).to.equal(true);
			expect(stream).to.equal(state.dialStream);
			expect(state.dialOptions).to.include({ force: true, runOnLimitedConnection: true });
			expect(order, 'the pre-dial check runs only once the dial path is reached').to.deep.equal(['beforeDial opened=true']);
			expect(hung.aborts).to.deep.equal([]);
			await sleep(DEAD + 40);
			expect(hung.aborts).to.have.length(1);
		});

		it('rejects with the caller\'s reason when the caller gives up with every path pending, and still condemns the dead connection afterwards', async () => {
			const hung = makeConn('direct', 'open', 'hangs');
			const { node, state } = makeNode([hung], true, selfPeerId, 'hangs');
			const controller = new AbortController();
			const reason = new Error('caller gave up');

			const open = openProtocolStream(node, peerId, PROTOCOL, { signal: controller.signal, deadlines: { hedgeDelayMs: 10, deadConnectionDelayMs: DEAD }, log });
			await sleep(40);
			controller.abort(reason);

			expect(await outcome(open)).to.equal(reason);
			expect(state.dialed).to.equal(true);
			expect(state.dialOptions.signal.aborted, 'the fresh dial is cancelled with the caller\'s reason').to.equal(true);
			expect(state.dialOptions.signal.reason).to.equal(reason);
			expect(hung.lastOptions.signal.aborted, 'the open on the existing connection runs on, as evidence').to.equal(false);
			await sleep(DEAD + 40);
			expect(hung.aborts).to.have.length(1);
			expect(deadLines()).to.have.length(1);
		});

		it('rejects with the first connection\'s error once every path has failed', async () => {
			const first = new Error('first connection reset');
			const second = new Error('second connection reset');
			const a = makeConn('direct', 'open', { rejectsWith: first }, 2);
			const b = makeConn('direct', 'open', { rejectsWith: second }, 1);
			const { node, state } = makeNode([a, b], true, selfPeerId, { rejectsWith: new Error('no valid addresses') });

			const err = await outcome(openProtocolStream(node, peerId, PROTOCOL, { deadlines, log }));

			expect(err).to.equal(first);
			expect(state.dialed, 'every path was tried before giving up').to.equal(true);
		});

		it('waits for a pending connection to be condemned before failing, and then fails with its death', async () => {
			const hung = makeConn('direct', 'open', 'hangs');
			const { node } = makeNode([hung], true, selfPeerId, { rejectsWith: new Error('no valid addresses') });
			const started = Date.now();

			const err = await outcome(openProtocolStream(node, peerId, PROTOCOL, { deadlines, log }));

			expect(err).to.be.instanceOf(DeadConnectionError);
			expect(Date.now() - started).to.be.at.least(DEAD - 2);
			expect(hung.aborts).to.have.length(1);
		});

		it('closes a stream a losing path opens late', async () => {
			const slow = makeConn('direct', 'open', { opensAfterMs: 80 }, 2);
			const healthy = makeConn('direct', 'open', 'opens', 1);
			const { node } = makeNode([slow, healthy], false, selfPeerId);

			const stream = await openProtocolStream(node, peerId, PROTOCOL, { deadlines: { hedgeDelayMs: 20, deadConnectionDelayMs: DEAD }, log });
			expect(stream).to.equal(healthy.streams[0]);
			await sleep(100);

			expect(slow.streams[0]!.closes).to.equal(1);
			expect(healthy.streams[0]!.closes).to.equal(0);
			expect(slow.aborts, 'it answered inside the dead-connection delay, so it is merely slow').to.deep.equal([]);
		});

		it('lets a merely slow connection win when it answers first', async () => {
			const slow = makeConn('direct', 'open', { opensAfterMs: 60 }, 2);
			const hung = makeConn('direct', 'open', 'hangs', 1);
			const { node } = makeNode([slow, hung], true, selfPeerId, 'hangs');

			const stream = await openProtocolStream(node, peerId, PROTOCOL, { deadlines: { hedgeDelayMs: 20, deadConnectionDelayMs: DEAD }, log });

			expect(stream).to.equal(slow.streams[0]);
			expect(hung.opened, 'the hedge had started the next connection meanwhile').to.equal(true);
			await sleep(DEAD + 40);
			expect(slow.aborts).to.deep.equal([]);
			expect(hung.aborts).to.have.length(1);
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
