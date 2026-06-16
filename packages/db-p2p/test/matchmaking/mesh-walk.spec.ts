/**
 * Matchmaking **mock-tier e2e — seeker hang-out walk regimes** (`docs/matchmaking.md`
 * §Hang-out vs. continue / §Worked scenarios).
 *
 * Drives the **real** {@link import("../../src/matchmaking/seeker-walk-client.js").SeekerWalkClient} over
 * the matchmaking mesh: per-tier register probes route through the real cohort engines, and each
 * `QueryV1` is served from the real tier-0 cohort store (real provider records, real `registrationSig`
 * re-validation). The hang-out *decision math* is the db-core `seeker-walk.spec.ts` floor; these suites
 * prove the modeled traffic regime drives the real walk over real records, on a virtual clock.
 *
 * **Single-tier-0 reach (honest).** The underlying substrate serves one tier-0 cohort, so a walk always
 * falls through `d_max…1` as `NoState` and is `Accepted` at the root — the cold/sparse-walk-to-root shape
 * is fully real. "Hot topic, a *deep* tier (`d ≥ 1`) suffices", tree-promotion-under-load depth tracking,
 * and membership-rotation primary handoff need a *serving* promoted tier the substrate does not yet build
 * (cohort-topic follow-ons), so they are tagged-unimplemented below rather than faked.
 */

import { expect } from 'chai';
import { buildMatchmakingMesh, type MatchmakingMesh } from '../../src/testing/matchmaking-mesh-harness.js';

describe('matchmaking / mesh — seeker walk regimes', () => {
	let mm: MatchmakingMesh;
	afterEach(async () => {
		await mm?.stop();
	});

	it('sparse/cold regime: the walk falls through every tier to the root, where wantCount is met (docs §Worked scenarios — capability lookup in a sparse network)', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 12 });
		await mm.registerTopic('capability', 'geocode-resolver');
		for (let i = 0; i < 5; i++) {
			await mm.provide(i, 'capability', 'geocode-resolver', ['geocode-resolver'], 4);
		}
		const r = await mm.seek(10, 'capability', 'geocode-resolver', 3, { dMax: 2, patienceMs: 10_000 });
		expect(r.metWantCount, 'wantCount met at the root').to.equal(true);
		expect(r.terminalTier, 'terminated at the root').to.equal(0);
		expect(r.tiersVisited, 'probed every tier d_max…0').to.equal(3);
		expect(r.hops, 'one register hop per tier (no escalation past the root)').to.equal(3);
		expect(r.hungOutMs, 'immediate match at the root — never hung out').to.equal(0);
		expect(r.providers.length).to.be.at.least(3);
		// Every returned provider re-validates (advisory trust model end-to-end over the real walk).
		expect(r.providers.every((e) => mm.verifyEntryFor(mm.topicId('capability', 'geocode-resolver'), e))).to.equal(true);
	});

	it('sparse provider, very large network: the seeker walks d_max+1 tiers (6 RPCs at d_max=5) to the root (docs §Worked scenarios — sparse provider very large network)', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 12, sizeEstimate: 10_000_000 });
		await mm.registerTopic('capability', 'zk-snark-prover-v2');
		for (let i = 0; i < 5; i++) {
			await mm.provide(i, 'capability', 'zk-snark-prover-v2', ['zk-snark-prover-v2'], 4);
		}
		const r = await mm.seek(10, 'capability', 'zk-snark-prover-v2', 5, { dMax: 5, patienceMs: 10_000 });
		expect(r.metWantCount, 'all 5 providers found at the root').to.equal(true);
		expect(r.terminalTier).to.equal(0);
		expect(r.hops, 'exactly d_max+1 = 6 register hops (d = 5,4,3,2,1,0)').to.equal(6);
		expect(mm.walkTrace(r).tiersVisited).to.equal(6);
	});

	it('hot regime (root): the immediate query meets wantCount — the seeker stops at the accepting tier, no further walk', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 14 });
		await mm.registerTopic('capability', 'pdf-render');
		for (let i = 0; i < 8; i++) {
			await mm.provide(i, 'capability', 'pdf-render', ['pdf-render'], 4);
		}
		// A genuinely hot reply: the hotness signal (childCohortCount) must surface even when the immediate
		// query already satisfies wantCount, so the public session / voting binding can choose to sweep.
		mm.setTraffic(mm.topicId('capability', 'pdf-render'), { arrivalsPerMin: 90, queriesPerMin: 4, directParticipants: 8, childCohortCount: 4 });
		const r = await mm.seek(10, 'capability', 'pdf-render', 8, { dMax: 1, patienceMs: 10_000 });
		expect(r.metWantCount).to.equal(true);
		expect(r.terminalTier, 'matched at the first Accepted (root) — no walk past it').to.equal(0);
		expect(r.hungOutMs, 'immediate match — no hang-out').to.equal(0);
		expect(r.maxChildCohortCount, 'hot-topic signal surfaced for the sweep decision').to.equal(4);
	});

	it('borderline regime: under-met at the landed tier, the seeker hangs out for the full patience, polling at requery_interval_ms, then returns the partial set', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 8 });
		await mm.registerTopic('task', 'cluster-validate');
		for (let i = 0; i < 3; i++) {
			await mm.provide(i, 'task', 'cluster-validate', ['validate'], 4);
		}
		// Modeled feasible-but-unfulfilled regime: the decision says "hang out" (expected arrivals clear the
		// threshold), but no further providers actually land, so the seeker drains its patience and returns 3.
		mm.setTraffic(mm.topicId('task', 'cluster-validate'), { arrivalsPerMin: 90, queriesPerMin: 4, directParticipants: 3, childCohortCount: 0 });
		const r = await mm.seek(6, 'task', 'cluster-validate', 8, { dMax: 0, patienceMs: 5_000, requeryIntervalMs: 1_000 });
		expect(r.metWantCount).to.equal(false);
		expect(r.providers.length, 'returns the partial set it found').to.equal(3);
		expect(r.terminalTier).to.equal(0);
		expect(mm.walkTrace(r).hungOutMs, 'drained ≈ patienceMs across requery_interval_ms polls').to.equal(5_000);
	});

	it('adversarial over-report is bounded by patienceMs and never floods spatially (docs §Failure modes — adversarial cohort traffic reporting)', async () => {
		mm = await buildMatchmakingMesh({ nodeCount: 10 });
		await mm.registerTopic('capability', 'pdf-render');
		for (let i = 0; i < 2; i++) {
			await mm.provide(i, 'capability', 'pdf-render', ['pdf-render'], 4);
		}
		// A lying primary over-reports a hot tier (high arrivals) to lure the seeker into hanging out, but
		// the real population is thin. Worst case: wasted patience + the walk only ever stepped toward the
		// root (d_max+1 probes, no speculative outward probing) — the substrate anti-flood guarantee holds.
		mm.setTraffic(mm.topicId('capability', 'pdf-render'), { arrivalsPerMin: 600, queriesPerMin: 1, directParticipants: 2, childCohortCount: 0 });
		const r = await mm.seek(9, 'capability', 'pdf-render', 8, { dMax: 2, patienceMs: 4_000, requeryIntervalMs: 1_000 });
		expect(r.metWantCount).to.equal(false);
		expect(r.hungOutMs, 'wasted at most patienceMs of hang-out drain').to.be.at.most(4_000);
		expect(r.tiersVisited, 'no spatial flood — only walked toward the root (d_max+1 probes)').to.equal(3);
		expect(r.terminalTier).to.equal(0);
	});

	// --- doc expectations the single-tier-0 substrate milestone cannot yet realize ---

	it.skip('[DOC EXPECTATION NOT YET IMPLEMENTED — cohort-topic-followon-derivation] hot topic, a DEEP tier (d ≥ 1) suffices: an Accepted above the root meets wantCount and the walk stops there', async () => {
		// Needs a *serving* promoted tier-`d ≥ 1` cohort (one that replies Accepted with its prefix-shard
		// providers). The substrate serves a single tier-0 cohort; promotion to a serving child tier is the
		// cohort-topic follow-on. Realized at the root (d = 0) by the hot-regime test above; the deep-tier
		// variant lands when the substrate builds child cohorts.
	});

	it.skip('[DOC EXPECTATION NOT YET IMPLEMENTED — cohort-topic-parent-child-link] tree promotion under load: registrations grow the tree and walk depth tracks population', async () => {
		// Needs real multi-tier tree growth (parent ↔ child cohort linkage + child-cohort accounting). The
		// matchmaking mesh pins cap_promote high to hold a stable tier-0 cohort; depth-vs-population is the
		// cohort-topic e2e's scale-lifecycle concern, gated on the parent-child-link follow-on.
	});

	it.skip('[DOC EXPECTATION NOT YET IMPLEMENTED — cohort-topic rotation handoff] primary handoff on membership rotation: provider/seeker records hand off with no loss, seeker repoints', async () => {
		// Needs cohort membership rotation + primary handoff, which the cohort-topic e2e itself tags
		// unimplemented (no epoch-rotation path yet). When it lands, a matchmaking provider/seeker record
		// survives the handoff and a hanging-out seeker rebinds to the new primary.
	});
});
