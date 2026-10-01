/**
 * The libp2p-level premise behind `LinkDeadlines.addressDialTimeoutMs`, pinned as an executable
 * fact: libp2p gives each address of a peer `connectionManager.addressDialTimeout` to connect, and
 * applies that limit INSIDE a dial that carries its own, longer, signal.
 *
 * Two libp2p nodes talk through a TCP proxy (`listenDelayProxy`) that delays every chunk by
 * {@link ONE_WAY_MS} in each direction, so opening a connection — the encrypter and muxer
 * negotiation on top of the socket — costs about two link round trips (measured through this proxy
 * on libp2p 3.3.11: 2.1 to 2.5 round trips at round trips of 400 down to 100 ms). Both cases dial
 * with the same generous caller signal and differ only in the dialer's `addressDialTimeout`.
 *
 * - With the limit below the cost of the open, the dial fails while the caller's signal is still
 *   live. This is the failure reported in gotchoices/sereus#13: a relayed connection open on a slow
 *   link, cut off at libp2p's 6 s default although every deadline of ours allowed far longer.
 * - With the limit covering the open, the same dial over the same link succeeds, and takes longer
 *   than the limit that cut the first one off.
 *
 * Both are assertions about libp2p, not about db-p2p: `createLibp2pNodeBase` only passes the
 * derived value through. The limit first shipped in libp2p 3.2.1; on libp2p 3.1.3 the first case
 * fails, because the option is ignored and the dial succeeds (checked against 3.1.3) — so a
 * lockfile that slides back to a line without the limit, where no spec of ours would exercise it,
 * is caught here. That is how the report was missed: this repository's lockfile held 3.1.3 while a
 * fresh install of the published packages resolved 3.3.11. If a later libp2p stops applying the
 * limit to a signalled dial, the first case fails too, and that is the signal that
 * `addressDialTimeoutMs` no longer needs deriving.
 *
 * The values are scaled down so the file runs in about two seconds.
 */
import { expect } from 'chai';
import type net from 'node:net';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { listenDelayProxy, proxyPort } from './util/delay-proxy.js';

/** Injected delay per direction; the link round trip is twice this. */
const ONE_WAY_MS = 150;
const ROUND_TRIP_MS = 2 * ONE_WAY_MS;

/** Half the measured cost of the open, so the limit expires well inside it. */
const LIMIT_BELOW_THE_OPEN_MS = ROUND_TRIP_MS;

/** Five times the measured cost of the open, so a loaded machine still fits. */
const LIMIT_COVERING_THE_OPEN_MS = 10 * ROUND_TRIP_MS;

/** The caller's own deadline: far beyond either limit, so it is never what ends a dial here. */
const CALLER_DEADLINE_MS = 20_000;

async function spawnNode(addressDialTimeout?: number): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		...(addressDialTimeout === undefined ? {} : { connectionManager: { addressDialTimeout } })
	});
}

describe('addressDialTimeout cuts off a dial that carries its own signal', function () {
	this.timeout(30_000);

	let listener: Libp2p;
	let proxy: net.Server;
	let listenerThroughProxy: Multiaddr;
	const dialers: Libp2p[] = [];

	async function spawnDialer(addressDialTimeout: number): Promise<Libp2p> {
		const dialer = await spawnNode(addressDialTimeout);
		dialers.push(dialer);
		return dialer;
	}

	before(async () => {
		listener = await spawnNode();
		const listenPort = Number(listener.getMultiaddrs()[0]!.getComponents().find(c => c.name === 'tcp')!.value);
		proxy = await listenDelayProxy(listenPort, ONE_WAY_MS);
		listenerThroughProxy = multiaddr(`/ip4/127.0.0.1/tcp/${proxyPort(proxy)}/p2p/${listener.peerId.toString()}`);
	});

	after(async () => {
		await Promise.all(dialers.map(dialer => dialer.stop()));
		await listener?.stop();
		proxy?.close();
	});

	it('a limit below the cost of the open fails the dial while the caller\'s signal is still live', async () => {
		const dialer = await spawnDialer(LIMIT_BELOW_THE_OPEN_MS);
		const callerSignal = AbortSignal.timeout(CALLER_DEADLINE_MS);

		let caught: unknown;
		try {
			await dialer.dial(listenerThroughProxy, { signal: callerSignal });
		} catch (err) {
			caught = err;
		}

		expect(caught, 'the dial was cut off').to.be.instanceOf(Error);
		expect(callerSignal.aborted, 'the caller\'s own deadline had not expired').to.equal(false);
	});

	it('a limit covering the open lets the same dial through', async () => {
		const dialer = await spawnDialer(LIMIT_COVERING_THE_OPEN_MS);

		const startedAt = Date.now();
		const connection = await dialer.dial(listenerThroughProxy, { signal: AbortSignal.timeout(CALLER_DEADLINE_MS) });

		expect(connection.status).to.equal('open');
		expect(Date.now() - startedAt, 'the open costs more than the limit that cut the first dial off')
			.to.be.at.least(LIMIT_BELOW_THE_OPEN_MS);
	});
});
