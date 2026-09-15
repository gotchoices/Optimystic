/**
 * Pins the ONE place `@optimystic/db-p2p` reaches libp2p internals for relay reservations —
 * `findCircuitRelayTransport` in `src/network/relay-reservation.ts` — against the installed
 * `libp2p` 3.1.3 and `@libp2p/circuit-relay-v2` 4.1.3, on real started nodes over loopback.
 *
 * TRIPWIRE for a libp2p upgrade. The supervisor reaches through `node.components.transportManager`
 * to the circuit-relay transport's `reservationStore` because libp2p exposes no public "reserve on
 * THIS relay" route. If a bump moves or renames that seam the accessor returns `null`, every drive
 * fails soft with "no circuit-relay transport", and every relay-only node would silently be back to
 * never re-reserving — so the shape is pinned here to fail loudly instead.
 *
 * The last two cases pin the two libp2p facts the whole rewrite rests on: a bare `/p2p-circuit`
 * listener publishes a `discovered` reservation, and it never publishes a `configured` one.
 *
 * The relay is `spawnPlainRelayNode` — identify under a network prefix the stock-identify client
 * never negotiates — so libp2p's own relay discovery cannot nominate the relay and the reservation
 * seen here is the one requested through the seam. ~1 s on loopback; not env-gated.
 */
import { expect } from 'chai';
import { createLibp2p, type Libp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { webSockets } from '@libp2p/websockets';
import { identify } from '@libp2p/identify';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { waitFor } from '@optimystic/db-core/test';
import { routesThroughRelay } from '../src/peer-address-book.js';
import { CIRCUIT_SEARCH_LISTEN_ADDR, findCircuitRelayTransport } from '../src/network/relay-reservation.js';
import { spawnPlainRelayNode, pickRelayWsAddr } from './util/relay-topology.js';

const NETWORK = 'relay-reservation-seam';

const noLog = (): void => { /* the held check never logs on well-formed addresses */ };

/** Whether `node` advertises a circuit address through `relay`. */
const holdsCircuitVia = (node: Libp2p, relay: Libp2p): boolean =>
	node.getMultiaddrs().some(a => routesThroughRelay(a.toString(), relay.peerId.toString(), noLog));

/** A bare-listener ("search") client with stock identify, so the namespaced relay never nominates itself. */
async function startSearchClient(): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: [CIRCUIT_SEARCH_LISTEN_ADDR] },
		transports: [webSockets(), circuitRelayTransport()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: { identify: identify() }
	}) as unknown as Libp2p;
}

/** A client with no circuit-relay transport at all: it can never hold a reservation. */
async function startPlainClient(): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: [] },
		transports: [webSockets()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: { identify: identify() }
	}) as unknown as Libp2p;
}

describe('findCircuitRelayTransport (the libp2p internals seam)', function () {
	this.timeout(30_000);

	const nodes: Libp2p[] = [];
	const track = <T extends Libp2p>(node: T): T => { nodes.push(node); return node; };

	afterEach(async () => {
		await Promise.allSettled(nodes.splice(0).map(n => n.stop()));
	});

	it('finds the circuit-relay transport, its reservation store, and a removable relay filter on a started node', async () => {
		const client = track(await startSearchClient());
		const transport = findCircuitRelayTransport(client);
		expect(transport, 'libp2p internals moved: no transport with a reservationStore on node.components.transportManager').to.not.equal(null);
		expect(typeof transport!.reservationStore.addRelay).to.equal('function');
		expect(typeof transport!.reservationStore.hasReservation).to.equal('function');
		// `relayFilter` is a private field on the 4.1.3 store; `clearRelayFilterEntry` degrades without it,
		// so this pins that the un-poisoning step is still live rather than silently a no-op.
		expect(typeof transport!.reservationStore.relayFilter?.remove, 'reservationStore.relayFilter.remove').to.equal('function');
	});

	it('returns null for a node with no circuit-relay transport', async () => {
		const client = track(await startPlainClient());
		expect(findCircuitRelayTransport(client)).to.equal(null);
	});

	it("a bare listener publishes a circuit address for a 'discovered' reservation requested through the seam", async () => {
		const relay = track(await spawnPlainRelayNode(NETWORK));
		const client = track(await startSearchClient());
		await client.dial(pickRelayWsAddr(relay));
		// Nothing has asked yet, and discovery cannot: no address.
		expect(holdsCircuitVia(client, relay)).to.equal(false);

		const store = findCircuitRelayTransport(client)!.reservationStore;
		await store.addRelay(relay.peerId, 'discovered');
		expect(store.hasReservation(relay.peerId)).to.equal(true);
		await waitFor(() => holdsCircuitVia(client, relay),
			{ timeoutMs: 5_000, intervalMs: 50, description: 'the bare listener publishes the discovered reservation' });
	});

	it("a bare listener never publishes a 'configured' reservation — why the supervisor asks for 'discovered'", async () => {
		const relay = track(await spawnPlainRelayNode(NETWORK));
		const client = track(await startSearchClient());
		await client.dial(pickRelayWsAddr(relay));

		const store = findCircuitRelayTransport(client)!.reservationStore;
		await store.addRelay(relay.peerId, 'configured');
		expect(store.hasReservation(relay.peerId), 'the relay granted the slot').to.equal(true);
		// Bounded negative: on 4.1.3 the listener returns early for `configured`, so it stays absent. If a
		// libp2p upgrade makes this pass, the rewrite may no longer be needed — see the NOTE in
		// `libp2p-node-base.ts` at `planRelayListenAddrs`.
		await new Promise(resolve => setTimeout(resolve, 1_000));
		expect(holdsCircuitVia(client, relay), `a configured reservation was published by a bare listener: ${client.getMultiaddrs().join(', ')}`).to.equal(false);
	});
});
