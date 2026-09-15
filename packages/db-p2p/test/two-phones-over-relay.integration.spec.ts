import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { waitFor } from '@optimystic/db-core/test';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { isLimitedConnection } from '../src/network/open-protocol-stream.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { spawnRestartablePlainRelay, waitForCircuitListen, type RestartablePlainRelay } from './util/relay-topology.js';
import { waitForPeerStoreProtocols } from './util/peer-store-wait.js';
import {
	attemptWrite, committedBlocks, createMachine, describeWriteAttempt, expectReadable, rowsFor, running,
	sequentialPhases, startMachine, stopMachine, waitForPair, waitUntilHeldLocally, writeRows,
	type Machine, type Row
} from './util/two-machine-lifecycle.js';

// Two phones in one group, end to end, with every byte between them crossing a circuit relay:
//
//   both write and read through the relay → each holds the other's data locally → one drops and
//   returns → both restart → the relay itself restarts.
//
// Two phones cannot dial each other directly, so a two-phone group only ever talks through a relay
// (`docs/architecture.md` § Supported deployment sizes). `multi-coordinator-write-relay.integration.spec.ts`
// proves one write whose second promise crosses a relay; this spec runs the lifecycle of
// `small-deployment-lifecycle.integration.spec.ts` over that path, plus the one fault only a relay has.
//
// TOPOLOGY. One relay from `spawnRestartablePlainRelay`: plain libp2p speaking identify and
// circuit-relay-v2 and no Optimystic protocol, so it is never a cohort candidate — the header of the
// multi-coordinator relay spec records the layout-dependent failures an Optimystic relay caused, and
// phase 1 asserts the relay is excluded for that reason. Two phone-shaped storage nodes with WebSockets
// and circuit transports only, listening only on `<relay>/p2p-circuit`. They share no direct transport,
// and loopback keeps DCUtR from upgrading the relayed link, so every A↔B stream rides the relay. That is
// asserted after every step that opens streams, not assumed, using production's `isLimitedConnection`.
//
// CONFIGURATION is the documented two-machine one, fixed by `startMachine` in
// `test/util/two-machine-lifecycle.ts`. The relay lifts libp2p's default per-circuit limit (128 KiB /
// 2 min), as every relay helper in `test/util/relay-topology.ts` does and as the relay Sereus deploys
// does (`ops/docker/libp2p-infra` in the sereus repository, `applyDefaultLimit: false` by default). A
// relay left at the default would reset these circuits; that posture is deliberate and is production's.
//
// RESTARTS follow the direct-TCP spec. A restarted phone's peer store is empty, so it cannot find its
// partner by peer id; it bootstraps through the relay and dials the partner's circuit address, the way a
// host application that enrolled the partner would. Unlike a fresh TCP port, that address survives
// restarts: it is built from the relay's address and the partner's key, and neither changes. So phase 3
// takes the stricter case the TCP spec cannot: the returning phone knows only its relay, and the phone
// that stayed up must find it again through its own peer store.
//
// Phases are separate `it`s over shared state (`sequentialPhases`) so the reporter names the phase that
// broke.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 like the other real-socket specs:
//   yarn workspace @optimystic/db-p2p test:integration

const NETWORK_NAME = 'two-phones-over-relay-it';
const TREE_ID = 'two-phones-over-relay-rows';

/** What a phone's peer store must show for the relay: identify negotiated, neither Optimystic protocol. */
const IDENTIFY_PROTOCOL = `/optimystic/${NETWORK_NAME}/id/1.0.0`;
const CLUSTER_PROTOCOL = `/optimystic/${NETWORK_NAME}/cluster/1.0.0`;
const REPO_PROTOCOL = `/optimystic/${NETWORK_NAME}/repo/1.0.0`;

/** Budget for a phone to hold a relay reservation, whether starting up or after the relay came back. */
const RESERVATION_TIMEOUT_MS = 30_000;

const hasCircuitAddress = (node: Libp2p): boolean =>
	node.getMultiaddrs().some(addr => addr.toString().includes('/p2p-circuit'));

/** The circuit address `machine` is reachable at. Only exists while the relay holds its reservation. */
async function circuitAddressOf(machine: Machine): Promise<string> {
	try {
		return (await waitForCircuitListen(running(machine), RESERVATION_TIMEOUT_MS)).toString();
	} catch (err) {
		throw new Error(`phone ${machine.name} holds no relay reservation: ${(err as Error).message}`);
	}
}

/**
 * Start `machine` phone-shaped: WebSockets and circuit transports only, listening only on the relay's
 * circuit. `partners` are the machines its host application enrolled; it dials each at its circuit
 * address. Resolves once the relay has granted this phone's reservation.
 */
async function startPhone(machine: Machine, relay: RestartablePlainRelay, partners: Machine[] = []): Promise<OptimysticNode> {
	const relayAddress = relay.wsAddr.toString();
	const partnerAddresses = await Promise.all(partners.map(circuitAddressOf));
	const node = await startMachine(machine, {
		bootstrapNodes: [relayAddress, ...partnerAddresses],
		relay: false,
		transports: [webSockets(), circuitRelayTransport()],
		listenAddrs: [`${relayAddress}/p2p-circuit`]
	});
	await circuitAddressOf(machine);
	return node;
}

/**
 * Every phone in `phones` holds a reservation on `relay` again. On timeout the error says, per phone, whether it
 * reconnected to the relay at all — which separates "nothing re-dialed the relay" from "re-dialed, never re-reserved".
 */
async function waitForReservations(phones: Machine[], relay: RestartablePlainRelay): Promise<void> {
	try {
		await waitFor(() => phones.every(phone => hasCircuitAddress(running(phone))),
			{ timeoutMs: RESERVATION_TIMEOUT_MS, intervalMs: 250, description: `${phones.map(p => p.name).join(' and ')} re-reserve on the restarted relay` });
	} catch (err) {
		const state = phones.map(phone => {
			const node = running(phone);
			return `${phone.name}: ${node.getConnections(relay.peerId).length} connection(s) to the relay, circuit address ${hasCircuitAddress(node) ? 'held' : 'absent'}`;
		});
		throw new Error(`${(err as Error).message} — ${state.join('; ')}`);
	}
}

/** Every connection between the two phones, seen from either side, rides the relay. */
function expectOnlyRelayed(a: Machine, b: Machine, label: string): void {
	for (const [from, to] of [[a, b], [b, a]] as const) {
		const connections = running(from).getConnections(running(to).peerId);
		expect(connections.length, `${label}: ${from.name} holds a connection to ${to.name}`).to.be.greaterThan(0);
		expect(connections.filter(c => !isLimitedConnection(c)).map(c => c.remoteAddr.toString()),
			`${label}: ${from.name}→${to.name} connections that are not relayed`).to.deep.equal([]);
	}
}

/**
 * The relay is out of every cohort for the reason intended: identify negotiated, so its protocol list
 * reached `observer`, and that list carries neither Optimystic protocol. A relay whose identify silently
 * failed would be excluded too, as an unclassified peer, and the cohort-size wait could not tell the two apart.
 */
async function expectRelayIsForeign(observer: Machine, relay: RestartablePlainRelay): Promise<void> {
	const view = await waitForPeerStoreProtocols(
		running(observer), relay.peerId, 20_000,
		protocols => protocols.includes(IDENTIFY_PROTOCOL)
	);
	expect(view.matched,
		`${observer.name} never saw the relay's identify protocol ${IDENTIFY_PROTOCOL}; its peer store holds: ${JSON.stringify(view.protocols)}`)
		.to.equal(true);
	expect(view.protocols, `the relay must not serve this network's cluster protocol (seen by ${observer.name})`).to.not.include(CLUSTER_PROTOCOL);
	expect(view.protocols, `the relay must not serve this network's repo protocol (seen by ${observer.name})`).to.not.include(REPO_PROTOCOL);
}

describe('Two phones over a relay (transact → replicate → one drops → both restart → relay restarts)', function () {
	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let relay: RestartablePlainRelay | undefined;
	let a: Machine;
	let b: Machine;
	/** Every row whose write was acknowledged, by key — the durability ledger every later phase checks. */
	const acknowledged = new Map<number, Row>();
	const acknowledge = (rows: Row[]) => { for (const row of rows) acknowledged.set(row.key, row); };

	const theRelay = (): RestartablePlainRelay => {
		if (!relay) throw new Error('the relay was never spawned');
		return relay;
	};

	sequentialPhases();

	before(async function () {
		relay = await spawnRestartablePlainRelay(NETWORK_NAME);
		a = await createMachine('A', NETWORK_NAME);
		b = await createMachine('B', NETWORK_NAME);
	});

	after(async function () {
		// All three together, so a torn-down relay cannot strand a phone's own stop path.
		await Promise.allSettled([...[a, b].filter(Boolean).map(stopMachine), relay?.stop()]);
	});

	it('phase 1 — both up through the relay: each writes, and each reads the other\'s rows', async function () {
		this.timeout(90_000);
		await startPhone(a, theRelay());
		await startPhone(b, theRelay(), [a]);
		await waitForPair(a, b);
		expectOnlyRelayed(a, b, 'once connected');
		await expectRelayIsForeign(a, theRelay());
		await expectRelayIsForeign(b, theRelay());

		const fromA = rowsFor('up-A', [1, 2]);
		await writeRows(a, TREE_ID, fromA);
		acknowledge(fromA);
		await expectReadable(b, TREE_ID, fromA, 'B reads A\'s rows');

		const fromB = rowsFor('up-B', [3, 4]);
		await writeRows(b, TREE_ID, fromB);
		acknowledge(fromB);
		await expectReadable(a, TREE_ID, fromB, 'A reads B\'s rows');

		expectOnlyRelayed(a, b, 'after both wrote');
	});

	it('phase 2 — replication, not read-through: each holds the other\'s blocks and serves every row with the writer stopped', async function () {
		this.timeout(180_000);
		await waitUntilHeldLocally(b, await committedBlocks(a), 'B holds every block A holds', 60_000);
		await waitUntilHeldLocally(a, await committedBlocks(b), 'A holds every block B holds', 60_000);

		await stopMachine(a);
		await expectReadable(b, TREE_ID, acknowledged.values(), 'B with A stopped');
		await startPhone(a, theRelay(), [b]);
		await waitForPair(a, b);
		expectOnlyRelayed(a, b, 'after A returned');

		await stopMachine(b);
		await expectReadable(a, TREE_ID, acknowledged.values(), 'A with B stopped');
		await startPhone(b, theRelay(), [a]);
		await waitForPair(a, b);
		expectOnlyRelayed(a, b, 'after B returned');
	});

	it('phase 3 — one drops: B stops, A writes, B returns knowing only the relay and A finds it again; every acknowledged row is on both', async function () {
		this.timeout(150_000);
		const nodeA = running(a);
		const bPeerId = running(b).peerId;
		await stopMachine(b);
		await waitFor(() => !nodeA.getPeers().some(p => p.equals(bPeerId)),
			{ timeoutMs: 10_000, intervalMs: 100, description: 'A notices B is gone' });

		const whileAway: Row = { key: 30, value: 'B-away-30' };
		const attempt = await attemptWrite(a, TREE_ID, [whileAway]);
		if (!attempt.refusal) acknowledge([whileAway]);

		// B returns knowing only its relay, with no partner address, so the pair reconnects only if A finds B again
		// on its own: B's circuit address is unchanged, and A's peer store still holds it. The other direction, a
		// restarted phone dialing its partner, is what phases 2 and 4 exercise.
		await startPhone(b, theRelay());
		await waitForPair(a, b);
		expectOnlyRelayed(a, b, 'after B returned');

		await expectReadable(a, TREE_ID, acknowledged.values(), 'A after B returned');
		await expectReadable(b, TREE_ID, acknowledged.values(), 'B after its restart');

		// Observed, not asserted, for the same reason as the direct-TCP spec's "one away" phase: whether a lone
		// survivor of a two-machine group should accept writes is under design
		// (tickets/backlog/more-design/6.5-partition-healing.md). Durability of what was acknowledged is asserted above.
		console.log(`      phase 3 observed: A's write with B away was ${await describeWriteAttempt(attempt, whileAway, TREE_ID, [a, b])}`);
	});

	it('phase 4 — both restart: every acknowledged row on each, and a new write from each crosses the relay', async function () {
		this.timeout(120_000);
		await Promise.all([stopMachine(a), stopMachine(b)]);
		await startPhone(a, theRelay());
		await startPhone(b, theRelay(), [a]);
		await waitForPair(a, b);
		expectOnlyRelayed(a, b, 'after both restarted');

		await expectReadable(a, TREE_ID, acknowledged.values(), 'A after both restarted');
		await expectReadable(b, TREE_ID, acknowledged.values(), 'B after both restarted');

		const fromA = rowsFor('restarted-A', [40]);
		await writeRows(a, TREE_ID, fromA);
		acknowledge(fromA);
		const fromB = rowsFor('restarted-B', [50]);
		await writeRows(b, TREE_ID, fromB);
		acknowledge(fromB);

		await expectReadable(b, TREE_ID, fromA, 'B reads A\'s row after both restarted');
		await expectReadable(a, TREE_ID, fromB, 'A reads B\'s row after both restarted');
		expectOnlyRelayed(a, b, 'after both wrote again');
	});

	it('phase 5 — the relay restarts: both phones re-reserve and reconnect without restarting, and a write from each crosses', async function () {
		this.timeout(120_000);
		const nodeA = running(a);
		const nodeB = running(b);
		await theRelay().stop();
		// The fault really happened: each phone's reservation went with the relay, and so did their link.
		await waitFor(() => !hasCircuitAddress(nodeA) && !hasCircuitAddress(nodeB) && nodeA.getConnections(nodeB.peerId).length === 0,
			{ timeoutMs: 15_000, intervalMs: 100, description: 'both phones lose their reservation and their link when the relay stops' });

		await theRelay().start();
		await waitForReservations([a, b], theRelay());
		await waitForPair(a, b);
		expectOnlyRelayed(a, b, 'after the relay restarted');

		const fromA = rowsFor('relay-restarted-A', [60]);
		await writeRows(a, TREE_ID, fromA);
		acknowledge(fromA);
		const fromB = rowsFor('relay-restarted-B', [70]);
		await writeRows(b, TREE_ID, fromB);
		acknowledge(fromB);

		await expectReadable(b, TREE_ID, fromA, 'B reads A\'s row after the relay restarted');
		await expectReadable(a, TREE_ID, fromB, 'A reads B\'s row after the relay restarted');
	});
});
