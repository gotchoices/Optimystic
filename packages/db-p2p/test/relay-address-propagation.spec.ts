/**
 * Regression guard for gotchoices/Optimystic#7 — the reported defect, end to end.
 *
 * A peer reachable only through a relay obtains its usable address (the qualified `/p2p-circuit`
 * one) when the relay grants its reservation. That happens strictly *after* its first connection to
 * the relay, because the connection is what requests the reservation. So the one address anyone can
 * reach that peer on is precisely the address `identify()` — which runs once, at connection-open
 * time — cannot have carried.
 *
 * `identifyPush()` closes that gap: it subscribes to libp2p's `self:peer:update` and re-pushes the
 * address list to already-connected peers. With it missing, the relay's peerStore entry for the
 * client stays empty, and a later dial by peer id alone fails with `NoValidAddressesError` against a
 * peer that is genuinely reachable. (The gated control at the bottom of this file reproduces exactly
 * that, error name included.)
 *
 * Nothing else in this stack recovers from it, which is why the failure is deterministic rather than
 * intermittent: no peer-routing service is registered (no kad-dht, no `peerRouters`, so the dialer
 * has no `findPeer` fallback); FRET routes by peer id and carries no multiaddrs, silently skipping
 * peers it has no address for; and DCUtR upgrades an *existing* relayed connection rather than
 * establishing the first one.
 *
 * `identify-protocol-id.spec.ts` proves the push service is *registered*, and
 * `node-service-set.spec.ts` proves it is still in the services map. Registration is a necessary
 * condition for the reported bug, not the bug. This spec exercises the actual chain: reservation →
 * address propagation → reconnect.
 *
 * **Runtime.** The two default cases together take ~2 s (three real libp2p boots over loopback;
 * measured on a dev laptop), so unlike `circuit-relay-long-lived.spec.ts` they are NOT gated behind
 * `RUN_LONG_TESTS` — this repository has no CI, so a guard that only runs when someone remembers an
 * env var is a guard that does not run. Only the negative control is gated, because it asserts a
 * *timeout* and therefore always burns its full ~20 s propagation budget. To include it:
 *
 *   PowerShell: $env:RUN_LONG_TESTS_CONTROL=1; yarn workspace @optimystic/db-p2p test --grep "Relay address propagation"
 *   bash:        RUN_LONG_TESTS_CONTROL=1 yarn workspace @optimystic/db-p2p test --grep "Relay address propagation"
 */
import { expect } from 'chai';
import { createLibp2p, type Libp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, type Libp2pTransports } from '../src/libp2p-node.js';
import { spawnRelayNode, spawnCircuitOnlyPeer, pickRelayWsAddr, waitForCircuitListen } from './util/relay-topology.js';
import { waitForPeerStoreAddresses } from './util/peer-store-wait.js';
import { expectWellFormedProtocolIds } from './util/protocol-ids.js';

/** Distinct per-spec: the identify protocol ids are network-scoped, so a shared name lets specs cross-talk. */
const NETWORK = 'relay-address-propagation-it';

/**
 * Budget for a propagation to land. Two chained debounces sit in the path — libp2p's
 * `AddressManager` coalesces listen-address changes for ~1000 ms before patching the self record,
 * and `@libp2p/identify` debounces the push a further `PUSH_DEBOUNCE_MS` (1000 ms) — on top of the
 * relay reservation round trip. Deliberately generous: a false failure here would read as a
 * protocol regression. In practice the positive cases land in well under a second.
 */
const PROPAGATION_TIMEOUT_MS = 20_000;

const isCircuitAddr = (addr: string): boolean => addr.includes('/p2p-circuit');

/**
 * An ordinary peer with direct TCP + WebSocket listeners and the circuit transport — the
 * "already-connected neighbour" of the bug report. It needs the WS listener because the relay-only
 * client is WS-only and does the dialing, and it needs the circuit transport so it can later reach
 * the client back through the relay.
 */
async function spawnSiblingPeer(): Promise<Libp2p> {
	const transports: Libp2pTransports = [tcp(), webSockets(), circuitRelayTransport()];
	return await createLibp2pNode({
		port: 0,
		wsPort: 0,
		networkName: NETWORK,
		bootstrapNodes: [],
		relay: false,
		transports,
		listenAddrs: ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0/ws'],
		clusterSize: 1,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
		arachnode: { enableRingZulu: false }
	});
}

function pickWsAddr(node: Libp2p): Multiaddr {
	const ws = node.getMultiaddrs().map(a => a.toString()).find(a => a.includes('/ws/p2p/'));
	if (!ws) throw new Error(`No /ws multiaddr on node; have: ${node.getMultiaddrs().map(a => a.toString()).join(', ')}`);
	return multiaddr(ws);
}

/**
 * The same relay-only client shape as {@link spawnCircuitOnlyPeer}, hand-built WITHOUT
 * `identifyPush` — i.e. the pre-fix node. Everything else is held constant: same transports, same
 * circuit-only listen address, and `identify` under the same slash-less network-scoped prefix, so
 * the relay still learns the client's protocol list at connection-open time and the only variable
 * is whether *later* address changes are pushed.
 *
 * Deliberately hand-built rather than produced by `createLibp2pNodeBase`: `NodeOptions` has no seam
 * for removing a service, and adding one purely so a test can disable a fix would put the fix's own
 * kill switch into production code.
 */
async function spawnCircuitOnlyPeerWithoutPush(relayAddr: Multiaddr): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: [`${relayAddr.toString()}/p2p-circuit`] },
		transports: [webSockets(), circuitRelayTransport()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: {
			// Slash-LESS prefix: @libp2p/identify prepends the leading slash itself. Matches
			// `libp2p-node-base.ts`; see `identify-protocol-id.spec.ts` for why that asymmetry exists.
			identify: identify({ protocolPrefix: `optimystic/${NETWORK}` })
		}
	}) as unknown as Libp2p;
}

describe('Relay address propagation (identify/push)', function () {
	this.timeout(120_000);

	let relay: Libp2p | undefined;
	let client: Libp2p | undefined;
	let sibling: Libp2p | undefined;

	afterEach(async () => {
		const toStop = [client, sibling, relay].filter((n): n is Libp2p => !!n);
		client = undefined; sibling = undefined; relay = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('a relay-only peer\'s post-reservation circuit address reaches the already-connected relay\'s peerStore', async function () {
		this.timeout(60_000);

		relay = await spawnRelayNode(NETWORK);
		const relayWs = pickRelayWsAddr(relay);

		// Dialing the relay is what REQUESTS the reservation, so the address gained from it cannot
		// possibly have been carried by that same connection's initial identify exchange. This
		// ordering is what makes the case deterministic rather than a race.
		client = await spawnCircuitOnlyPeer(NETWORK, relayWs);
		const clientCircuitAddr = await waitForCircuitListen(client, 30_000);
		expect(clientCircuitAddr.toString(), 'the client published a qualified circuit address').to.include('/p2p-circuit');

		// The relay-only client is the one node shape no other always-run spec spawns, so the shared
		// whole-list protocol-id check is made here too — it is what catches a malformed id nobody
		// thought to name (`//optimystic/<net>/id/1.0.0`, gotchoices/Optimystic#6).
		expectWellFormedProtocolIds(client.getProtocols() as string[], 'relay-only circuit client');
		expectWellFormedProtocolIds(relay.getProtocols() as string[], 'circuit-relay server node');

		// The assertion has to be on the RELAY's peerStore entry for the client. The client's own
		// getMultiaddrs() (checked just above) proves the reservation succeeded; only this proves the
		// address propagated to the already-connected peer, which is what #7 broke. Pre-fix this list
		// stays empty forever — see the gated control below.
		const propagated = await waitForPeerStoreAddresses(relay, client.peerId, PROPAGATION_TIMEOUT_MS, isCircuitAddr);
		expect(propagated.matched,
			`relay never learned the client's circuit address; its peerStore holds: ${JSON.stringify(propagated.addresses)}`)
			.to.equal(true);

		// The reconnect half of the symptom is asserted in the next test, from a THIRD peer rather
		// than from here: libp2p refuses `relay.dial(clientPeerId)` with `InvalidPeerIdError: Can not
		// dial self`, because every propagated address routes through this very relay.
	});

	it('an already-connected sibling can re-dial the relay-only peer by peer id alone, with no caller-supplied address', async function () {
		this.timeout(60_000);

		relay = await spawnRelayNode(NETWORK);
		const relayWs = pickRelayWsAddr(relay);
		sibling = await spawnSiblingPeer();

		client = await spawnCircuitOnlyPeer(NETWORK, relayWs);
		await waitForCircuitListen(client, 30_000);

		// The client dials the sibling directly over WebSockets, so the sibling is an ordinary
		// already-connected neighbour. Honest scope note: unlike the relay in the test above, the
		// sibling's ordering is NOT controlled — its knowledge of the client's circuit address may
		// come from this connection's initial identify rather than from a push, so this case is not
		// itself an isolated #7 guard. What it does prove is the modality no other spec in this repo
		// covers: resolving a peer the way production does, from a peer id through the peerStore,
		// with no multiaddr supplied by the harness. Every multi-node spec here instead reads the
		// other node's live `getMultiaddrs()` in-process and hands it to the dialer, which bypasses
		// the peerStore entirely — the exact structure identifyPush exists to populate.
		await client.dial(pickWsAddr(sibling));

		const propagated = await waitForPeerStoreAddresses(sibling, client.peerId, PROPAGATION_TIMEOUT_MS, isCircuitAddr);
		expect(propagated.matched,
			`sibling never learned the client's circuit address; its peerStore holds: ${JSON.stringify(propagated.addresses)}`)
			.to.equal(true);

		// Drop the connection from both ends so the dialer has nothing warm to reuse and MUST resolve
		// the peer from the peerStore.
		await Promise.allSettled(sibling.getConnections(client.peerId).map(c => c.close()));
		await Promise.allSettled(client.getConnections(sibling.peerId).map(c => c.close()));
		expect(sibling.getConnections(client.peerId).length, 'no warm connection left to reuse').to.equal(0);

		// Not wrapped in a swallowing try/catch: the prevailing "a reciprocal dial covers this edge"
		// idiom elsewhere in this repo is exactly what makes these failures silent. The error name is
		// surfaced so a regression reports `NoValidAddressesError` rather than a bare assertion.
		let redialError: Error | undefined;
		let remotePeer: string | undefined;
		try {
			remotePeer = (await sibling.dial(client.peerId)).remotePeer.toString();
		} catch (err) {
			redialError = err as Error;
		}
		expect(redialError === undefined,
			`dial(peerId) with no caller-supplied address failed: ${redialError?.name} — ${redialError?.message}`)
			.to.equal(true);
		expect(remotePeer, 'the re-dial reached the client').to.equal(client.peerId.toString());
	});

	it('control: with identify/push absent the address never propagates and the peer-id-only dial fails', async function () {
		this.timeout(120_000);
		// Gated: this case asserts a TIMEOUT, so it always costs the full PROPAGATION_TIMEOUT_MS
		// (~20 s) in wall-clock, unlike the positive cases which land in well under a second.
		if (process.env.RUN_LONG_TESTS_CONTROL !== '1') this.skip();

		// Without this control the positive test could pass for an unrelated reason — e.g. the relay
		// learning the client's address through circuit-relay reservation bookkeeping rather than
		// through identify/push — and the spec would be green while guarding nothing.
		relay = await spawnRelayNode(NETWORK);
		const relayWs = pickRelayWsAddr(relay);

		client = await spawnCircuitOnlyPeerWithoutPush(relayWs);
		await client.dial(relayWs);
		await waitForCircuitListen(client, 30_000);

		const propagated = await waitForPeerStoreAddresses(relay, client.peerId, PROPAGATION_TIMEOUT_MS, isCircuitAddr);
		expect(propagated.matched,
			`without identify/push the relay should not learn a circuit address, but its peerStore holds: ${JSON.stringify(propagated.addresses)}`)
			.to.equal(false);

		await Promise.allSettled(relay.getConnections(client.peerId).map(c => c.close()));

		let redialError: Error | undefined;
		try {
			await relay.dial(client.peerId);
		} catch (err) {
			redialError = err as Error;
		}
		expect(redialError, 'the peer-id-only dial should fail with no propagated address').to.not.equal(undefined);
		// The exact error from the upstream report. Asserting the NAME (not just "it threw") is what
		// makes a future regression legible: a bare timeout or a transport error would mean something
		// else broke.
		expect(redialError?.name, 'the pre-fix failure mode is NoValidAddressesError').to.equal('NoValidAddressesError');
	});
});
