/**
 * Long-lived circuit-relay regression spec.
 *
 * Reproduces the per-relayed-connection cap that `@libp2p/circuit-relay-v2`
 * applies by default (`applyDefaultLimit: true` → `Limit { data: 128 KiB,
 * duration: 2 min }`). Once any single relayed circuit between two peers hits
 * either cap, the relay resets the underlying stream — silently killing
 * long-lived service↔browser tunnels in a Tier 2 e2e run. The fix threads
 * `relayServerInit: { reservations: { applyDefaultLimit: false } }` through
 * `NodeOptions` (see `libp2p-node-base.ts`); the reference-peer CLI opts in by
 * default for trusted local clusters.
 *
 * This spec is **slow** (a full pass spins three libp2p nodes and pushes
 * sustained traffic through a relayed tunnel). It is gated behind
 * `RUN_LONG_TESTS=1` so the default `yarn workspace @optimystic/db-p2p test`
 * run skips it. To exercise:
 *
 *   PowerShell: $env:RUN_LONG_TESTS=1; yarn workspace @optimystic/db-p2p test --grep "Circuit-relay long-lived"
 *   bash:        RUN_LONG_TESTS=1 yarn workspace @optimystic/db-p2p test --grep "Circuit-relay long-lived"
 *
 * To additionally run the control case that asserts the default-limit behavior
 * does reset the stream, set `RUN_LONG_TESTS_CONTROL=1` as well.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { Connection, Stream } from '@libp2p/interface';
import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import type { Multiaddr } from '@multiformats/multiaddr';
import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { createLibp2pNode, type Libp2pTransports } from '../src/libp2p-node.js';
import { spawnRelayNode, pickRelayWsAddr, waitForCircuitListen } from './util/relay-topology.js';

const NETWORK = 'circuit-relay-long-lived-it';
const TEST_PROTOCOL = '/optimystic-test/relay-traffic/1.0.0';

/** ~2 KiB payload, well below the default 128 KiB per-circuit data cap. */
const PAYLOAD_BYTES = 2 * 1024;
const PAYLOAD = new Uint8Array(PAYLOAD_BYTES).fill(0x61);

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

async function pushPayload(stream: Stream): Promise<void> {
	await pipe(
		[PAYLOAD],
		lpEncode,
		async (source) => {
			for await (const chunk of source) {
				stream.send(chunk);
			}
		}
	);
}

async function readPayload(stream: Stream): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	await pipe(
		stream,
		lpDecode,
		async (source) => {
			for await (const buf of source) {
				chunks.push(buf.subarray());
				break;
			}
		}
	);
	if (chunks.length === 0) throw new Error('no payload received');
	return chunks[0]!;
}

async function registerEchoHandler(node: Libp2p): Promise<void> {
	await node.handle(TEST_PROTOCOL, async (stream: Stream, _connection: Connection) => {
		try {
			const received = await readPayload(stream);
			expect(received.byteLength).to.equal(PAYLOAD_BYTES);
			await pushPayload(stream);
		} catch {
			// Reset under the data-limit cap is the failure mode under test in the
			// control case; for the primary case the dialer assertion will catch it.
		} finally {
			try { await stream.close(); } catch { /* ignored */ }
		}
	}, { runOnLimitedConnection: true });
}

describe('Circuit-relay long-lived connections', function () {
	this.timeout(180_000);

	let relay: Libp2p | undefined;
	let client: Libp2p | undefined;
	let dialer: Libp2p | undefined;

	before(function () {
		if (process.env.RUN_LONG_TESTS !== '1') this.skip();
	});

	afterEach(async () => {
		const toStop = [dialer, client, relay].filter((n): n is Libp2p => !!n);
		dialer = undefined; client = undefined; relay = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('sustained ~2 KiB dials through a relay survive past the default 128 KiB cap', async function () {
		this.timeout(120_000);

		relay = await spawnRelayNode(NETWORK, { applyDefaultLimit: false });
		const relayWs = pickRelayWsAddr(relay);

		client = await spawnBrowserShaped(relayWs);
		await registerEchoHandler(client);

		const circuitAddr = await waitForCircuitListen(client, 15_000);

		dialer = await spawnServicePeer();
		await dialer.dial(relayWs);

		const iterations = 80; // 80 * 2 KiB = 160 KiB — past the 128 KiB default cap.
		const intervalMs = 500;
		for (let i = 0; i < iterations; i++) {
			const stream: Stream = await dialer.dialProtocol(circuitAddr, TEST_PROTOCOL, { runOnLimitedConnection: true });
			try {
				await pushPayload(stream);
				const echoed = await readPayload(stream);
				expect(echoed.byteLength, `iteration ${i} echo size`).to.equal(PAYLOAD_BYTES);
			} finally {
				await stream.close();
			}
			// Intentional real-time pacing (NOT a convergence wait): the test is that a *long-lived* relay
			// connection carries sustained traffic past the byte cap, so the passage of real time between dials
			// is the thing under test. Bounded by this.timeout(120_000) above; do not convert to a condition poll.
			await new Promise(r => setTimeout(r, intervalMs));
		}
	});

	it('control: with applyDefaultLimit:true, sustained traffic surfaces a reset (proves the test exercises the right surface)', async function () {
		this.timeout(180_000);
		if (process.env.RUN_LONG_TESTS_CONTROL !== '1') this.skip();

		relay = await spawnRelayNode(NETWORK, { applyDefaultLimit: true });
		const relayWs = pickRelayWsAddr(relay);

		client = await spawnBrowserShaped(relayWs);
		await registerEchoHandler(client);

		const circuitAddr = await waitForCircuitListen(client, 15_000);

		dialer = await spawnServicePeer();
		await dialer.dial(relayWs);

		let failureSeen = false;
		for (let i = 0; i < 120; i++) {
			try {
				const stream: Stream = await dialer.dialProtocol(circuitAddr, TEST_PROTOCOL, { runOnLimitedConnection: true });
				try {
					await pushPayload(stream);
					await readPayload(stream);
				} finally {
					await stream.close();
				}
			} catch {
				failureSeen = true;
				break;
			}
			// Intentional real-time pacing (see the sibling test): sustained traffic over real time is what
			// surfaces the reset under the default limit. Bounded by this.timeout(180_000); not a convergence wait.
			await new Promise(r => setTimeout(r, 500));
		}
		expect(failureSeen, 'control variant should surface a relay reset under the default limit').to.equal(true);
	});
});
