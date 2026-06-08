import { expect } from 'chai';
import { DigitreeStore, hashKey, assembleCohort } from 'p2p-fret';
import { createRng } from '../src/rng.js';
import { generatePeers } from '../src/peer.js';
import { createSimWorld } from '../src/world.js';
import { FretModel } from '../src/fret-model.js';
import { RingModel } from '../src/ring-model.js';
import { computeDMax, DEFAULT_DMAX_CONFIG } from '../src/size-model.js';
import type { PeerRef } from '../src/types.js';

const SEED = 12345;
const M = 8; // FRET default m = ⌈k/2⌉ for k = 15

/** Independent oracle for the depth law the convergence ticket asserts: ⌈log_F(N / cap_promote)⌉. */
function depthLaw(n: number, F: number, capPromote: number): number {
	return Math.ceil(Math.log(n / capPromote) / Math.log(F));
}

/** Independent oracle for the primary d_max formula: max(0, ⌊log_F(n_est)⌋ − 1). */
function dMaxFormula(nEst: number, F: number): number {
	return Math.max(0, Math.floor(Math.log(nEst) / Math.log(F)) - 1);
}

/** Build a reference DigitreeStore the same way the model does — for parity checks. */
async function referenceStore(peers: readonly PeerRef[]): Promise<DigitreeStore> {
	const ring = new RingModel();
	const store = new DigitreeStore();
	for (const peer of peers) {
		store.upsert(peer.id, await ring.coordOf(peer.key));
	}
	return store;
}

describe('FretModel — size & depth (real FRET math)', () => {
	it('n_est and d_max track an injected population across N ∈ {10,100,1k,10k,100k}', async function () {
		this.timeout(30000); // 100k seeding awaits ~100k sha256 hashes (~4s)
		const cfg = DEFAULT_DMAX_CONFIG;
		for (const N of [10, 100, 1000, 10000, 100000]) {
			const peers = generatePeers(N, createRng(SEED));
			const model = await FretModel.create(peers, { m: M });
			const { n, confidence } = model.size.estimate();

			// n_est is an order-of-magnitude tracker, not a tight CI: FRET's median-gap estimator
			// systematically overshoots a uniform population by ~1/ln2 ≈ 1.44×. Assert same order.
			expect(n, `n_est for N=${N}`).to.be.within(N / 4, N * 4);
			expect(confidence, `confidence for N=${N}`).to.be.within(0, 1);

			// d_max == the documented formula, computed independently from the same n_est.
			const dMax = model.size.dMax(cfg);
			expect(dMax, `d_max for N=${N}`).to.equal(dMaxFormula(n, cfg.F));

			// ...and stays within ±1 of the steady-state depth law over the whole sweep.
			expect(Math.abs(dMax - depthLaw(N, cfg.F, cfg.capPromote)), `d_max vs depth law for N=${N}`)
				.to.be.at.most(1);
		}
	});
});

describe('FretModel — confidence clamp on d_max', () => {
	it('clamps d_max to ⌊d_max_cap/2⌋ when confidence < confidence_min (pure)', () => {
		const cfg = DEFAULT_DMAX_CONFIG;
		const clamped = Math.floor(cfg.dMaxCap / 2);
		// Below the floor: clamp engages regardless of n_est.
		expect(computeDMax(100000, cfg.confidenceMin - 0.01, cfg)).to.equal(clamped);
		expect(computeDMax(10, 0, cfg)).to.equal(clamped);
		// At/above the floor: the formula governs.
		expect(computeDMax(100000, cfg.confidenceMin, cfg)).to.equal(dMaxFormula(100000, cfg.F));
		expect(computeDMax(100000, 0.5, cfg)).to.equal(dMaxFormula(100000, cfg.F));
	});

	it('clamp engages with real FRET output for a degenerate (single-peer) population', async () => {
		const peers = generatePeers(1, createRng(SEED));
		const model = await FretModel.create(peers, { m: M });
		const { confidence } = model.size.estimate();
		// FRET reports confidence 0.2 for a single-peer store — below confidence_min.
		expect(confidence).to.be.below(DEFAULT_DMAX_CONFIG.confidenceMin);
		expect(model.size.dMax(DEFAULT_DMAX_CONFIG)).to.equal(Math.floor(DEFAULT_DMAX_CONFIG.dMaxCap / 2));
	});
});

describe('FretModel — cohort membership (parity with direct FRET)', () => {
	it('assemble matches a direct assembleCohort call for the same coordinate/population', async () => {
		const peers = generatePeers(500, createRng(SEED));
		const model = await FretModel.create(peers, { m: M });
		const ref = await referenceStore(peers);
		const ring = new RingModel();
		const k = 15;
		for (const probe of [7, 99, 321]) {
			const coord = await ring.coordOf(Uint8Array.of(probe));
			const direct = assembleCohort(ref, coord, k);
			expect(model.cohort.assembleIds(coord, k)).to.deep.equal(direct);
			// The PeerRef view carries the same ids, in the same order — no divergence.
			expect(model.cohort.assemble(coord, k).map((p) => p.id)).to.deep.equal(direct);
		}
	});

	it('auto-adapts when n < k (returns the whole ring)', async () => {
		const peers = generatePeers(5, createRng(SEED));
		const model = await FretModel.create(peers, { m: M });
		const ref = await referenceStore(peers);
		const coord = await new RingModel().coordOf(Uint8Array.of(1));
		const direct = assembleCohort(ref, coord, 15);
		expect(direct.length).to.equal(5);
		expect(model.cohort.assembleIds(coord, 15)).to.deep.equal(direct);
	});

	it('minSigs(k, x) = k − x', async () => {
		const model = await FretModel.create(generatePeers(10, createRng(SEED)), { m: M });
		expect(model.cohort.minSigs(15, 1)).to.equal(14);
		expect(model.cohort.minSigs(16, 2)).to.equal(14);
	});
});

describe('FretModel — scheduled recompute on the virtual clock', () => {
	it('snapshots n_est one gossip round out, not before', async () => {
		const gossipRoundMs = 200;
		const world = createSimWorld({ seed: SEED, gossipRoundMs });
		const model = await FretModel.create(generatePeers(100, createRng(SEED)), { m: M });

		expect(model.lastEstimate).to.equal(undefined);
		model.scheduleRecompute(world.scheduler, gossipRoundMs);

		// Before the gossip round elapses, no snapshot exists and the clock has not advanced.
		expect(world.scheduler.run(gossipRoundMs - 1)).to.equal(0);
		expect(model.lastEstimate).to.equal(undefined);
		expect(world.scheduler.now()).to.equal(0);

		// The recompute fires exactly at the gossip-round boundary.
		expect(world.scheduler.run()).to.equal(1);
		expect(world.scheduler.now()).to.equal(gossipRoundMs);
		expect(model.lastEstimate).to.not.equal(undefined);
		expect(model.lastEstimate).to.deep.equal(model.size.estimate());
	});

	it('reflects churn only after the next scheduled recompute', async () => {
		const gossipRoundMs = 200;
		const world = createSimWorld({ seed: SEED, gossipRoundMs });
		const peers = generatePeers(100, createRng(SEED));
		const model = await FretModel.create(peers, { m: M });

		model.scheduleRecompute(world.scheduler, gossipRoundMs);
		world.scheduler.run();
		const before = model.lastEstimate!.n;

		// Churn out 60% of the population; the cached estimate is stale until the next recompute.
		for (const p of peers.slice(0, 60)) {
			model.removePeer(p.id);
		}
		expect(model.lastEstimate!.n).to.equal(before);

		model.scheduleRecompute(world.scheduler, gossipRoundMs);
		world.scheduler.run();
		expect(model.lastEstimate!.n).to.be.below(before);
	});
});
