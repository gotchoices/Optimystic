/**
 * One half-open connection must not make a peer unreachable while a live connection to it exists
 * (GitHub #32).
 *
 * `b` dials `a` over WebSockets, then aborts the socket on its own side. `@libp2p/websockets`
 * <= 10.1.21 sends the reset with `websocket.close(1006)`, which Node's WebSocket rejects, so `a`
 * is never told: it keeps the connection and lists it as `open`. `b` re-dials, so `a` holds two
 * `open` connections to `b`, the dead one first. A stream opened on the second answers at once
 * (the control); `Libp2pKeyPeerNetwork.connect` must reach `b` too, and so must a retry.
 *
 * Ported from the reporter's flip-on-fix `stale-connection-picker.test.mjs`, asserting the fixed
 * behaviour instead.
 */
import { expect } from 'chai';
import { createLibp2p, type Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import type { Stream } from '@libp2p/interface';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { registerProtocolHandler } from '../src/network/register-protocol-handler.js';

const ECHO = '/optimystic-test/half-open-echo/1.0.0';
const REQUEST_MS = 3000;

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

describe('a half-open connection does not strand a connected peer', function () {
	this.timeout(30_000);

	let a: Libp2p;
	let b: Libp2p;

	before(async () => {
		a = await spawnNode(true);
		b = await spawnNode(false);

		const first = await b.dial(a.getMultiaddrs()[0]!);
		await sleep(500);
		// The abort `a` never hears about: in the field this was a read-buffer overflow.
		(first as unknown as { maConn: { abort(err: Error): void } }).maConn.abort(new Error('Read buffer overflow (simulated)'));
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
		const keyNetwork = new Libp2pKeyPeerNetwork(a, 1);
		expect(await request(signal => keyNetwork.connect(b.peerId, ECHO, { signal }))).to.equal('echoed');
		expect(await request(signal => keyNetwork.connect(b.peerId, ECHO, { signal }))).to.equal('echoed');
	});
});
