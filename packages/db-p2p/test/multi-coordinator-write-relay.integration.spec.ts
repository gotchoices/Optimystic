import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, IBlock, BlockHeader, Transforms, IRepo } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, type Libp2pTransports } from '../src/libp2p-node.js';
import { spawnRelayNode, pickRelayWsAddr, waitForCircuitListen } from './util/relay-topology.js';

// Relay-topology variant of `multi-coordinator-write-stream-reset-supermajority`.
//
// The clean direct-TCP repro (`multi-coordinator-write.integration.spec.ts`)
// PASSES on main — a 2-of-2 write over a direct connection works. This variant
// forces the inter-coordinator promise stream over a LIMITED (circuit-relay)
// connection, the Sereus-realistic condition: two always-on storage nodes behind
// NAT reach each other only through a reference/relay node, so the coordinator's
// dial-back to collect the second promise runs `newStream(..., {
// runOnLimitedConnection: true })` over the relayed connection. If a relayed
// inter-coordinator stream is the thing that resets, this reproduces case (a)
// where the direct-TCP test does not.
//
// Both storage peers are browser-shaped (WS + circuit transports only, listening
// ONLY on `<relay>/p2p-circuit`): they have no direct transport to each other and
// loopback blocks DCUtR upgrade, so every node↔node stream stays on the relay.
//
// Gated on OPTIMYSTIC_INTEGRATION=1. Slow (three real libp2p nodes + relay
// reservations + FRET over relay). Run via:
//   OPTIMYSTIC_INTEGRATION=1 npm run test:integration --workspace @optimystic/db-p2p

const NETWORK_NAME = 'multi-coord-write-relay-it';

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


// A browser-shaped storage node: WS + circuit only, listening on the relay's
// circuit. clusterSize:2 so for every block BOTH storage nodes are in the cohort.
async function spawnBrowserShapedCoordinator(relayWs: Multiaddr): Promise<Libp2p> {
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
	this.timeout(120_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let relay: Libp2p | undefined;
	let a: Libp2p | undefined;
	let b: Libp2p | undefined;

	afterEach(async () => {
		const toStop = [a, b, relay].filter((n): n is Libp2p => !!n);
		a = undefined; b = undefined; relay = undefined;
		await Promise.allSettled(toStop.map(n => n.stop()));
	});

	it('a 2-of-2 write whose second promise crosses the relay reaches super-majority', async function () {
		relay = await spawnRelayNode(NETWORK_NAME, { applyDefaultLimit: false });
		const relayWs = pickRelayWsAddr(relay);

		a = await spawnBrowserShapedCoordinator(relayWs);
		b = await spawnBrowserShapedCoordinator(relayWs);

		// Each storage node reserves a circuit slot on the relay.
		const aCircuit = await waitForCircuitListen(a, 20_000);
		const bCircuit = await waitForCircuitListen(b, 20_000);

		// Connect the two storage nodes to each other THROUGH the relay (no direct path).
		try { await a.dial(multiaddr(bCircuit.toString())); } catch { /* reciprocal dial below covers it */ }
		try { await b.dial(multiaddr(aCircuit.toString())); } catch { /* already connected */ }

		await waitFor(() => a!.getPeers().some(p => p.toString() === b!.peerId.toString()), { timeoutMs: 20_000, intervalMs: 250, description: 'A and B connected to each other via the relay' });

		// FRET must converge so A and B each hold the OTHER's coordinate in their ring —
		// the real precondition for findCluster to return a cohort that can span both.
		//
		// With the limited-connection RPC fix (fix/p2p-fret-rpc-over-limited-connection)
		// the A↔B FRET wire exchange now runs DIRECTLY over the relayed (limited)
		// connection — `p2p-fret`'s RPCs open their stream with
		// `runOnLimitedConnection: true` — on top of the transitive path through the
		// relay (A↔relay and B↔relay are direct WS links, and `peer:connect` upserts the
		// peer on the relayed A↔B link too). Convergence is therefore reliable.
		//
		// We deliberately do NOT gate on `assembleCohort(probe, 2)` containing both A and
		// B for a single fixed probe: the relay is itself a FRET participant in the
		// keyspace, so for a large fraction of random per-run peer-id layouts it ranks
		// within the top-2 for any fixed probe and crowds a storage node out of the
		// size-2 cohort — even when the ring is fully converged. That false-negative made
		// the old precondition bimodally `this.skip()`. The keyspace search loop below
		// already handles per-probe cohort-membership variance by trying many block ids.
		const fretOf = (n: Libp2p): {
			exportTable(): { entries: Array<{ id: string }> };
		} => (n as any).services.fret;
		await waitFor(() => {
			const want = [a!.peerId.toString(), b!.peerId.toString()];
			for (const n of [a!, b!]) {
				const ringIds = new Set(fretOf(n).exportTable().entries.map(e => e.id));
				for (const id of want) if (!ringIds.has(id)) return false;
			}
			return true;
		}, { timeoutMs: 40_000, intervalMs: 500, description: 'A and B converge FRET state over the relay (both rings hold both peers)' });

		// The relay node is itself in the FRET keyspace, so a block's cohort is drawn
		// from {A, B, relay}. Find a block whose cohort (from A) actually includes B, so
		// collecting B's promise genuinely crosses the relayed (limited) A↔B connection
		// (A↔relay is direct). Peer ids are random per run, so which keyspace places B in
		// the cohort varies — probe a handful of block ids and take the first that does.
		const bId = b!.peerId.toString();
		let blockId: string | undefined;
		let aCohort: string[] = [];
		for (let i = 0; i < 24; i++) {
			const candidate = `mcw-relay-block-${i}`;
			const cohort = Object.keys(await (a as any).keyNetwork.findCluster(new TextEncoder().encode(candidate)));
			if (cohort.length > 1 && cohort.includes(bId)) {
				blockId = candidate;
				aCohort = cohort;
				break;
			}
		}
		// No probed keyspace placed the relay-only coordinator B in A's cohort — the
		// relayed inter-coordinator promise wouldn't be exercised, so there is nothing
		// for this spec to assert. Skip rather than assert a vacuous all-direct write.
		if (!blockId) {
			this.skip();
			return;
		}
		expect(aCohort.length, "A's cohort spans multiple coordinators").to.be.greaterThan(1);
		expect(aCohort, "A's cohort includes the relay-only coordinator B").to.include(bId);

		const aRepo = (a as any).coordinatedRepo as IRepo;

		// THE REPRODUCER SURFACE: the coordinator must collect B's promise over the
		// relayed (limited) connection. With the fix (connect() prefer-direct +
		// collectPromises immediate-retry) the relayed promise is collected and the write
		// reaches super-majority.
		const pendResult = await aRepo.pend({
			actionId: 'mcw-relay-a1',
			transforms: makeTransforms(blockId),
			policy: 'c'
		});
		expect(pendResult.success, "A.pend reaches super-majority with B's promise crossing the relay").to.equal(true);

		const commitResult = await aRepo.commit({
			actionId: 'mcw-relay-a1',
			tailId: blockId as BlockId,
			rev: 1,
			blockIds: [blockId as BlockId]
		} as any);
		expect(commitResult.success, 'A.commit reaches consensus across the relay').to.equal(true);
	});
});
