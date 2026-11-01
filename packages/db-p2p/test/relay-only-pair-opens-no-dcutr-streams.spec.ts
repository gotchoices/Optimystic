/**
 * Two relay-only peers that meet through a relay open no hole-punching streams to each other.
 *
 * A relay-only peer advertises nothing another machine can dial, so `@libp2p/dcutr` can never
 * upgrade a relayed connection to it: the side that received the connection makes three relayed
 * attempts to swap dialable addresses, and each fails because neither side has one. Measured
 * downstream (sereus `message-cost-accounting`, two phones through one relay) as nine
 * `/libp2p/dcutr` streams per join. Such a node is now built without the service
 * (`holePunchingWanted` in `src/network/hole-punching.ts`).
 *
 * Streams are counted the way that measurement counted them: every protocol list a connection's
 * `newStream` is asked for that names `/libp2p/dcutr`, whether or not negotiation succeeds. The
 * second case forces the service on, which pins `NodeOptions.holePunching: true` and proves the
 * counter sees dcutr's streams at all — without it, a counter that missed them would make the
 * first case pass vacuously.
 *
 * The relay is a plain libp2p relay, not an Optimystic node, so it is no party to the pair.
 * Runs in plain `yarn test`: three loopback boots and a few seconds of settling.
 */
import { expect } from 'chai';
import type { Connection } from '@libp2p/interface';
import type { Libp2p } from 'libp2p';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { spawnPlainRelayNode, spawnCircuitOnlyPeer, pickRelayWsAddr, waitForCircuitListen } from './util/relay-topology.js';
import { waitForPeerStoreProtocols } from './util/peer-store-wait.js';

/** Distinct per spec: identify protocol ids are network-scoped, so a shared name lets specs cross-talk. */
const NETWORK = 'relay-only-pair-dcutr';

const DCUTR_PROTOCOL = '/libp2p/dcutr';

/** Identify on the relayed connection is what starts dcutr, so the pair is waited on until each holds the other's protocols. */
const IDENTIFY_TIMEOUT_MS = 20_000;

/** dcutr acts as soon as identify lands and runs its three attempts back to back, so a short window suffices. */
const SETTLE_MS = 3_000;

/** Ceiling for the forced-on founder's first dcutr stream. */
const FIRST_STREAM_TIMEOUT_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Count, on every connection `node` opens or accepts from now on, each `newStream` call whose
 * protocol list names dcutr.
 */
function countDcutrStreamRequests(node: Libp2p): () => number {
	let requested = 0;
	node.addEventListener('connection:open', (evt: CustomEvent<Connection>) => {
		const connection = evt.detail;
		const newStream = connection.newStream.bind(connection);
		connection.newStream = (protocols, options) => {
			const asked = Array.isArray(protocols) ? protocols : [protocols];
			if (asked.includes(DCUTR_PROTOCOL)) requested++;
			return newStream(protocols, options);
		};
	});
	return () => requested;
}

async function waitForCount(count: () => number, atLeast: number, timeoutMs: number): Promise<number> {
	const start = Date.now();
	while (count() < atLeast && Date.now() - start < timeoutMs) await sleep(100);
	return count();
}

describe('a relay-only pair opens no hole-punching streams', function () {
	this.timeout(90_000);

	let relay: Libp2p | undefined;
	let founder: OptimysticNode | undefined;
	let joiner: OptimysticNode | undefined;

	afterEach(async () => {
		const toStop = [joiner, founder, relay].filter((n): n is Libp2p => !!n);
		joiner = undefined; founder = undefined; relay = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	/** Join the pair through the relay and return each side's dcutr stream counter. */
	async function joinThroughRelay(holePunching: boolean | undefined): Promise<{ founderStreams: () => number; joinerStreams: () => number }> {
		relay = await spawnPlainRelayNode(NETWORK);
		const relayWs = pickRelayWsAddr(relay);
		founder = await spawnCircuitOnlyPeer(NETWORK, relayWs, { holePunching });
		joiner = await spawnCircuitOnlyPeer(NETWORK, relayWs, { holePunching });
		const founderStreams = countDcutrStreamRequests(founder);
		const joinerStreams = countDcutrStreamRequests(joiner);

		const founderCircuit = await waitForCircuitListen(founder, IDENTIFY_TIMEOUT_MS);
		await joiner.dial(founderCircuit, { signal: AbortSignal.timeout(30_000) });

		const repoProtocol = `/optimystic/${NETWORK}/repo/1.0.0`;
		const founderSeesJoiner = await waitForPeerStoreProtocols(founder, joiner.peerId, IDENTIFY_TIMEOUT_MS, p => p.includes(repoProtocol));
		const joinerSeesFounder = await waitForPeerStoreProtocols(joiner, founder.peerId, IDENTIFY_TIMEOUT_MS, p => p.includes(repoProtocol));
		expect(founderSeesJoiner.matched, 'the founder never identified the joiner over the relayed connection').to.equal(true);
		expect(joinerSeesFounder.matched, 'the joiner never identified the founder over the relayed connection').to.equal(true);
		return { founderStreams, joinerStreams };
	}

	it('by default neither peer asks for a dcutr stream', async () => {
		const { founderStreams, joinerStreams } = await joinThroughRelay(undefined);
		await sleep(SETTLE_MS);
		expect(founderStreams(), 'dcutr streams the founder asked for').to.equal(0);
		expect(joinerStreams(), 'dcutr streams the joiner asked for').to.equal(0);
	});

	it('with holePunching forced on, the side that received the relayed connection asks for one', async () => {
		const { founderStreams } = await joinThroughRelay(true);
		expect(await waitForCount(founderStreams, 1, FIRST_STREAM_TIMEOUT_MS),
			'dcutr streams the founder asked for with the service forced on').to.be.at.least(1);
	});
});
