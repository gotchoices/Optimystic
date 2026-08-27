/**
 * `openProtocolStream` over a REAL circuit relay, on real sockets.
 *
 * The unit spec (`open-protocol-stream.spec.ts`) asserts the option object the helper hands
 * libp2p. That is the shape of the bug — `runOnLimitedConnection` omitted — but it proves nothing
 * about what libp2p then does with it, and the whole class of defect this helper exists to prevent
 * is invisible against a stub: a stub happily opens a stream whether or not the flag is there.
 *
 * So this spec builds the topology the flag exists for. A relay `R`; a browser-shaped peer `C`
 * whose only listen address is a circuit through `R`; and a service peer `S` that can only reach
 * `C` through that circuit. libp2p represents the resulting connection as *limited*, and refuses a
 * protocol stream over it unless the opener opts in.
 *
 * The control case is what makes the primary assertion mean something: the same stream opened
 * WITHOUT the flag must be refused. If libp2p ever stopped enforcing that, the primary case would
 * pass for the wrong reason and this file would be worthless.
 *
 * **Runtime.** Four real libp2p boots plus a relay reservation. The four cases report ~0.4 s of
 * test time on loopback, and adding the whole file to the default suite was not measurable above
 * run-to-run variance (53 s with it, 60 s without, across two full `yarn workspace
 * @optimystic/db-p2p test` runs on the same machine) — so like `relay-self-relay-only-dial.spec.ts`
 * it is NOT env-gated. The `timeout`s below are ceilings for a loaded CI box, not expectations.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { Connection, Stream } from '@libp2p/interface';
import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import type { Multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, type Libp2pTransports } from '../src/libp2p-node.js';
import { openProtocolStream, isLimitedConnection } from '../src/network/open-protocol-stream.js';
import { spawnRelayNode, pickRelayWsAddr, waitForCircuitListen } from './util/relay-topology.js';

/** Distinct per-spec: identify protocol ids are network-scoped, so a shared name lets specs cross-talk. */
const NETWORK = 'open-protocol-stream-relay';
const TEST_PROTOCOL = '/optimystic-test/limited-stream/1.0.0';

/** Budget for the relay to grant `C` its reservation and for `C` to publish the circuit address. */
const RESERVATION_TIMEOUT_MS = 15_000;

/** A relay-only ("browser-shaped") peer: WebSockets + circuit, listening only through the relay. */
async function spawnBrowserShaped(relayAddr: Multiaddr): Promise<Libp2p> {
	const transports: Libp2pTransports = [webSockets(), circuitRelayTransport()];
	return await createLibp2pNode({
		port: 0,
		networkName: NETWORK,
		bootstrapNodes: [relayAddr.toString()],
		relay: false,
		transports,
		listenAddrs: [`${relayAddr.toString()}/p2p-circuit`],
		clusterSize: 1,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
		arachnode: { enableRingZulu: false }
	});
}

/** An ordinary service peer. Carries WebSockets so it can traverse the relay's WS circuit. */
async function spawnServicePeer(): Promise<Libp2p> {
	const transports: Libp2pTransports = [tcp(), webSockets(), circuitRelayTransport()];
	return await createLibp2pNode({
		port: 0,
		networkName: NETWORK,
		bootstrapNodes: [],
		relay: false,
		transports,
		listenAddrs: ['/ip4/127.0.0.1/tcp/0'],
		clusterSize: 1,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
		arachnode: { enableRingZulu: false }
	});
}

/** Accept the protocol on a limited connection and close immediately — this spec only opens streams. */
async function registerHandler(node: Libp2p): Promise<void> {
	await node.handle(TEST_PROTOCOL, (stream: Stream, _connection: Connection) => {
		void stream.close().catch(() => { /* dialer may have closed first */ });
	}, { runOnLimitedConnection: true });
}

describe('openProtocolStream over a real circuit relay', function () {
	this.timeout(60_000);

	let relay: Libp2p | undefined;
	let client: Libp2p | undefined;
	let service: Libp2p | undefined;
	let circuitAddr: Multiaddr;

	before(async function () {
		this.timeout(60_000);
		// `applyDefaultLimit: true` is libp2p's own default and is REQUIRED for this spec to test
		// anything: it is what makes the relay stamp each circuit with a `Limit` (128 KiB / 2 min),
		// which is in turn what makes libp2p mark the connection `limited` and enforce the opt-in.
		// With `false` — the posture this repo's relays actually run in for trusted clusters — the
		// connection is still a circuit but carries no limits, libp2p does not gate streams on it,
		// and the control case below passes a stream through without the flag. The caps are far
		// above anything this spec sends.
		relay = await spawnRelayNode(NETWORK, { applyDefaultLimit: true });
		const relayWs = pickRelayWsAddr(relay);

		client = await spawnBrowserShaped(relayWs);
		await registerHandler(client);
		circuitAddr = await waitForCircuitListen(client, RESERVATION_TIMEOUT_MS);

		service = await spawnServicePeer();
		// Dial the circuit address so the only connection to `client` is a relayed one.
		await service.dial(circuitAddr);
	});

	after(async () => {
		const toStop = [service, client, relay].filter((n): n is Libp2p => n != null);
		service = undefined; client = undefined; relay = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('the only connection to a relay-only peer really is a limited one', () => {
		const conns = service!.getConnections(client!.peerId);
		expect(conns.length, 'expected exactly the relayed connection').to.be.greaterThan(0);
		expect(conns.every(c => isLimitedConnection(c)), 'every connection must be relayed for this spec to mean anything').to.equal(true);
	});

	it('control: opening the stream WITHOUT the opt-in is refused by libp2p', async () => {
		// If this ever stops failing, the primary case below passes for the wrong reason.
		const conn = service!.getConnections(client!.peerId)[0]!;
		const err = await conn.newStream([TEST_PROTOCOL]).then(
			() => undefined,
			(e: unknown) => e
		);
		expect(err, 'libp2p must still refuse a stream over a limited connection by default').to.be.instanceOf(Error);
		// Pin the REASON, not merely that something threw — a refusal for any other cause would
		// leave the primary case unguarded.
		expect(`${(err as Error).name} ${(err as Error).message}`).to.match(/limited/i);
	});

	it('opens a stream by reusing the relayed connection', async () => {
		const stream = await openProtocolStream(service!, client!.peerId, TEST_PROTOCOL);
		try {
			expect(stream).to.not.be.undefined;
			expect(stream.protocol).to.equal(TEST_PROTOCOL);
		} finally {
			await stream.close().catch(() => { /* remote may have closed first */ });
		}
	});

	it('opens a stream on a cold dial, from a peer that has only been taught the circuit address', async function () {
		this.timeout(60_000);
		// The cohort case: a member holds a relay-only peer's address (learned from a cluster
		// record via `recordPeerAddresses`) but has never connected to it.
		const cold = await spawnServicePeer();
		try {
			await cold.peerStore.merge(client!.peerId, { multiaddrs: [circuitAddr] });
			expect(cold.getConnections(client!.peerId).length, 'the cold peer must start with no connection').to.equal(0);

			const stream = await openProtocolStream(cold, client!.peerId, TEST_PROTOCOL);
			try {
				expect(stream.protocol).to.equal(TEST_PROTOCOL);
				expect(
					cold.getConnections(client!.peerId).some(c => isLimitedConnection(c)),
					'the dial should have gone through the relay'
				).to.equal(true);
			} finally {
				await stream.close().catch(() => { /* remote may have closed first */ });
			}
		} finally {
			await Promise.resolve(cold.stop()).catch(() => { /* best effort */ });
		}
	});
});
