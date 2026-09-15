import { routingKeyForBlock } from '@optimystic/db-core';
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, IBlock, BlockHeader, Transforms } from '@optimystic/db-core';
import { waitFor, waitForValue } from '@optimystic/db-core/test';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, type Libp2pTransports } from '../src/libp2p-node.js';
import { isLimitedConnection } from '../src/network/open-protocol-stream.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { spawnPlainRelayNode, pickRelayWsAddr, waitForCircuitListen } from './util/relay-topology.js';
import { waitForPeerStoreProtocols } from './util/peer-store-wait.js';

// Relay-topology variant of `multi-coordinator-write-stream-reset-supermajority`.
//
// The clean direct-TCP repro (`multi-coordinator-write.integration.spec.ts`) PASSES on main — a
// 2-of-2 write over a direct connection works. This variant forces the inter-coordinator promise
// stream over a LIMITED (circuit-relay) connection, the Sereus-realistic condition: two always-on
// storage nodes behind NAT reach each other only through a reference/relay node, so the
// coordinator's dial-back to collect the second promise runs `newStream(..., {
// runOnLimitedConnection: true })` over the relayed connection. If a relayed inter-coordinator
// stream is the thing that resets, this reproduces case (a) where the direct-TCP test does not.
//
// Both storage peers are browser-shaped (WS + circuit transports only, listening ONLY on
// `<relay>/p2p-circuit`): they have no direct transport to each other and loopback blocks DCUtR
// upgrade, so every node↔node stream stays on the relay.
//
// WHY THE RELAY IS NOT AN OPTIMYSTIC NODE
// ---------------------------------------
// It is a hand-assembled libp2p node (`spawnPlainRelayNode`) that speaks identify and
// circuit-relay-v2 and nothing else — deliberately, and the spec asserts on it below.
//
// This spec needs B in A's cohort, otherwise there is no second promise and nothing crosses the
// relay. At the `clusterSize: 2` used here there is exactly ONE non-self cohort slot, and an
// Optimystic relay serves this network's `cluster`/`repo` protocols, so it competes with B for
// that slot — `spawnPlainRelayNode` in `test/util/relay-topology.ts` carries the `findCluster`
// mechanics. Which of the two wins a given key follows from the run's random peer-id layout and
// is fixed for the whole run, so on an unlucky layout every probed key misses together.
//
// Two earlier preconditions failed on exactly this, and neither failure was a convergence
// problem: a captured skipping run had `serves=2 unknown=0 foreignDropped=0` and `fretCohort=3`,
// i.e. A had B fully classified and on the ring, and still handed the slot to the relay for all
// 24 probed keys. The first precondition gated on a single fixed probe id; its replacement
// searched 24 ids and called `this.skip()` when none placed B in the cohort, which self-skipped 3
// runs in 45 on an unchanged tree. Probing more ids lowers that rate and never removes it.
//
// A relay that is not a keyspace participant removes the lottery instead of making it rarer:
// classified `foreign`, it is dropped from every cohort, so A and B are the only serving peers
// and the single non-self slot can only be B — for every key, on every peer-id layout. The
// precondition below is therefore a poll on the real predicate that fails RED, not a skip.
//
// Gated on OPTIMYSTIC_INTEGRATION=1. Slow (two real Optimystic nodes + a relay + reservations +
// FRET over relay). Run via:
//   OPTIMYSTIC_INTEGRATION=1 npm run test:integration --workspace @optimystic/db-p2p

const NETWORK_NAME = 'multi-coord-write-relay-it';

/**
 * One fixed block id — no keyspace search. Every key's cohort is `{A, B}` once the relay is out
 * of the keyspace, so there is nothing left for a search to vary over.
 */
const BLOCK_ID = 'mcw-relay-block';

/** What A's peerStore must show for the relay: identify negotiated, neither Optimystic protocol. */
const IDENTIFY_PROTOCOL = `/optimystic/${NETWORK_NAME}/id/1.0.0`;
const CLUSTER_PROTOCOL = `/optimystic/${NETWORK_NAME}/cluster/1.0.0`;
const REPO_PROTOCOL = `/optimystic/${NETWORK_NAME}/repo/1.0.0`;

/**
 * Budget for A's cohort for {@link BLOCK_ID} to include B. It waits out connection setup, the
 * identify exchange (`findCluster` refuses a peer whose protocol list has not arrived) and FRET
 * classification. Generous: if this ever times out, something is genuinely broken and the spec
 * must say so rather than skip.
 *
 * NOTE: a genuinely-failing run therefore burns the full 60 s before reporting red (measured: the
 * negative control that puts an Optimystic relay back in the keyspace times out here at 60 s,
 * against a ~0.4 s passing run). That is the right trade while this never fires; if this wait
 * ever starts failing routinely and the suite's wall clock matters, shorten it — the diagnosis is
 * in the description string, not in the extra seconds.
 */
const COHORT_TIMEOUT_MS = 60_000;

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});
const makeBlock = (id: string): IBlock => ({ header: makeHeader(id) });
const makeTransforms = (blockId: string): Transforms => ({
	inserts: { [blockId]: makeBlock(blockId) },
	updates: {},
	deletes: []
});

// A browser-shaped storage node: WS + circuit only, listening on the relay's circuit.
// clusterSize:2 so for every block BOTH storage nodes are in the cohort.
async function spawnBrowserShapedCoordinator(relayWs: Multiaddr): Promise<OptimysticNode> {
	const transports: Libp2pTransports = [webSockets(), circuitRelayTransport()];
	return await createLibp2pNode({
		port: 0,
		networkName: NETWORK_NAME,
		bootstrapNodes: [relayWs.toString()],
		relay: false,
		transports,
		listenAddrs: [`${relayWs.toString()}/p2p-circuit`],
		fretProfile: 'core',
		clusterSize: 2,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0, superMajorityThreshold: 0.67 },
		arachnode: { enableRingZulu: false }
	});
}

describe('Multi-coordinator write over a relay (limited inter-coordinator stream)', function () {
	this.timeout(180_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let relay: Libp2p | undefined;
	let a: OptimysticNode | undefined;
	let b: OptimysticNode | undefined;

	afterEach(async () => {
		const toStop = [a, b, relay].filter((n): n is Libp2p => !!n);
		a = undefined; b = undefined; relay = undefined;
		// Stopped together rather than relay-first, so a torn-down circuit cannot strand the
		// coordinators' own stop paths.
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('a 2-of-2 write whose second promise crosses the relay reaches super-majority', async function () {
		// A PLAIN relay, not `spawnRelayNode`. An Optimystic relay serves this network's
		// cluster/repo protocols, which makes it a cohort candidate competing with B for the one
		// non-self slot — the lottery described in the header. Do not "simplify" this back.
		relay = await spawnPlainRelayNode(NETWORK_NAME);
		const relayWs = pickRelayWsAddr(relay);

		a = await spawnBrowserShapedCoordinator(relayWs);
		b = await spawnBrowserShapedCoordinator(relayWs);
		const nodeA = a, nodeB = b, relayNode = relay;

		// Each storage node reserves a circuit slot on the relay.
		const aCircuit = await waitForCircuitListen(nodeA, 20_000);
		const bCircuit = await waitForCircuitListen(nodeB, 20_000);

		// Connect the two storage nodes to each other THROUGH the relay (no direct path).
		try { await nodeA.dial(multiaddr(bCircuit.toString())); } catch { /* reciprocal dial below covers it */ }
		try { await nodeB.dial(multiaddr(aCircuit.toString())); } catch { /* already connected */ }

		const bId = nodeB.peerId.toString();
		await waitFor(() => nodeA.getPeers().some(p => p.toString() === bId), { timeoutMs: 20_000, intervalMs: 250, description: 'A and B connected to each other via the relay' });

		// The one precondition, polled on the predicate that actually matters rather than on a
		// proxy for it: A's cohort for this block contains B. That subsumes connection setup,
		// identify (an unidentified peer is never admitted) and FRET convergence — and if it never
		// becomes true the wait throws naming the condition. No skip below this line.
		const cohortOfA = async (): Promise<string[]> =>
			Object.keys(await nodeA.keyNetwork.findCluster(routingKeyForBlock(BLOCK_ID)));
		// The poll RETURNS the cohort it accepted, so the assertion below judges that same
		// observation rather than a second `findCluster` taken an instant later.
		const aCohort = await waitForValue(async () => {
			const cohort = await cohortOfA();
			return cohort.includes(bId) ? cohort : undefined;
		}, {
			timeoutMs: COHORT_TIMEOUT_MS,
			intervalMs: 500,
			description: `A's cohort for '${BLOCK_ID}' includes the relay-only coordinator B`
		});

		// Exactly {A, B} — set equality, not `includes`. `allowDownsize: true` means a self-only
		// cohort completes a write happily, so a weaker assertion here would let the spec pass
		// while asserting nothing about a second promise crossing anything.
		expect([...aCohort].sort(), `A's cohort for '${BLOCK_ID}' is exactly {A, B}`)
			.to.deep.equal([nodeA.peerId.toString(), bId].sort());

		// The relay is excluded for the REASON this spec intends: identify negotiated (so its
		// protocol list reached A at all) and that list carries neither Optimystic protocol, i.e.
		// `membershipOf` reads `foreign`. A relay whose identify silently failed would also be
		// excluded — as `unknown` — and the cohort assertion above could not tell the two apart.
		const relayView = await waitForPeerStoreProtocols(
			nodeA, relayNode.peerId, 20_000,
			protocols => protocols.includes(IDENTIFY_PROTOCOL)
		);
		expect(relayView.matched,
			`A never saw the relay's identify protocol ${IDENTIFY_PROTOCOL}; its peerStore holds: ${JSON.stringify(relayView.protocols)}`)
			.to.equal(true);
		expect(relayView.protocols, 'the relay must not serve this network\'s cluster protocol').to.not.include(CLUSTER_PROTOCOL);
		expect(relayView.protocols, 'the relay must not serve this network\'s repo protocol').to.not.include(REPO_PROTOCOL);

		// The A↔B path must not have silently gone direct — the whole point is a promise over a
		// limited connection. Loopback plus WS+circuit-only transports should prevent a DCUtR
		// upgrade; assert it rather than assume it, using PRODUCTION's `isLimitedConnection` so
		// "relayed" here can never drift from what the write path itself treats as limited.
		const aToB = nodeA.getConnections(nodeB.peerId);
		expect(aToB.length, 'A holds at least one connection to B').to.be.greaterThan(0);
		expect(aToB.every(isLimitedConnection),
			`every A→B connection must be relayed; have: ${aToB.map(c => c.remoteAddr.toString()).join(', ')}`)
			.to.equal(true);

		// THE REPRODUCER SURFACE: the coordinator must collect B's promise over the relayed
		// (limited) connection. With the fix (connect() prefer-direct + collectPromises
		// immediate-retry) the relayed promise is collected and the write reaches super-majority.
		const aRepo = nodeA.coordinatedRepo;
		const pendResult = await aRepo.pend({
			actionId: 'mcw-relay-a1',
			transforms: makeTransforms(BLOCK_ID),
			policy: 'c'
		});
		expect(pendResult.success, "A.pend reaches super-majority with B's promise crossing the relay").to.equal(true);

		const commitResult = await aRepo.commit({
			actionId: 'mcw-relay-a1',
			tailId: BLOCK_ID as BlockId,
			rev: 1,
			blockIds: [BLOCK_ID as BlockId]
		} as any);
		expect(commitResult.success, 'A.commit reaches consensus across the relay').to.equal(true);
	});
});
