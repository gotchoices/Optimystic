/**
 * One half-open connection must not make a peer unreachable while a live connection to it exists
 * (GitHub #32).
 *
 * `b` dials `a` over WebSockets, then aborts the socket on its own side. `@libp2p/websockets`
 * <= 10.1.21 sends the reset with `websocket.close(1006)`, which Node's WebSocket rejects, so `a`
 * is never told: it keeps the connection and lists it as `open`. `b` dials again, so `a` holds two
 * `open` connections to `b`, one of them dead. A stream opened on the live one answers at once (the
 * control); `Libp2pKeyPeerNetwork.connect` must reach `b` too, and so must a retry.
 *
 * Two shapes, because `openProtocolStream` tries the newest connection first:
 *
 * - the dead connection is the OLDER one — the reporter's shape, where the re-dial replaced a
 *   connection that failed. Ordering alone answers this one, so it runs with no hedge at all; it
 *   is the ported `stale-connection-picker.test.mjs`, asserting the fixed behaviour.
 * - the dead connection is the NEWER one, so it is picked first and the open on it hangs: the
 *   hedge reaches `b` over the older, live connection, and the dead-connection delay then aborts
 *   the dead one so the next request does not choose it. `b` does not listen, so no fresh dial from
 *   `a` can succeed in either shape: the spec passes only if the open falls back to the second
 *   existing connection.
 */
import { expect } from 'chai';
import { createLibp2p, type Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import type { Connection, Stream } from '@libp2p/interface';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { registerProtocolHandler } from '../src/network/register-protocol-handler.js';

const ECHO = '/optimystic-test/half-open-echo/1.0.0';
const REQUEST_MS = 3000;
const HEDGE_MS = 250;
const DEAD_CONNECTION_MS = 1000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function spawnNode(listen: boolean): Promise<Libp2p> {
	const node = await createLibp2p({
		addresses: { listen: listen ? ['/ip4/127.0.0.1/tcp/0/ws'] : [] },
		transports: [webSockets()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		connectionManager: { reconnectRetries: 0 }
	});
	await registerProtocolHandler(node, ECHO, (stream: Stream) => {
		stream.addEventListener('message', evt => { stream.send(evt.data.subarray()); });
	});
	return node;
}

/** The abort `a` never hears about: in the field this was a read-buffer overflow. */
function abortOnOwnSide(connection: Connection): void {
	(connection as unknown as { maConn: { abort(err: Error): void } }).maConn.abort(new Error('Read buffer overflow (simulated)'));
}

type Outcome = 'echoed' | 'no reply' | 'hung' | string;

/** Open a stream with `open` and echo one message on it, all inside {@link REQUEST_MS}. */
async function request(open: (signal: AbortSignal) => Promise<Stream>): Promise<Outcome> {
	try {
		const stream = await open(AbortSignal.timeout(REQUEST_MS));
		const reply = new Promise<Outcome>(resolve => stream.addEventListener('message', () => resolve('echoed'), { once: true }));
		stream.send(new TextEncoder().encode('ping'));
		return await Promise.race([reply, sleep(REQUEST_MS).then(() => 'no reply')]);
	} catch (err) {
		const name = (err as Error).name;
		return name === 'TimeoutError' || name === 'AbortError' ? 'hung' : `threw ${name}: ${(err as Error).message}`;
	}
}

/** `a`'s key network, with short stream-open delays so the condemnation is observable inside the spec. */
function keyNetworkOf(a: Libp2p): Libp2pKeyPeerNetwork {
	return new Libp2pKeyPeerNetwork(a, 1, undefined, undefined, undefined, undefined, undefined, { hedgeDelayMs: HEDGE_MS, deadConnectionDelayMs: DEAD_CONNECTION_MS });
}

describe('a half-open connection does not strand a connected peer', function () {
	this.timeout(30_000);

	describe('when the dead connection is the older one (the reporter\'s shape)', () => {
		let a: Libp2p;
		let b: Libp2p;

		before(async () => {
			a = await spawnNode(true);
			b = await spawnNode(false);

			const first = await b.dial(a.getMultiaddrs()[0]!);
			await sleep(500);
			abortOnOwnSide(first);
			await sleep(500);
			await b.dial(a.getMultiaddrs()[0]!);
			await sleep(500);
		});

		after(async () => {
			await b?.stop();
			await a?.stop();
		});

		it('holds a dead and a live connection, both listed open (precondition)', async () => {
			const conns = a.getConnections(b.peerId);
			expect(conns.map(c => c.status)).to.deep.equal(['open', 'open']);
			expect(await request(signal => conns[1]!.newStream([ECHO], { signal }))).to.equal('echoed');
		});

		it('connect() reaches the peer, and so does a retry', async () => {
			const keyNetwork = keyNetworkOf(a);
			expect(await request(signal => keyNetwork.connect(b.peerId, ECHO, { signal }))).to.equal('echoed');
			expect(await request(signal => keyNetwork.connect(b.peerId, ECHO, { signal }))).to.equal('echoed');
		});
	});

	describe('when the dead connection is the newer one', () => {
		let a: Libp2p;
		let b: Libp2p;
		let live: Connection;

		before(async () => {
			a = await spawnNode(true);
			b = await spawnNode(false);

			await b.dial(a.getMultiaddrs()[0]!);
			await sleep(500);
			// `force`: without it libp2p hands back the connection it already holds.
			const second = await b.dial(a.getMultiaddrs()[0]!, { force: true });
			await sleep(500);
			abortOnOwnSide(second);
			await sleep(500);
			// `a`'s connection ids and remote addresses are its own, not `b`'s: the live connection is
			// the older of the two `a` holds, the one the first dial opened.
			live = [...a.getConnections(b.peerId)].sort((x, y) => x.timeline.open - y.timeline.open)[0]!;
		});

		after(async () => {
			await b?.stop();
			await a?.stop();
		});

		it('holds a live and a dead connection, both listed open (precondition)', () => {
			const conns = a.getConnections(b.peerId);
			expect(conns.map(c => c.status)).to.deep.equal(['open', 'open']);
			expect(conns[0]!.timeline.open, 'the dead connection is the newer one').to.be.at.most(conns[1]!.timeline.open);
		});

		it('connect() picks the dead connection first and reaches the peer over the live one after the hedge', async () => {
			const keyNetwork = keyNetworkOf(a);
			const started = Date.now();
			expect(await request(signal => keyNetwork.connect(b.peerId, ECHO, { signal }))).to.equal('echoed');
			expect(Date.now() - started, 'the live connection was tried only after the hedge delay').to.be.at.least(HEDGE_MS - 5);
		});

		it('aborts the dead connection within the dead-connection delay, so the next request is answered at once', async () => {
			const deadline = Date.now() + DEAD_CONNECTION_MS + 1500;
			while (a.getConnections(b.peerId).length > 1 && Date.now() < deadline) await sleep(50);

			const remaining = a.getConnections(b.peerId);
			expect(remaining.map(c => c.id)).to.deep.equal([live.id]);
			expect(remaining[0]!.status).to.equal('open');

			const keyNetwork = keyNetworkOf(a);
			const started = Date.now();
			expect(await request(signal => keyNetwork.connect(b.peerId, ECHO, { signal }))).to.equal('echoed');
			expect(Date.now() - started).to.be.below(HEDGE_MS);
		});
	});
});
