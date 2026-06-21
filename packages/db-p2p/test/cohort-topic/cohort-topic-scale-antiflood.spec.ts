/**
 * Cohort-topic **mock-tier e2e — anti-flood + anti-DoS at scale** (`docs/cohort-topic.md` §Anti-flood
 * properties, §Anti-DoS, §Cold-start instantiation).
 *
 * Each of the five §Anti-flood claims and the anti-DoS defenses maps to a named test here. Where a claim
 * is an **emergent property of the real walk/promotion engine** (claims 1, 3, 4), the test drives real
 * `service.register` walks over the {@link import("../../src/testing/cohort-topic-mesh-harness.js")} mock
 * transport and asserts the structural discipline with the same db-core predicates the simulator's
 * `walk-metrics.ts` uses (`outwardMovesArePromoted`, `inwardStepsFollowNoState`, `retriesRestartAtDMax`) —
 * reconstructing each walk's `WalkTrace` from the mesh's recorded route log. Where a claim is a
 * **scheduler mechanism** (claim 2 jitter) or a **guard** (rate limit, topic budget), the test exercises
 * the production module the host wires, sourcing every numeric bound from the config defaults (`DEFAULT_*`).
 *
 * **Quantitative scale numbers** (hop p95, accept/sec, convergence latency, the depth law) are the
 * simulator's (`packages/substrate-simulator`); this tier asserts the *behavioral disciplines* hold on
 * the real implementation. Claim 5 (sticky promotion) is the named `cohort-topic-scale-lifecycle.spec.ts`
 * "sticky promotion" test; the cross-reference keeps it from being duplicated here.
 */

import { expect } from 'chai';
import {
	createRejoinJitter,
	DEFAULT_TTL_MS,
	DEFAULT_T_REJOIN_JITTER_MS,
	DEFAULT_REGISTER_RATE_PER_PEER,
	outwardMovesArePromoted,
	inwardStepsFollowNoState,
	retriesRestartAtDMax,
	CohortBackoffError,
	bytesToB64url,
	type Tier,
	type WalkTrace,
} from '@optimystic/db-core';
import {
	buildMesh,
	coordTierMap,
	delay,
	makeMember,
	makeMembers,
	setupTopic,
	signedRegister,
	waitFor,
	walkTraceFrom,
	type CohortMesh,
	type HostNode,
} from '../../src/testing/cohort-topic-mesh-harness.js';

const N = 64;
const WANT_K = 16;
const MIN_SIGS = 14;
const T0 = Date.now(); // see cohort-topic-scale-lifecycle.spec.ts for why the base tracks wall time

function topic(seed: number): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_v, i) => (i * 5 + seed * 37 + 11) & 0xff);
}

const REG = { followOn: false as const, treeTier: 0 };

/** Run one participant's real `service.register` walk in isolation and return its reconstructed trace. */
async function walkOnce(mesh: CohortMesh, walker: HostNode, topicId: Uint8Array, dMax: number): Promise<{ trace: WalkTrace; attached: boolean; backoff: boolean }> {
	mesh.clearRouteLog();
	let attached = false;
	let backoff = false;
	try {
		await walker.host.service.register({ topicId, tier: 0 as Tier });
		attached = true;
	} catch (err) {
		if (err instanceof CohortBackoffError) {
			backoff = true;
		} else {
			throw err;
		}
	}
	const tierMap = coordTierMap(walker.member, topicId, dMax);
	const trace = walkTraceFrom(mesh.routeTrace, tierMap, dMax);
	return { trace, attached, backoff };
}

describe('cohort-topic: scale anti-flood + anti-DoS (mock-tier e2e)', function () {
	this.timeout(60_000);

	describe('§Anti-flood claim 1 — cold-start storm avoidance', () => {
		it('a burst of registrations each probes d_max FIRST and walks single-direction toward the root (no speculative deeper probing); all attach with no root give-up', async () => {
			const TOPIC = topic(1);
			// size_estimate = 70000 → d_max = ⌊log₁₆(70000)⌋ − 1 = 4 − 1 = 3, so each walk starts deep and steps
			// inward. cap_promote kept high so every walk attaches at the root (the sparse regime) — the root is
			// under-loaded by definition, so absorbing the storm is exactly the design's claim.
			const dMax = 3;
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, sizeEstimate: 70_000, capPromote: 10_000 });
			try {
				await setupTopic(mesh, TOPIC);
				const walkers = mesh.nodes.slice(0, 36);

				const startTiers = new Set<number>();
				for (const walker of walkers) {
					const { trace, attached } = await walkOnce(mesh, walker, TOPIC, dMax);
					expect(attached, `walker ${walker.member.idStr} attached (no give-up / no root-unreachable)`).to.equal(true);
					expect(trace.probes.length, 'the walk issued probes').to.be.greaterThan(0);
					const tiers = trace.probes.map((p) => p.treeTier);
					expect(trace.probes[0]!.treeTier, 'the walk starts at d_max FIRST, not at the root').to.equal(Math.max(...tiers));
					expect(inwardStepsFollowNoState(trace), 'every inward step follows a no_state (single-direction discipline)').to.equal(true);
					expect(outwardMovesArePromoted(trace), 'no speculative outward probe in the cold-start walk').to.equal(true);
					startTiers.add(trace.probes[0]!.treeTier);
				}

				expect(startTiers.size, 'all walks start at the same deep tier').to.equal(1);
				expect([...startTiers][0], 'that tier is d_max ≥ 2 (deep start — the root is probed last, not first)').to.equal(dMax);
			} finally {
				await mesh.stop();
			}
		});

		it.skip('cold-start walks fan across distinct coord_{d_max} ≈ participant count [DOC EXPECTATION NOT YET IMPLEMENTED — participantCoord is the dialable peer-id (constant base58 "12D3KooW…" prefix), so coord_d (d≥1) collapses to one coord rather than fanning: cohort-topic-participant-coord-routing-key-mismatch]', () => {
			// The §Anti-flood claim-1 *fan* (distinct coord_{d_max} per participant, ≈ subscriber count) requires
			// `prefix(P, d·log₂F)` to be uniformly distributed. The current wire carries `participantCoord` as the
			// dialable peer-id string bytes (`peerIdToBytes`), and every Ed25519 libp2p peer-id base58-encodes to a
			// constant `"12D3KooW…"` prefix — so the first d·4 bits are identical across all participants and
			// `coord_d` for d≥1 produces ONE shared coordinate, not a fan. The single-direction walk discipline
			// (above) still holds; only the fan is blocked, pending the routing-key/signer-id reconciliation the
			// doc flags as a multi-tier follow-on (§Wire formats "Tier-0 caveat"). The fan is validated against the
			// uniform ring coord in the simulator (`scenarios.ts` cold-start-storm: distinct-start == subscriber count).
		});
	});

	describe('§Anti-flood claim 3 — no speculative outward probe', () => {
		it('the only outward move a real walk makes follows a Promoted redirect (post-promotion walk)', async () => {
			const TOPIC = topic(2);
			const capPromote = 6;
			const dMax = 1; // size_estimate default 256 → d_max = 1, so the walk has room to move 0 → 1 outward
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, capPromote });
			try {
				const { decidingEngine } = await setupTopic(mesh, TOPIC);
				await decidingEngine.onStabilized(T0);
				for (let i = 0; i < capPromote; i++) {
					await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC, T0, `promo-${i}`), REG, T0);
				}
				expect(await waitFor(() => decidingEngine.isPromoted(TOPIC), 8_000), 'the root cohort promoted').to.equal(true);

				// A fresh walk now: coord_1 → no_state → coord_0 → Promoted(1) → coord_1 (the one outward move) →
				// no_state → coord_0 → Promoted(1) → … until maxSteps → temporal back-off.
				const walker = mesh.nodes[N - 1]!;
				const { trace, backoff } = await walkOnce(mesh, walker, TOPIC, dMax);
				expect(backoff, 'the post-promotion walk terminates in a temporal back-off (single-cohort tree)').to.equal(true);

				const hasOutwardMove = trace.probes.some((p, i) => i > 0 && p.treeTier > trace.probes[i - 1]!.treeTier);
				expect(hasOutwardMove, 'the walk actually moved outward (so the invariant is not vacuous)').to.equal(true);
				expect(outwardMovesArePromoted(trace), 'each outward move is preceded by a Promoted reply').to.equal(true);
				expect(inwardStepsFollowNoState(trace), 'each inward step is preceded by a no_state').to.equal(true);
			} finally {
				await mesh.stop();
			}
		});
	});

	describe('§Anti-flood claim 4 — inward retry restarts at d_max', () => {
		it('after UnwillingCohort, a fresh register restarts at d_max (never re-hitting the declined coord)', async () => {
			const TOPIC = topic(3);
			const dMax = 1;
			const members = await makeMembers(N);
			// A reputation view that bans every participant → the cold-root bootstrap is denied with
			// UnwillingCohort, so the walk terminates in a temporal back-off and the caller must restart.
			const mesh = await buildMesh(members, {
				wantK: WANT_K,
				minSigs: MIN_SIGS,
				antiDos: { reputation: { isBanned: (): boolean => true, getScore: (): number => 0 } },
			});
			try {
				await setupTopic(mesh, TOPIC);
				const walker = mesh.nodes[0]!;

				const first = await walkOnce(mesh, walker, TOPIC, dMax);
				expect(first.backoff, 'the bootstrap-denied walk backs off in time').to.equal(true);
				const second = await walkOnce(mesh, walker, TOPIC, dMax);
				expect(second.backoff, 'the retry is likewise declined (still banned)').to.equal(true);

				// Both consecutive walks begin at d_max — the decorrelating restart, not a re-hit of the declined coord.
				expect(retriesRestartAtDMax([first.trace, second.trace]), 'each fresh walk restarts at d_max').to.equal(true);
				expect(first.trace.probes[0]!.treeTier, 'walk 1 starts at d_max').to.equal(dMax);
				expect(second.trace.probes[0]!.treeTier, 'walk 2 (the retry) also starts at d_max').to.equal(dMax);
			} finally {
				await mesh.stop();
			}
		});
	});

	describe('§Anti-flood claim 2 — re-registration jitter', () => {
		it('a synchronized re-registration wave is staggered so any T_rejoin_jitter window holds ≤ cap_promote arrivals (the simulator-validated rate bound)', () => {
			// claim 2 is the RejoinJitter scheduler the participant drives on cohort loss (the substrate
			// mechanism); the e2e tier asserts its hard rate bound holds with the config defaults.
			const capPromote = 32;
			const jitter = createRejoinJitter({ tRejoinJitterMs: DEFAULT_T_REJOIN_JITTER_MS, capPromote });
			expect(jitter.windowMs, 'uses the documented T_rejoin_jitter').to.equal(DEFAULT_T_REJOIN_JITTER_MS);

			// A wave twice the cap necessarily spans more than one window; the bound must still hold everywhere.
			const count = capPromote * 2;
			const schedule = jitter.scheduleWave(count, T0);
			expect(schedule.length).to.equal(count);

			// Slide a window of windowMs over the (ascending) schedule: every window holds ≤ capPromote arrivals.
			let worst = 0;
			let lo = 0;
			for (let hi = 0; hi < schedule.length; hi++) {
				while (schedule[hi]! - schedule[lo]! >= jitter.windowMs) {
					lo++;
				}
				worst = Math.max(worst, hi - lo + 1);
			}
			expect(worst, 'no T_rejoin_jitter window exceeds cap_promote arrivals (rate ≤ cap_promote / T_rejoin_jitter)').to.be.at.most(capPromote);
		});
	});

	describe('§Anti-DoS — per-peer rate limit', () => {
		it('a single peer exceeding register_rate_per_peer at one cohort is rejected; a well-behaved peer is unaffected', async () => {
			const TOPIC = topic(4);
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
			try {
				const { decidingEngine } = await setupTopic(mesh, TOPIC);
				const flooder = await makeMember();

				// register_rate_per_peer (= 4) admits within the window; the next is declined in time.
				for (let i = 0; i < DEFAULT_REGISTER_RATE_PER_PEER; i++) {
					const r = await decidingEngine.engine.handleRegister(await signedRegister(flooder, TOPIC, T0, `flood-${i}`), REG, T0);
					expect(r.result, `register ${i} within the rate admits`).to.equal('accepted');
				}
				const over = await decidingEngine.engine.handleRegister(await signedRegister(flooder, TOPIC, T0, 'flood-over'), REG, T0);
				expect(over.result, 'the over-rate register is declined in time').to.equal('unwilling_cohort');
				expect(over.retryAfterMs ?? 0, 'declined with an exponential back-off').to.be.greaterThan(0);

				// A well-behaved second peer at the same cohort/topic/window has its own budget — unaffected.
				const honest = await makeMember();
				const honestReply = await decidingEngine.engine.handleRegister(await signedRegister(honest, TOPIC, T0, 'honest'), REG, T0);
				expect(honestReply.result, 'a well-behaved peer is not throttled by the flooder').to.equal('accepted');
			} finally {
				await mesh.stop();
			}
		});
	});

	describe('§Anti-DoS — per-cohort topic budget', () => {
		it('a real cohort refuses a new topic once the per-cohort budget is full of populated topics', async () => {
			const TOPIC_A = topic(5);
			const TOPIC_B = topic(6);
			const TOPIC_C = topic(7);
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, antiDos: { topicBudget: { topicsMax: 2 } } });
			try {
				// Drive three topics through ONE coord engine's budget (the budget is per served coord).
				const { decidingEngine } = await setupTopic(mesh, TOPIC_A);
				const now = T0;
				expect((await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC_A, now, 'a'), REG, now)).result, 'topic A instantiates').to.equal('accepted');
				expect((await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC_B, now, 'b'), REG, now)).result, 'topic B instantiates (budget now full)').to.equal('accepted');
				const refused = await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC_C, now, 'c'), REG, now);
				expect(refused.result, 'a third topic over the full populated budget is refused').to.equal('unwilling_cohort');
				expect(decidingEngine.servesTopic(TOPIC_A), 'populated topic A keeps serving').to.equal(true);
				expect(decidingEngine.servesTopic(TOPIC_B), 'populated topic B keeps serving').to.equal(true);
				expect(decidingEngine.servesTopic(TOPIC_C), 'the refused topic was not instantiated').to.equal(false);
			} finally {
				await mesh.stop();
			}
		});

		it('a topic drained by the engine TTL sweep releases its budget slot, so a new topic reuses it while a still-populated topic is never evicted', async () => {
			// Drives the LRU cold-eviction discipline THROUGH the real engine wire (not the `createTopicBudget`
			// unit): the engine touches the budget UP on admission and now back DOWN on TTL drain, so a topic
			// whose participants all leave falls to participantCount 0 and becomes the coldest-evictable resident
			// again. Before the fix the budget slot leaked — a drained topic kept its stale positive count forever
			// and the cohort refused every new topic while serving nothing.
			const TOPIC_A = topic(8); // stays populated throughout (renewed lastPing) — must never be evicted
			const TOPIC_B = topic(9); // drains via the TTL sweep — its slot must be released
			const TOPIC_C = topic(10); // the new topic that should reuse B's freed slot
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, antiDos: { topicBudget: { topicsMax: 2 } } });
			try {
				const { decidingEngine } = await setupTopic(mesh, TOPIC_A);
				const third = Math.floor(DEFAULT_TTL_MS / 3);

				// Fill the topicsMax=2 budget with two populated topics. B is registered at T0; A is registered
				// `ttl/3` later so a single sweep can drain B (older lastPing) while A survives (newer lastPing).
				expect((await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC_B, T0, 'b', { ttl: DEFAULT_TTL_MS }), REG, T0)).result, 'topic B instantiates').to.equal('accepted');
				expect(decidingEngine.budgetParticipantCount(TOPIC_B), 'B is populated in the budget').to.equal(1);
				expect((await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC_A, T0 + third, 'a', { ttl: DEFAULT_TTL_MS }), REG, T0 + third)).result, 'topic A instantiates (budget now full)').to.equal('accepted');
				expect(decidingEngine.budgetParticipantCount(TOPIC_A), 'A is populated in the budget').to.equal(1);

				// Control: while both topics are populated the budget is genuinely saturated — a new topic is refused.
				const refusedWhileFull = await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC_C, T0 + third, 'c-early'), REG, T0 + third);
				expect(refusedWhileFull.result, 'C is refused while both A and B are populated (no cold slot to free)').to.equal('unwilling_cohort');
				expect(decidingEngine.budgetHasTopic(TOPIC_C), 'the refused topic took no budget slot').to.equal(false);

				// Drain B via the engine TTL sweep: one ttl past B's only ping but within A's, so B is evicted and
				// A survives. The new `sweepStale` re-touch must drop B to participantCount 0 in the budget.
				const drainAt = T0 + DEFAULT_TTL_MS + 1;
				const evicted = decidingEngine.engine.sweepStale(drainAt);
				expect(evicted.some((r) => bytesToB64url(r.topicId) === bytesToB64url(TOPIC_B)), 'B is swept').to.equal(true);
				expect(decidingEngine.budgetParticipantCount(TOPIC_B), 'drained B fell to participantCount 0 (cold resident) — the slot is now reclaimable').to.equal(0);
				expect(decidingEngine.budgetParticipantCount(TOPIC_A), 'still-populated A keeps its positive budget count').to.equal(1);

				// Now a new topic instantiation succeeds by reusing the cold (drained) B's slot — the leak is closed.
				const reused = await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC_C, drainAt, 'c'), REG, drainAt);
				expect(reused.result, 'C now instantiates by evicting the drained-cold B from the budget').to.equal('accepted');
				expect(decidingEngine.budgetHasTopic(TOPIC_B), 'the drained topic was dropped first — its slot was released').to.equal(false);
				expect(decidingEngine.budgetHasTopic(TOPIC_C), 'the new topic was admitted into the freed slot').to.equal(true);
				expect(decidingEngine.budgetParticipantCount(TOPIC_A), 'the still-populated topic is never evicted for a new instantiation').to.equal(1);
				expect(decidingEngine.servesTopic(TOPIC_A), 'the populated topic keeps serving').to.equal(true);
			} finally {
				await mesh.stop();
			}
		});
	});

	describe('§Cold-start instantiation — bootstrap flow', () => {
		it('a RegisterV1{bootstrap:true} instantiates a root forwarder under a willing quorum', async () => {
			const TOPIC = topic(11);
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
			try {
				const { decidingEngine } = await setupTopic(mesh, TOPIC);
				expect(decidingEngine.servesTopic(TOPIC), 'cold before any registration').to.equal(false);

				const reply = await decidingEngine.engine.handleRegister(
					await signedRegister(await makeMember(), TOPIC, T0, 'bootstrap', { bootstrap: true }),
					REG,
					T0,
				);
				expect(reply.result, 'the bootstrap register instantiates the root and is accepted').to.equal('accepted');
				expect(decidingEngine.servesTopic(TOPIC), 'the root forwarder is now instantiated').to.equal(true);
				expect(decidingEngine.treeTier, 'instantiated at the tier-0 root').to.equal(0);
			} finally {
				await mesh.stop();
			}
		});

		it.skip('a Promoted redirect instantiates a tier-1 child that registers with its tier-0 parent on first opportunity [DOC EXPECTATION NOT YET IMPLEMENTED at e2e — live followOn instantiation parked: cohort-topic-followon-derivation]', () => {
			// A live walk drawing Promoted(1) recomputes coord_1 and registers there, but the host dispatch
			// passes `followOn: false` and only the root sets `bootstrap`, so the tier-1 cohort answers no_state
			// rather than cold-starting a child. The forwarder→parent link transport itself (gap 7) IS wired and
			// unit-covered by host-antidos-coldstart.spec.ts ('a tier-1 forwarder links to its tier-0 parent…');
			// what is missing for the e2e is the host deriving followOn from a Promoted-redirect arrival.
		});
	});
});
