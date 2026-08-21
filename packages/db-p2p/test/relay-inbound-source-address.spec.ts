/**
 * Regression guard for gotchoices/Optimystic#13, over real sockets.
 *
 * `findCluster` publishes a record that OTHER peers dial from. Before the fix it built that
 * record from every live connection's `remoteAddr`, without asking which side had dialed — so for
 * an **inbound** connection it published the far side's ephemeral source socket: the port that
 * peer's operating system picked for that one connection, reachable by nobody else.
 *
 * A relay-only client reproduces it deterministically. It connects to the relay, and only *then*
 * requests the circuit reservation that gives it its real address; that address reaches the relay
 * about a second later via `identifyPush`. For the whole of that window the relay holds an inbound
 * connection to the client and an empty peerStore entry for it — precisely the state that produced
 * the upstream reporter's log line, where the one published address was the client's source port.
 *
 * The window is short, so this spec samples the published record continuously rather than checking
 * it once. It also asserts, in the other direction, that the good address still lands: a filter
 * that dropped everything would satisfy the negative assertion on its own and prove nothing.
 *
 * **Runtime.** ~2 s (two real libp2p boots over loopback plus the reservation/push round trip), so
 * like the positive cases in `relay-address-propagation.spec.ts` it is NOT env-gated.
 */
import { expect } from 'chai';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { spawnRelayNode, spawnCircuitOnlyPeer, pickRelayWsAddr } from './util/relay-topology.js';

/** Distinct per-spec: the identify protocol ids are network-scoped, so a shared name lets specs cross-talk. */
const NETWORK = 'relay-inbound-source-address';

/**
 * Budget for the client's circuit address to reach the relay's peerStore AND show up in a
 * published record. Two chained debounces sit in that path — libp2p's `AddressManager` coalesces
 * listen-address changes for ~1000 ms before patching the self record, and `@libp2p/identify`
 * debounces the push a further `PUSH_DEBOUNCE_MS` (1000 ms). Deliberately generous; in practice it
 * lands in a couple of seconds.
 */
const PROPAGATION_TIMEOUT_MS = 20_000;

/** Fine enough to take tens of samples inside the ~1 s pre-reservation window. */
const POLL_MS = 20;

const KEY = new TextEncoder().encode('inbound-source-address-key');

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('findCluster never publishes an inbound connection\'s source address', function () {
	this.timeout(120_000);

	let relay: OptimysticNode | undefined;
	let client: OptimysticNode | undefined;

	afterEach(async () => {
		const toStop = [client, relay].filter((n): n is OptimysticNode => !!n);
		client = undefined; relay = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('publishes no address at all for a relay-only client until its circuit address arrives', async function () {
		this.timeout(60_000);

		// clusterSize 2: the cohort always reserves a slot for self and keeps `clusterSize - 1`
		// others, so at the topology default of 1 the relay's cohort would be self-only and the
		// client would never appear in a record at all.
		relay = await spawnRelayNode(NETWORK, { clusterSize: 2 });
		const relayWs = pickRelayWsAddr(relay);
		const relayNode = relay;

		// Sampling starts BEFORE the client exists: the bad window opens the moment its connection
		// lands, which is inside `spawnCircuitOnlyPeer`. The loop records every published entry for
		// whichever peer id the main flow hands it, and stops as soon as a good address appears.
		let clientId: string | undefined;
		let sawCircuitAddress = false;
		const samples: Array<{ atMs: number, addrs: string[] }> = [];
		const startedAt = Date.now();

		const sampler = (async () => {
			while (Date.now() - startedAt < PROPAGATION_TIMEOUT_MS) {
				const cluster = await relayNode.keyNetwork.findCluster(KEY);
				const entry = clientId === undefined ? undefined : cluster[clientId];
				if (entry !== undefined) {
					samples.push({ atMs: Date.now() - startedAt, addrs: entry.multiaddrs });
					if (entry.multiaddrs.some(a => a.includes('/p2p-circuit'))) {
						sawCircuitAddress = true;
						return;
					}
				}
				await sleep(POLL_MS);
			}
		})();

		client = await spawnCircuitOnlyPeer(NETWORK, relayWs);
		clientId = client.peerId.toString();
		await sampler;

		// Without this the negative assertion below could pass vacuously — an empty sample set has
		// no bad address in it either.
		expect(samples.length,
			'the relay never published a cohort entry for the client, so this spec asserted nothing')
			.to.be.greaterThan(0);

		// The client is circuit-only, so every address it legitimately has is a `/p2p-circuit` one;
		// its own advertised list is checked too, since that is the actual rule (an address the peer
		// itself claims, or one routed through a relay — never a socket WE observed it dial from).
		const advertised = new Set(client.getMultiaddrs().map(a => a.toString()));
		const bad = samples.flatMap(s => s.addrs
			.filter(a => !a.includes('/p2p-circuit') && !advertised.has(a))
			.map(a => `+${s.atMs}ms ${a}`));
		expect(bad,
			`the relay published address(es) for the client that nobody else can dial: ${JSON.stringify(bad)}`)
			.to.deep.equal([]);

		// The other direction: the record must still carry the client's real address once identify
		// has delivered it, or the filter is simply publishing nothing and the guard is worthless.
		expect(sawCircuitAddress,
			`the client's circuit address never reached a published record; samples: ${JSON.stringify(samples.slice(-5))}`)
			.to.equal(true);
	});
});
