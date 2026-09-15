/**
 * The relay-reservation supervisor (`src/network/relay-reservation.ts`) keeps a relay-only node's
 * circuit reservation alive across the faults that used to lose it for good.
 *
 * Three groups:
 *
 * 1. Through `createLibp2pNode`, at production timings, on the phone shape (`spawnCircuitOnlyPeer`)
 *    against a restartable plain relay: the relay restarts with no partner to reconnect the node
 *    (stricter than phase 5 of `two-phones-over-relay.integration.spec.ts`, where each phone's dials
 *    to the other reconnect the relay), and the relay hangs up while staying up.
 * 2. The supervisor on its own, over plain libp2p nodes at test timings: recovery after a relay
 *    restart, the two halves of `stop()`, and the accepted-tradeoff case where libp2p's relay
 *    discovery has filled the pending slot with a reservation on a different relay.
 * 3. Startup: a relay that cannot be reserved and a missing circuit transport still reject node
 *    creation. The rollback half of that contract (a rejected startup releases the listener port)
 *    lives in `startup-rollback.spec.ts` next to its siblings.
 *
 * libp2p's own refresh of a reservation is the third fault; it needs 40 s and lives in
 * `relay-reservation-refresh.integration.spec.ts`.
 *
 * Every relay here is `spawnPlainRelayNode`-shaped: identify under a network prefix a stock-identify
 * client never negotiates, so libp2p's relay discovery cannot nominate it and whatever brings an
 * address back is the supervisor. The one exception is the discoverable relay in the slot-taken
 * case, which exists precisely to be nominated.
 *
 * Group 1 takes a few seconds each (the retry that lands is the first or second, at 1–2 s); group 2
 * runs at 250 ms timings. Not env-gated.
 */
import { expect } from 'chai';
import net from 'node:net';
import { createLibp2p, type Libp2p } from 'libp2p';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { webSockets } from '@libp2p/websockets';
import { identify } from '@libp2p/identify';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { delay, waitFor } from '@optimystic/db-core/test';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { routesThroughRelay } from '../src/peer-address-book.js';
import {
	CIRCUIT_SEARCH_LISTEN_ADDR,
	DEFAULT_RELAY_DRIVE_TIMEOUT_MS,
	DEFAULT_RELAY_MAX_BACKOFF_MS,
	superviseRelayReservation,
	type RelayReservationSupervisor,
	type RelayReservationSupervisorOptions,
	type SupervisedRelay
} from '../src/network/relay-reservation.js';
import { spawnCircuitOnlyPeer, spawnRestartablePlainRelay, pickRelayWsAddr, type RestartablePlainRelay } from './util/relay-topology.js';

/** Distinct per-spec: the identify protocol ids are network-scoped, so a shared name lets specs cross-talk. */
const NETWORK = 'relay-reservation-supervisor';

const noLog = (): void => { /* the held check never logs on well-formed addresses */ };

/** Whether `node` advertises a circuit address through the relay `relayPeerId`. */
const holdsCircuitVia = (node: Libp2p, relayPeerId: PeerId): boolean =>
	node.getMultiaddrs().some(a => routesThroughRelay(a.toString(), relayPeerId.toString(), noLog));

/** Budget for a lost address to come back: the production backoff cap plus slack. */
const RECOVERY_TIMEOUT_MS = DEFAULT_RELAY_MAX_BACKOFF_MS + 10_000;

/** A syntactically valid relay address with nothing listening behind it (refused fast). */
async function deadRelayAddr(transportSuffix = '/ws'): Promise<string> {
	const key = await generateKeyPair('Ed25519');
	return `/ip4/127.0.0.1/tcp/1${transportSuffix}/p2p/${peerIdFromPrivateKey(key).toString()}`;
}

/**
 * A relay address whose dial HANGS rather than being refused, so a supervisor stopped while dialing
 * it has something to abort: a local TCP server that accepts the socket and never answers the
 * WebSocket handshake. Local on purpose — a black-holed public address hangs on most hosts but is
 * refused at once on one with no default route, which would make the abort untested, not broken.
 */
async function silentRelay(): Promise<SupervisedRelay & { close(): Promise<void> }> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as net.AddressInfo;
	const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
	return {
		dialAddr: `/ip4/127.0.0.1/tcp/${port}/ws/p2p/${peerId}`,
		peerId,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	};
}

describe('a relay-only node keeps its reservation itself (through createLibp2pNode)', function () {
	this.timeout(120_000);

	let relay: RestartablePlainRelay | undefined;
	let phone: OptimysticNode | undefined;

	afterEach(async () => {
		const toStop = [phone?.stop(), relay?.stop()];
		phone = undefined;
		relay = undefined;
		await Promise.allSettled(toStop);
	});

	it('holds its reservation the moment createLibp2pNode resolves', async () => {
		relay = await spawnRestartablePlainRelay(NETWORK);
		phone = await spawnCircuitOnlyPeer(NETWORK, relay.wsAddr);
		// The factory awaits the first drive, so there is no window in which the node is up but unreachable.
		expect(holdsCircuitVia(phone, relay.peerId), `no circuit address through the relay: ${phone.getMultiaddrs().join(', ')}`).to.equal(true);
	});

	it('re-reserves after the relay restarts, with no partner to reconnect it', async () => {
		relay = await spawnRestartablePlainRelay(NETWORK);
		phone = await spawnCircuitOnlyPeer(NETWORK, relay.wsAddr);
		const node = phone;
		const relayPeerId = relay.peerId;

		await relay.stop();
		await waitFor(() => !holdsCircuitVia(node, relayPeerId),
			{ timeoutMs: 15_000, intervalMs: 100, description: 'the address goes with the relay' });

		// Same key, same address. Nobody dials the relay from here on but the node's own supervisor.
		const restartedAt = Date.now();
		await relay.start();
		await waitFor(() => holdsCircuitVia(node, relayPeerId),
			{ timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: 100, description: 'the address comes back on its own after the relay restarts' });
		console.log(`      re-reserved ${Date.now() - restartedAt} ms after the relay came back`);
	});

	it('re-reserves after the relay hangs up on it while staying up', async () => {
		relay = await spawnRestartablePlainRelay(NETWORK);
		phone = await spawnCircuitOnlyPeer(NETWORK, relay.wsAddr);
		const node = phone;
		const relayPeerId = relay.peerId;
		const before = node.getConnections(relayPeerId).map(c => c.id);
		expect(before.length, 'a connection to the relay to hang up').to.be.greaterThan(0);

		// The reservation is bound to the connection it was made on, so the hang-up withdraws the address.
		// The withdrawal can be shorter than a poll interval — libp2p's discovery may refill the slot
		// within milliseconds once the hop protocol is in the peer store — so what is asserted is the
		// outcome: a NEW connection to the relay carrying a reservation, never the old one.
		const hungUpAt = Date.now();
		await relay.node.hangUp(node.peerId);
		await waitFor(() => {
			const now = node.getConnections(relayPeerId).map(c => c.id);
			return now.length > 0 && now.every(id => !before.includes(id)) && holdsCircuitVia(node, relayPeerId);
		}, { timeoutMs: RECOVERY_TIMEOUT_MS, intervalMs: 50, description: 'a fresh relay connection holding a reservation' });
		console.log(`      re-reserved ${Date.now() - hungUpAt} ms after the relay hung up`);
	});
});

/** Supervisor timings for the specs: quarter-seconds, not the production seconds. */
const FAST: RelayReservationSupervisorOptions = {
	driveTimeoutMs: 2_000,
	checkMs: 250,
	minBackoffMs: 250,
	maxBackoffMs: 1_000,
	pollMs: 50
};

const relayOf = (relay: RestartablePlainRelay): SupervisedRelay =>
	({ dialAddr: relay.wsAddr.toString(), peerId: relay.peerId.toString() });

/** A bare-listener client with stock identify, so the namespaced relays never nominate themselves. */
async function startSearchClient(): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: [CIRCUIT_SEARCH_LISTEN_ADDR] },
		transports: [webSockets(), circuitRelayTransport()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: { identify: identify() }
	}) as unknown as Libp2p;
}

/** A relay with STOCK identify: the search client identifies it, so libp2p's relay discovery nominates it. */
async function startDiscoverableRelay(): Promise<Libp2p> {
	return await createLibp2p({
		addresses: { listen: ['/ip4/127.0.0.1/tcp/0/ws'] },
		transports: [webSockets()],
		connectionEncrypters: [noise()],
		streamMuxers: [yamux()],
		services: { identify: identify(), relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } }) }
	}) as unknown as Libp2p;
}

describe('superviseRelayReservation (one relay, test timings)', function () {
	this.timeout(60_000);

	const nodes: Libp2p[] = [];
	const track = <T extends Libp2p>(node: T): T => { nodes.push(node); return node; };
	let relay: RestartablePlainRelay | undefined;
	let supervisor: RelayReservationSupervisor | undefined;

	afterEach(async () => {
		supervisor?.stop();
		supervisor = undefined;
		const stopping = [relay?.stop(), ...nodes.splice(0).map(n => n.stop())];
		relay = undefined;
		await Promise.allSettled(stopping);
	});

	it('gets the reservation back after the relay restarts, with nothing driving it from outside', async () => {
		relay = await spawnRestartablePlainRelay(NETWORK);
		const client = track(await startSearchClient());
		supervisor = superviseRelayReservation(client, relayOf(relay), FAST);
		expect(await supervisor.firstDrive).to.equal(null);
		expect(holdsCircuitVia(client, relay.peerId)).to.equal(true);
		expect(supervisor.lastError).to.equal(null);

		const relayPeerId = relay.peerId;
		await relay.stop();
		await waitFor(() => !holdsCircuitVia(client, relayPeerId), { timeoutMs: 10_000, intervalMs: 50, description: 'the address drains' });
		await waitFor(() => supervisor!.lastError !== null, { timeoutMs: 10_000, intervalMs: 50, description: 'a failed drive is recorded' });

		await relay.start();
		await waitFor(() => holdsCircuitVia(client, relayPeerId), { timeoutMs: 15_000, intervalMs: 50, description: 'the reservation comes back' });
		await waitFor(() => supervisor!.lastError === null, { timeoutMs: 5_000, intervalMs: 50, description: 'the error clears once held' });
	});

	it('stopped mid-backoff: no retry is pending, and nothing dials the relay when it appears', async () => {
		relay = await spawnRestartablePlainRelay(NETWORK);
		const target = relayOf(relay);
		await relay.stop();
		const client = track(await startSearchClient());

		supervisor = superviseRelayReservation(client, target, FAST);
		const reason = await supervisor.firstDrive;
		expect(reason, 'the first drive names the dial failure').to.contain(`dial to relay ${target.dialAddr} failed`);
		await waitFor(() => !supervisor!.driving && supervisor!.retryAtMs !== null,
			{ timeoutMs: 5_000, intervalMs: 20, description: 'a retry to be scheduled' });
		supervisor.stop();
		expect(supervisor.retryAtMs).to.equal(null);

		// The relay appears where the supervisor was looking. Nothing must notice.
		await relay.start();
		let dialsFromClient = 0;
		relay.node.addEventListener('peer:connect', evt => { if (evt.detail.equals(client.peerId)) dialsFromClient++; });
		await delay(FAST.maxBackoffMs! * 3);
		expect(dialsFromClient, 'connections the stopped supervisor opened to the relay').to.equal(0);
		expect(holdsCircuitVia(client, relay.peerId)).to.equal(false);
		expect(() => supervisor!.stop(), 'a second stop').to.not.throw();
	});

	it('stopped mid-drive: the in-flight dial is aborted and the first drive settles at once', async () => {
		const client = track(await startSearchClient());
		const silent = await silentRelay();
		try {
			supervisor = superviseRelayReservation(client,
				{ dialAddr: silent.dialAddr, peerId: silent.peerId },
				{ ...FAST, driveTimeoutMs: 20_000 });
			await delay(300);
			expect(supervisor.driving, 'the dial to a server that never answers is still in flight').to.equal(true);

			const stoppedAt = Date.now();
			supervisor.stop();
			const reason = await supervisor.firstDrive;
			expect(Date.now() - stoppedAt, 'ms until the first drive settled after stop').to.be.lessThan(1_000);
			expect(reason).to.be.a('string');
			expect(supervisor.retryAtMs).to.equal(null);
			// `firstDrive` settles on stop itself; the dial unwinds when libp2p honours the abort. Far below the
			// 20 s drive deadline is what proves the abort reached the dial rather than the deadline ending it.
			await waitFor(() => !supervisor!.driving, { timeoutMs: 3_000, intervalMs: 20, description: 'the aborted dial to unwind' });
			expect(Date.now() - stoppedAt, 'ms until the in-flight dial unwound after stop').to.be.lessThan(3_000);
		} finally {
			await silent.close();
		}
	});

	it('a slot already filled through another relay is reported, retried at the cap, and taken back once that reservation drops', async () => {
		// The accepted tradeoff recorded at `planRelayListenAddrs` in `libp2p-node-base.ts`: a bare listener
		// turns on relay discovery, which reserves on ANY connected hop-serving peer. Here that peer is a
		// stock-identify relay the client identifies; the supervised relay is the namespaced one.
		const other = track(await startDiscoverableRelay());
		relay = await spawnRestartablePlainRelay(NETWORK);
		const client = track(await startSearchClient());
		await client.dial(pickRelayWsAddr(other));
		await waitFor(() => holdsCircuitVia(client, other.peerId),
			{ timeoutMs: 10_000, intervalMs: 50, description: 'discovery reserves on the discoverable relay' });

		supervisor = superviseRelayReservation(client, relayOf(relay), FAST);
		const reason = await supervisor.firstDrive;
		expect(reason).to.contain('already filled');
		// Per-relay "held": the other relay's address does not satisfy this supervisor.
		expect(holdsCircuitVia(client, relay.peerId)).to.equal(false);
		await waitFor(() => !supervisor!.driving && supervisor!.retryAtMs !== null,
			{ timeoutMs: 5_000, intervalMs: 20, description: 'the retry to be scheduled' });
		expect(supervisor.retryAtMs! - Date.now(), 'the retry waits the backoff cap, not the minimum')
			.to.be.greaterThan(FAST.minBackoffMs! * 2);

		// The other reservation drops; the freed slot goes to the named relay, driven by the address change.
		await other.stop();
		await waitFor(() => holdsCircuitVia(client, relay!.peerId),
			{ timeoutMs: 15_000, intervalMs: 50, description: 'the named relay takes the freed slot' });
	});
});

describe('startup still rejects when the named relay cannot be reserved', function () {
	this.timeout(60_000);

	const scaffold = {
		networkName: NETWORK,
		bootstrapNodes: [] as string[],
		relay: false,
		clusterSize: 1,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
		arachnode: { enableRingZulu: false }
	};

	/** Run a node creation that must reject; stop the node and fail if it resolved instead. */
	async function rejectionFrom(create: () => Promise<OptimysticNode>): Promise<Error> {
		let node: OptimysticNode | undefined;
		try {
			node = await create();
		} catch (err) {
			return err as Error;
		}
		await node.stop();
		throw new Error('expected createLibp2pNode to reject, but it resolved');
	}

	it('an unreachable relay rejects node creation, naming the relay', async () => {
		const dead = await deadRelayAddr();
		const rejected = await rejectionFrom(() => spawnCircuitOnlyPeer(NETWORK, multiaddr(dead)));
		expect(rejected.message).to.contain('could not reserve a circuit on relay');
		expect(rejected.message).to.contain(dead);
	});

	it('a listen address naming a relay combined with announceAddrs rejects before anything is built', async () => {
		const dead = await deadRelayAddr();
		const startedAt = Date.now();
		const rejected = await rejectionFrom(() => spawnCircuitOnlyPeer(NETWORK, multiaddr(dead), { announceAddrs: ['/dns4/phone.example.com/tcp/443/wss'] }));
		expect(rejected.message).to.contain('announceAddrs');
		expect(rejected.message).to.contain(dead);
		// Rejected by the plan, not by a drive that waited its full deadline for an address that can never appear.
		expect(Date.now() - startedAt, 'ms until rejection').to.be.lessThan(DEFAULT_RELAY_DRIVE_TIMEOUT_MS);
	});

	it('a listen address naming a relay with no circuit-relay transport rejects, naming the omission', async () => {
		const dead = await deadRelayAddr();
		const rejected = await rejectionFrom(() => createLibp2pNode({
			...scaffold,
			port: 0,
			transports: [webSockets()],
			listenAddrs: [`${dead}/p2p-circuit`]
		}));
		expect(rejected.message).to.contain('no circuit-relay transport');
		expect(rejected.message).to.contain('circuitRelayTransport()');
	});
});
