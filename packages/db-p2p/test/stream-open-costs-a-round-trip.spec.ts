/**
 * The libp2p-level premise behind every RPC dial deadline in this package, pinned as an executable
 * fact: opening a protocol stream costs one full link round trip EVEN ON A CONNECTION THAT IS
 * ALREADY OPEN, and `ProtocolClient`'s dial deadline bounds that round trip.
 *
 * Two libp2p nodes talk through a TCP proxy (`listenDelayProxy`) that delays every chunk by
 * {@link ONE_WAY_MS} in each direction. The connection is opened first, with a generous deadline;
 * only then is the RPC made, so the dial path under test is `openProtocolStream`'s
 * connection-reuse branch.
 *
 * - The uncapped RPC takes at least two round trips: multistream-select waits for the remote's
 *   acknowledgement before the request is sent. `Libp2pKeyPeerNetwork.connect` passes
 *   `negotiateFully: false`, which was meant to skip that wait; `@libp2p/multistream-select@7`
 *   ignores the option. If a libp2p upgrade ever makes it honoured again, the lower bound here
 *   fails and says the negotiation round trip is gone.
 * - A dial deadline shorter than one round trip fails the RPC with `DialTimeoutError` although the
 *   connection is open. That is why a dial deadline must cover a link round trip, not only the cost
 *   of opening a connection: on a link with a 3 s round trip, the default 3 s deadline failed every
 *   RPC this way (ticket `debt-rpc-dial-deadlines-cannot-open-a-slow-relayed-connection`).
 *
 * The two cases are assertions about libp2p plus `ProtocolClient`, not about any deadline value —
 * the values are scaled down so the file runs in about two seconds.
 *
 * The third case is the in-repo answer to that premise: a `PreparedStreams` pool behind the key
 * network's `connect` negotiates the next request's stream while the current request is in flight,
 * so the first request still pays both round trips and the next one pays only its own.
 */
import { expect } from 'chai';
import type net from 'node:net';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr } from '@multiformats/multiaddr';
import type { AbortOptions, PeerId, Stream } from '@libp2p/interface';
import type { IPeerNetwork } from '@optimystic/db-core';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { ProtocolClient, DialTimeoutError } from '../src/protocol-client.js';
import { openProtocolStream } from '../src/network/open-protocol-stream.js';
import { PreparedStreams } from '../src/network/prepared-streams.js';
import { Libp2pKeyPeerNetwork } from '../src/libp2p-key-network.js';
import { registerProtocolHandler } from '../src/network/register-protocol-handler.js';
import { listenDelayProxy, proxyPort } from './util/delay-proxy.js';

/** Injected delay per direction; the link round trip is twice this. */
const ONE_WAY_MS = 200;
const ROUND_TRIP_MS = 2 * ONE_WAY_MS;
const ECHO_PROTOCOL = '/optimystic-test/echo-over-slow-link/1.0.0';

async function spawnNode(): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()]
	});
}

/** Replies to the first frame with the same frame. */
async function echoOnce(stream: Stream): Promise<void> {
	await pipe(stream, source => lp.decode(source), async frames => {
		for await (const frame of frames) {
			for await (const chunk of lp.encode([frame.subarray()])) stream.send(chunk);
			break;
		}
	});
	await stream.close();
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

class EchoClient extends ProtocolClient {
	async echo(dialTimeoutMs: number): Promise<unknown> {
		return await this.processMessage<unknown>({ ping: 1 }, ECHO_PROTOCOL, { dialTimeoutMs, responseTimeoutMs: 10_000 });
	}
}

describe('opening a stream on an open connection costs a round trip', function () {
	this.timeout(30_000);

	let dialer: Libp2p;
	let listener: Libp2p;
	let proxy: net.Server;

	/** Opens streams exactly as `Libp2pKeyPeerNetwork.connect` does. */
	const network = (): IPeerNetwork => ({
		connect: async (peer: PeerId, protocol: string, options?: AbortOptions) =>
			await openProtocolStream(dialer, peer, protocol, { signal: options?.signal, negotiateFully: false })
	}) as unknown as IPeerNetwork;

	before(async () => {
		dialer = await spawnNode();
		listener = await spawnNode();
		await registerProtocolHandler(listener, ECHO_PROTOCOL, echoOnce);
		const listenPort = Number(listener.getMultiaddrs()[0]!.getComponents().find(c => c.name === 'tcp')!.value);
		proxy = await listenDelayProxy(listenPort, ONE_WAY_MS);
		await dialer.dial(multiaddr(`/ip4/127.0.0.1/tcp/${proxyPort(proxy)}/p2p/${listener.peerId.toString()}`), { signal: AbortSignal.timeout(20_000) });
	});

	after(async () => {
		await dialer?.stop();
		await listener?.stop();
		proxy?.close();
	});

	it('an uncapped RPC pays the negotiation round trip before its own', async () => {
		const t0 = Date.now();
		const reply = await new EchoClient(listener.peerId, network()).echo(0);
		expect(reply).to.deep.equal({ ping: 1 });
		expect(Date.now() - t0).to.be.at.least(2 * ROUND_TRIP_MS);
	});

	it('a dial deadline below one round trip fails the RPC although the connection is open', async () => {
		expect(dialer.getConnections(listener.peerId).some(c => c.status === 'open')).to.equal(true);
		let caught: unknown;
		try {
			await new EchoClient(listener.peerId, network()).echo(ROUND_TRIP_MS - 100);
		} catch (err) {
			caught = err;
		}
		expect(caught).to.be.instanceOf(DialTimeoutError);
	});

	it('with a prepared stream, a request after the first pays only its own round trip', async () => {
		const pool = new PreparedStreams(dialer, { protocols: [ECHO_PROTOCOL] });
		try {
			const keyNetwork = new Libp2pKeyPeerNetwork(dialer, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, pool);
			const client = new EchoClient(listener.peerId, keyNetwork);

			const firstStarted = Date.now();
			expect(await client.echo(0)).to.deep.equal({ ping: 1 });
			expect(Date.now() - firstStarted, 'nothing was prepared yet').to.be.at.least(2 * ROUND_TRIP_MS);

			// The replacement's negotiation rides the wire beside the first request and finishes with its
			// reply; a request issued in that same instant could race it, which a sequence of real
			// requests (each with work between) does not.
			await sleep(ROUND_TRIP_MS / 4);

			const secondStarted = Date.now();
			expect(await client.echo(0)).to.deep.equal({ ping: 1 });
			const elapsed = Date.now() - secondStarted;
			expect(elapsed).to.be.at.least(ROUND_TRIP_MS);
			expect(elapsed, 'the second request took the prepared stream').to.be.below(2 * ROUND_TRIP_MS);
		} finally {
			pool.close();
		}
	});
});
