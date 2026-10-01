/**
 * The libp2p cost behind the cold-path multiple of `LinkDeadlines.addressDialTimeoutMs`, pinned as an
 * executable fact: a circuit dial from a node that has NO connection to the relay opens that
 * connection from inside libp2p's per-address limit (`connectionManager.addressDialTimeout`), so the
 * limit has to cover the relay connection's open on top of the hop, the stop and the relayed upgrade.
 *
 * Three plain libp2p nodes on loopback: a circuit-relay server, a target holding a reservation on it,
 * and a dialer. The dialer and the target each reach the relay through their own delay proxy
 * (`listenDelayProxy`), so the two legs of the relayed path carry separate one-way delays. The whole
 * round trip sits on the dialer's leg ({@link DIALER_LEG_ONE_WAY_MS} against
 * {@link TARGET_LEG_ONE_WAY_MS}), which is where a cold open costs most. Measured through these
 * proxies on libp2p 3.3.11, as multiples of the end-to-end relayed round trip `r` (three runs each):
 *
 * | dialer→relay one-way | relay→target one-way | warm (relay connection open) | cold (none) |
 * |---|---|---|---|
 * | 100 ms | 100 ms | 4.4 r | 5.5 r |
 * | 200 ms | 1 ms | 4.4 r | 6.6 r |
 * | 1 ms | 200 ms | 4.4 r | 4.6 r |
 *
 * So the five round trips the per-address limit used to allow fit a warm dial and not a cold one. The
 * dialer here has never connected to the relay, and its limit is the cold multiple times `r`, read
 * from `resolveLinkDeadlines` at a declaration large enough that no floor hides the multiple. The
 * dial must succeed under that limit while the caller's own signal is far longer, so the limit is the
 * only thing that could end it. At the old multiple of five it fails (measured).
 *
 * The proxy delays bytes, not the TCP handshake, so the real cost of the dialer's leg is higher than
 * this measures: one more leg round trip for the TCP handshake, one more for a WebSocket upgrade and
 * one more for TLS under `wss`. The multiple's margin above the 6.6 r measured here is what covers
 * those (see the round-trip accounting above `CONNECTION_ROUND_TRIPS` in `src/rpc-deadline.ts`).
 *
 * **Runtime.** About two seconds for the cold dial at this round trip, plus a few hundred
 * milliseconds of setup and reservation. Not env-gated, like
 * `address-dial-timeout-cuts-off-a-signalled-dial.spec.ts`; if it proves slow or flaky under load,
 * gate it on `RUN_LONG_TESTS=1` the way the other relay specs are.
 */
import { expect } from 'chai';
import type net from 'node:net';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
import { waitFor } from '@optimystic/db-core/test';
import { MAX_LINK_ROUND_TRIP_MS, resolveLinkDeadlines } from '../src/rpc-deadline.js';
import { listenDelayProxy, proxyPort } from './util/delay-proxy.js';

/** Injected delay per direction on the dialer's leg to the relay. */
const DIALER_LEG_ONE_WAY_MS = 150;
/** Injected delay per direction on the target's leg to the relay. */
const TARGET_LEG_ONE_WAY_MS = 1;
/** The end-to-end relayed round trip, both legs there and back: what `linkRoundTripMs` declares. */
const ROUND_TRIP_MS = 2 * (DIALER_LEG_ONE_WAY_MS + TARGET_LEG_ONE_WAY_MS);

/** The per-address limit's multiple, exact at the ceiling, where no floor applies. */
const COLD_OPEN_ROUND_TRIPS = resolveLinkDeadlines(MAX_LINK_ROUND_TRIP_MS).addressDialTimeoutMs / MAX_LINK_ROUND_TRIP_MS;

/** The caller's own deadline: far beyond the limit, so it is never what ends the dial. */
const CALLER_DEADLINE_MS = 20_000;

/** Budget for the target's reservation to land and its circuit address to appear. */
const RESERVATION_TIMEOUT_MS = 15_000;

function tcpPort(node: Libp2p): number {
	const tcpComponent = node.getMultiaddrs()[0]!.getComponents().find(c => c.name === 'tcp');
	return Number(tcpComponent!.value);
}

async function spawnRelay(): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
		transports: [tcp()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: { identify: identify(), relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } }) }
	}) as unknown as Libp2p;
}

/** A node that can dial through a relay, listening on `listen` (a circuit address for the target). */
async function spawnCircuitNode(listen: string[], addressDialTimeout?: number): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen },
		transports: [tcp(), circuitRelayTransport()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: { identify: identify() },
		...(addressDialTimeout === undefined ? {} : { connectionManager: { addressDialTimeout } })
	}) as unknown as Libp2p;
}

describe('a cold relayed dial fits the per-address limit', function () {
	this.timeout(60_000);

	const nodes: Libp2p[] = [];
	const proxies: net.Server[] = [];

	after(async () => {
		await Promise.allSettled(nodes.map(node => node.stop()));
		for (const proxy of proxies) proxy.close();
	});

	it('a dialer with no connection to the relay reaches the target within the cold multiple of the round trip', async () => {
		const relay = await spawnRelay();
		nodes.push(relay);
		const relayPeerId = relay.peerId.toString();
		const dialerProxy = await listenDelayProxy(tcpPort(relay), DIALER_LEG_ONE_WAY_MS);
		const targetProxy = await listenDelayProxy(tcpPort(relay), TARGET_LEG_ONE_WAY_MS);
		proxies.push(dialerProxy, targetProxy);

		const target = await spawnCircuitNode([`/ip4/127.0.0.1/tcp/${proxyPort(targetProxy)}/p2p/${relayPeerId}/p2p-circuit`]);
		nodes.push(target);
		await waitFor(
			() => target.getMultiaddrs().some(addr => addr.toString().includes('/p2p-circuit')),
			{ timeoutMs: RESERVATION_TIMEOUT_MS, description: 'the target holds a reservation on the relay' }
		);

		const dialer = await spawnCircuitNode([], COLD_OPEN_ROUND_TRIPS * ROUND_TRIP_MS);
		nodes.push(dialer);
		expect(dialer.getConnections(relay.peerId), 'the dialer starts with no connection to the relay').to.have.length(0);

		const targetViaDialerLeg = multiaddr(
			`/ip4/127.0.0.1/tcp/${proxyPort(dialerProxy)}/p2p/${relayPeerId}/p2p-circuit/p2p/${target.peerId.toString()}`
		);
		const connection = await dialer.dial(targetViaDialerLeg, { signal: AbortSignal.timeout(CALLER_DEADLINE_MS) });

		expect(connection.status).to.equal('open');
		expect(connection.remotePeer.equals(target.peerId)).to.equal(true);
	});
});
