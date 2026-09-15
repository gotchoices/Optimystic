/**
 * The third way a relay-only node used to lose its circuit address, and the one that needs no
 * network event at all: libp2p's own routine renewal of the reservation.
 *
 * `@libp2p/circuit-relay-v2` 4.1.3 refreshes a reservation `max(lifetime − 5 min, 30 s)` after it
 * was made, by REMOVING it and re-creating it. A listener on the relay-naming (configured) address
 * withdraws its circuit address on the removal and never re-applies the re-created reservation, so
 * at the relay's default two-hour lifetime every phone went unreachable about 1 h 55 min after it
 * reserved. The bare `/p2p-circuit` listener `planRelayListenAddrs` substitutes re-queues its
 * pending slot on the removal and publishes the re-created reservation, so the address is back
 * within the reservation round trip.
 *
 * The relay is given a 40 s lifetime so the refresh fires at its 30 s floor; the address is sampled
 * every 250 ms from the moment the node holds it until 38 s later. The round trip on loopback is a
 * few milliseconds, so the assertion is that the address is never absent at two consecutive samples
 * (with the old shape it is absent from 30 s on) — plus that the reservation was in fact renewed,
 * so the run cannot pass by the refresh never happening.
 *
 * ~40 s, so gated with the other real-socket specs:
 *   yarn workspace @optimystic/db-p2p test:integration
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import { delay } from '@optimystic/db-core/test';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { routesThroughRelay } from '../src/peer-address-book.js';
import { findCircuitRelayTransport, type RelayReservationStoreLike } from '../src/network/relay-reservation.js';
import { spawnPlainRelayNode, spawnCircuitOnlyPeer, pickRelayWsAddr } from './util/relay-topology.js';

const NETWORK = 'relay-reservation-refresh-it';

/** The relay-granted lifetime; the client refreshes 30 s in (its floor) because this is under 5 min. */
const RESERVATION_TTL_MS = 40_000;
/** Sampling window: well past the 30 s refresh, well short of the 40 s expiry. */
const WINDOW_MS = 38_000;
const SAMPLE_MS = 250;

const noLog = (): void => { /* the held check never logs on well-formed addresses */ };

const holdsCircuitVia = (node: Libp2p, relayPeerId: PeerId): boolean =>
	node.getMultiaddrs().some(a => routesThroughRelay(a.toString(), relayPeerId.toString(), noLog));

/** The store also exposes the granted reservation; `expire` is the relay's expiry in Unix seconds. */
type StoreWithReservations = RelayReservationStoreLike & {
	getReservation(peerId: PeerId): { expire: bigint | number } | undefined;
};

/** Length of the longest run of `false` in `samples`. */
function longestAbsence(samples: readonly boolean[]): number {
	let longest = 0;
	let run = 0;
	for (const held of samples) {
		run = held ? 0 : run + 1;
		longest = Math.max(longest, run);
	}
	return longest;
}

describe("libp2p's own reservation refresh does not lose the circuit address", function () {
	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});
	this.timeout(90_000);

	let relay: Libp2p | undefined;
	let phone: OptimysticNode | undefined;

	afterEach(async () => {
		const toStop = [phone?.stop(), relay?.stop()];
		phone = undefined;
		relay = undefined;
		await Promise.allSettled(toStop);
	});

	it('holds the address at every sample through the 30 s refresh, and the reservation is renewed', async () => {
		relay = await spawnPlainRelayNode(NETWORK, { reservationTtl: RESERVATION_TTL_MS });
		phone = await spawnCircuitOnlyPeer(NETWORK, pickRelayWsAddr(relay));
		const relayPeerId = relay.peerId;
		const store = findCircuitRelayTransport(phone)!.reservationStore as StoreWithReservations;
		expect(typeof store.getReservation, 'the seam spec pins the rest of the store; this spec needs getReservation too').to.equal('function');
		const granted = store.getReservation(relayPeerId);
		expect(granted, 'the phone holds a reservation at start').to.not.equal(undefined);
		const initialExpiry = Number(granted!.expire);

		const samples: boolean[] = [];
		const startedAt = Date.now();
		while (Date.now() - startedAt < WINDOW_MS) {
			samples.push(holdsCircuitVia(phone, relayPeerId));
			await delay(SAMPLE_MS);
		}

		const absent = samples.filter(held => !held).length;
		console.log(`      ${samples.length} samples over ${WINDOW_MS / 1000} s; address absent at ${absent}; longest absence ${longestAbsence(samples)} sample(s)`);
		expect(longestAbsence(samples), 'consecutive samples without the circuit address (the old shape loses it for good at 30 s)').to.be.lessThan(2);
		expect(samples[samples.length - 1], 'held at the end of the window').to.equal(true);
		expect(store.hasReservation(relayPeerId), 'the store still holds the reservation').to.equal(true);
		expect(Number(store.getReservation(relayPeerId)!.expire), 'the reservation was renewed: a later expiry than the one granted at start')
			.to.be.greaterThan(initialExpiry);
	});
});
