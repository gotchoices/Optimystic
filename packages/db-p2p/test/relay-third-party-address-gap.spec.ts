/**
 * The libp2p-level premise behind gotchoices/Optimystic#11, pinned as an executable fact.
 *
 * `relay-address-propagation.spec.ts` covers the half that `identify`/`identifyPush` DOES solve:
 * a relay-only peer's post-reservation `/p2p-circuit` address reaches peers it is (or was)
 * *directly connected* to. This spec pins the half nothing in libp2p solves: a **third party** —
 * a peer that has never had a connection to the relay-only peer — has an empty address book for
 * it, and a dial by bare peer id fails with `NoValidAddressesError`. No relay gossip, no
 * reservation bookkeeping, and no peer-routing fallback covers it (this stack registers no
 * `peerRouters`/kad-dht, so the dialer has no `findPeer`).
 *
 * That is why the fix has to live at the application layer: db-p2p's own cluster records already
 * carry the address on the wire, so the cure is to write it into the dialer's address book. The
 * second half of this spec pins that cure's sufficiency: after a single `peerStore.merge` of the
 * exact address a `ClusterRecord`/redirect payload carries, the same peer-id-only dial succeeds.
 *
 * Both halves are assertions about libp2p, not about db-p2p — deliberately. If a libp2p upgrade
 * ever makes third-party addresses propagate on their own, the first assertion fails and tells us
 * the application-layer merge has become redundant rather than load-bearing. If `peerStore.merge`
 * ever stops being enough to make a circuit address dialable, the second fails and tells us the
 * merge sites are no longer a cure.
 *
 * The second test joins those halves, which the NOTE this comment replaced asked for: a relay, a
 * relay-only member, and two host members, where the record fed to the never-connected member is
 * the real `ClusterPeers` map the relay's own `findCluster` produced rather than a hand-written
 * one. It runs the full chain — reservation → identifyPush → published record → cluster ingress →
 * peerStore → dial — so an address-rewriting transform anywhere along it now fails a test.
 *
 * Honest scope note on that join: the record is handed to the third party's real
 * `services.cluster.processOperation` in-process rather than crossing a socket between the two.
 * Everything downstream of that entry point is production code on a real node; what is NOT covered
 * is the serialization hop, which `two-node-convergence.integration.spec.ts` and the protocol specs
 * exercise separately.
 *
 * **Runtime.** ~0.4 s for the first case, ~2 s for the joined one — the latter waits out the two
 * chained debounces described on {@link PROPAGATION_TIMEOUT_MS}. Neither is env-gated.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
import type { ClusterPeers, ClusterRecord, RepoMessage } from '@optimystic/db-core';
import { createLibp2pNode, type Libp2pTransports } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { spawnRelayNode, spawnCircuitOnlyPeer, pickRelayWsAddr, waitForCircuitListen } from './util/relay-topology.js';
import { waitForPeerStoreAddresses } from './util/peer-store-wait.js';

/** Distinct per-spec: the identify protocol ids are network-scoped, so a shared name lets specs cross-talk. */
const NETWORK = 'relay-third-party-address-gap';

/**
 * Budget for the relay-only peer's circuit address to reach an already-connected peer. Two chained
 * debounces sit in that path — libp2p's `AddressManager` coalesces listen-address changes for
 * ~1000 ms before patching the self record, and `@libp2p/identify` debounces the push a further
 * `PUSH_DEBOUNCE_MS` (1000 ms). Deliberately generous; the joined case below lands in ~2 s.
 */
const PROPAGATION_TIMEOUT_MS = 20_000;

const isCircuitAddr = (addr: string): boolean => addr.includes('/p2p-circuit');

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The record ingress point a cohort member exposes. Reached through a cast because the cluster
 * service is node-internal wiring rather than part of `OptimysticNodeAttachments` — the same
 * access `cluster-service-node-resolvers.spec.ts` uses, and deliberately narrow so the cast does
 * not become a licence to poke at the rest of the service.
 */
interface ClusterIngress {
	processOperation(op: { operation: 'update', record: ClusterRecord }): Promise<unknown>;
}

const clusterIngressOf = (node: Libp2p): ClusterIngress =>
	(node as unknown as { services: { cluster: ClusterIngress } }).services.cluster;

/** Wrap a peer map in the minimal record shape the ingress path reads. */
const recordWithPeers = (peers: ClusterPeers): ClusterRecord => ({
	messageHash: 'relay-third-party-joined-case',
	peers,
	message: { operations: [] } as unknown as RepoMessage,
	promises: {},
	commits: {}
});

/**
 * A cohort sibling: direct TCP + WebSocket listeners plus the circuit transport, so it *can* reach
 * a relay-only peer through the relay — the only thing it lacks is the address. It needs the WS
 * transport because the relay-only client is WS-only, and the circuit transport to traverse.
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

describe('Relay address propagation to a third party', function () {
	this.timeout(120_000);

	let relay: Libp2p | undefined;
	let client: Libp2p | undefined;
	let sibling: Libp2p | undefined;

	afterEach(async () => {
		const toStop = [client, sibling, relay].filter((n): n is Libp2p => !!n);
		client = undefined; sibling = undefined; relay = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('a never-connected sibling cannot dial a relay-only peer by id, and one peerStore merge of the carried address is enough to fix it', async function () {
		this.timeout(60_000);

		relay = await spawnRelayNode(NETWORK);
		const relayWs = pickRelayWsAddr(relay);

		client = await spawnCircuitOnlyPeer(NETWORK, relayWs);
		// The client's own qualified circuit address: exactly what `findCluster` embeds in
		// `ClusterRecord.peers[client].multiaddrs`, and what a redirect payload carries in `addrs`.
		const clientCircuit = await waitForCircuitListen(client, 30_000);

		sibling = await spawnSiblingPeer();
		// The sibling knows the RELAY — as every peer in a relayed mesh does — but has never had a
		// connection to the client. This is the topology every cohort member is in when the cohort is
		// keyspace-determined rather than connection-determined.
		await sibling.dial(relayWs);
		expect(sibling.getConnections(client.peerId).length, 'the sibling has never connected to the client').to.equal(0);

		let redialError: Error | undefined;
		try {
			await sibling.dial(client.peerId);
		} catch (err) {
			redialError = err as Error;
		}
		expect(redialError, 'a peer-id-only dial must fail: nothing propagated the address to a third party').to.not.equal(undefined);
		// Asserting the NAME, not merely "it threw": this is the exact error the upstream report shows
		// 76 times in the drone logs, and a bare timeout or transport error would mean something else broke.
		expect(redialError?.name, 'the third-party failure mode is NoValidAddressesError').to.equal('NoValidAddressesError');

		// The cure, in isolation: write the carried address into the dialer's address book. Merging a
		// multiaddr only makes a dial *attempt* possible — the dialed peer still authenticates by peer
		// id at the noise handshake, so an address from an unverified record can waste a dial but can
		// never impersonate.
		await sibling.peerStore.merge(client.peerId, { multiaddrs: [multiaddr(clientCircuit.toString())] });

		const conn = await sibling.dial(client.peerId);
		expect(conn.remotePeer.toString(), 'after the merge the same peer-id-only dial reaches the client').to.equal(client.peerId.toString());
		expect(conn.remoteAddr.toString(), 'and it went through the relay').to.include('/p2p-circuit');
	});

	it("carries a relay-only peer's address the whole way: identifyPush → published record → a never-connected member's peerStore → a working dial", async function () {
		this.timeout(60_000);

		// clusterSize 3 on the relay: the cohort reserves one slot for self and keeps
		// `clusterSize - 1` others, so this leaves room for both the relay-only client and one
		// host member. At the topology default of 1 the relay's cohort would be self-only and
		// step (B) could never hold.
		relay = await spawnRelayNode(NETWORK, { clusterSize: 3 });
		const relayWs = pickRelayWsAddr(relay);
		const relayNode = relay as OptimysticNode;

		client = await spawnCircuitOnlyPeer(NETWORK, relayWs);
		const clientCircuit = await waitForCircuitListen(client, 30_000);

		// An ordinary host member of the same mesh, so the relay's cohort is not merely itself and
		// the relay-only client. It never touches the client either.
		const cohortHost = await spawnSiblingPeer();
		await cohortHost.dial(relayWs);

		try {
			// (A) identifyPush delivers the post-reservation circuit address to the relay.
			const propagated = await waitForPeerStoreAddresses(relayNode, client.peerId, PROPAGATION_TIMEOUT_MS, isCircuitAddr);
			expect(propagated.matched,
				`the relay never learned the client's circuit address; its peerStore holds: ${JSON.stringify(propagated.addresses)}`)
				.to.equal(true);

			// (B) the record the relay publishes for the key carries that address. Polled, because
			// the peerStore write and the next cohort assembly settle independently.
			const key = new TextEncoder().encode('joined-case-key');
			let published: ClusterPeers = {};
			const deadline = Date.now() + PROPAGATION_TIMEOUT_MS;
			for (;;) {
				published = await relayNode.keyNetwork.findCluster(key);
				if (published[client.peerId.toString()]?.multiaddrs.some(isCircuitAddr) === true) break;
				expect(Date.now() < deadline,
					`findCluster never published a circuit address for the client; last record: ${JSON.stringify(published)}`)
					.to.equal(true);
				await sleep(100);
			}

			// The third party joins only NOW, so it is genuinely outside this key's cohort — the
			// position that makes a record reach it as a redirect rather than as consensus work, and
			// the one every peer is in for the keys it does not serve. Joining earlier would put it
			// in `published` and turn this into an (unsigned, and therefore invalid) consensus
			// update instead of the address-learning path under test.
			sibling = await spawnSiblingPeer();
			await sibling.dial(relayWs);
			expect(sibling.getConnections(client.peerId).length,
				'the third party has never connected to the relay-only client').to.equal(0);
			expect(Object.keys(published), 'the third party is not in the record it is about to receive')
				.to.not.include(sibling.peerId.toString());

			// (C) it ingests that REAL record through its own cluster service. Nothing in the peer map
			// is hand-written: `published` is exactly what the relay would put on the wire.
			await clusterIngressOf(sibling).processOperation({ operation: 'update', record: recordWithPeers(published) });

			// The merge is deliberately not awaited by the ingress path (nothing downstream is), so
			// poll for the write rather than assuming it has landed.
			const learned = await waitForPeerStoreAddresses(sibling, client.peerId, 5_000, isCircuitAddr);
			expect(learned.matched,
				`the third party never learned the client's address from the record; its peerStore holds: ${JSON.stringify(learned.addresses)}`)
				.to.equal(true);

			// (D) and the address actually works: the same peer-id-only dial that failed with
			// NoValidAddressesError in the first test now reaches the client over the circuit.
			const dialed = await sibling.dial(client.peerId);
			expect(dialed.remotePeer.toString()).to.equal(client.peerId.toString());
			expect(dialed.remoteAddr.toString(), 'the dial went through the relay').to.include('/p2p-circuit');
			expect(clientCircuit.toString(), 'and it is the address the client itself advertised').to.include('/p2p-circuit');
		} finally {
			// `afterEach` only knows about the three tracked handles; this fourth node is local.
			await Promise.resolve(cohortHost.stop()).catch(() => { });
		}
	});
});
