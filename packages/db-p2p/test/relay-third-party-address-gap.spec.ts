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
 * **Runtime.** ~0.4 s (three real libp2p boots over loopback), so it is not env-gated.
 *
 * NOTE: the mechanism is covered end-to-end through real libp2p, but split across two specs — this
 * one proves `peerStore.merge(carried address)` → a peer-id-only dial reaches a relay-only peer, and
 * `cluster-service-node-resolvers.spec.ts` proves an inbound `ClusterRecord` → that same address in a
 * real node's `peerStore`. No single spec joins the halves. That is fine while they meet at the one
 * `peerStore` object; if the ingress path ever grows a transform between the record and the merge
 * (address rewriting, a queue, a separate address store), build the joined case — a relay, a
 * relay-only member, and two host members exchanging a real record over real sockets.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, type Libp2pTransports } from '../src/libp2p-node.js';
import { spawnRelayNode, spawnCircuitOnlyPeer, pickRelayWsAddr, waitForCircuitListen } from './util/relay-topology.js';

/** Distinct per-spec: the identify protocol ids are network-scoped, so a shared name lets specs cross-talk. */
const NETWORK = 'relay-third-party-address-gap';

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
});
