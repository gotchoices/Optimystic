/**
 * The libp2p-level premise behind every RPC dial deadline in this package, pinned as an executable
 * fact: opening a protocol stream costs one full link round trip EVEN ON A CONNECTION THAT IS
 * ALREADY OPEN, and `ProtocolClient`'s dial deadline bounds that round trip.
 *
 * Two libp2p nodes talk through a TCP proxy that delays every chunk by {@link ONE_WAY_MS} in each
 * direction. The connection is opened first, with a generous deadline; only then is the RPC made,
 * so the dial path under test is `openProtocolStream`'s connection-reuse branch.
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
 */
import { expect } from 'chai';
import net from 'node:net';
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
import { registerProtocolHandler } from '../src/network/register-protocol-handler.js';

/** Injected delay per direction; the link round trip is twice this. */
const ONE_WAY_MS = 200;
const ROUND_TRIP_MS = 2 * ONE_WAY_MS;
const ECHO_PROTOCOL = '/optimystic-test/echo-over-slow-link/1.0.0';

/** A TCP proxy that forwards each chunk after {@link ONE_WAY_MS}, in both directions. */
async function listenDelayProxy(targetPort: number): Promise<net.Server> {
	const server = net.createServer(inbound => {
		const outbound = net.connect(targetPort, '127.0.0.1');
		const forward = (from: net.Socket, to: net.Socket) => from.on('data', chunk => {
			setTimeout(() => { if (!to.destroyed) to.write(chunk); }, ONE_WAY_MS);
		});
		forward(inbound, outbound);
		forward(outbound, inbound);
		const teardown = () => { inbound.destroy(); outbound.destroy(); };
		for (const socket of [inbound, outbound]) {
			socket.on('close', teardown);
			socket.on('error', teardown);
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return server;
}

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
		proxy = await listenDelayProxy(listenPort);
		const proxyPort = (proxy.address() as net.AddressInfo).port;
		await dialer.dial(multiaddr(`/ip4/127.0.0.1/tcp/${proxyPort}/p2p/${listener.peerId.toString()}`), { signal: AbortSignal.timeout(20_000) });
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
});
