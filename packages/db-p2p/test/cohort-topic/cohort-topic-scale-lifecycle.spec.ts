/**
 * Cohort-topic **mock-tier e2e — core lifecycle at scale** (`docs/cohort-topic.md`).
 *
 * The companion of the N = 5 `live-tier.spec.ts` milestone, run over a production-shaped cohort
 * (`wantK = 16`, `minSigs = 14`) embedded in a many-logical-node ring (N = 48) on the shared
 * {@link import("../../src/testing/cohort-topic-mesh-harness.js")} mock transport. Where live-tier proves
 * the machinery *composes*, this asserts the **behavioral correctness the design specifies** — the real
 * `CohortMemberEngine` over the real FRET-routed cohort produces the registration, renewal/TTL, tier
 * willingness, promotion, crash-failover, and gossip-replication behavior of `docs/cohort-topic.md`.
 *
 * Quantitative scale claims (the O(log N) depth law, convergence latency, jitter rate bounds) are owned
 * by the simulator (`packages/substrate-simulator`); this suite asserts *structural* behavior and, where
 * a number is needed, sources it from the production config defaults (`DEFAULT_*`) — never a hard-coded
 * literal that could drift from the doc.
 *
 * **Honestly out of scope at this tier** (tagged `it.skip` with the parking ticket, not silently
 * omitted): live multi-tier tree growth and the `⌈log_F(N/cap_promote)⌉` depth law (the live
 * `Promoted`-redirect follow-on instantiation is parked — `cohort-topic-followon-derivation`); tier-(d>0)
 * demotion-notice broadcast (parent child-link recording parked — `cohort-topic-parent-child-link`); and
 * membership-rotation primary handoff (the `registration/handoff.ts` dual-serve state machine is not yet
 * wired into the FRET host).
 */

import { expect } from 'chai';
import {
	DEFAULT_TTL_MS,
	DEFAULT_T_PROMOTE_STICKY_MS,
	DEFAULT_T_DEMOTE_MS,
	DEFAULT_CAP_DEMOTE,
	stickyHolds,
	bytesToB64url,
	type Tier,
} from '@optimystic/db-core';
import { bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import {
	buildMesh,
	delay,
	makeMember,
	makeMembers,
	participantPrimaryAt,
	setupTopic,
	signedPing,
	signedRegister,
	signedReattach,
	slots,
	waitFor,
} from '../../src/testing/cohort-topic-mesh-harness.js';

const N = 48;
const WANT_K = 16;
const MIN_SIGS = 14; // production k − x
// Virtual-clock origin. All engine-side TTL math (sweep / demotion / promotion) is driven by an *explicit*
// `now` relative to this — no wall-clock sleeps. It is based on `Date.now()` (not a synthetic small value)
// for one reason: the inbound gossip bus's TTL-death guard (`gossip/bus.ts` `mergeRecords`) compares the
// *real* clock to a replicated record's `lastPing` (the host injects no virtual clock into the bus), so a
// record stamped far in the past would be dropped as dead on replication. Relative assertions stay
// deterministic; only the absolute base tracks wall time (the same pattern as `live-tier.spec.ts`).
const T0 = Date.now();

/** A distinct 32-byte topic id per suite section, so cohorts/coords never alias across tests. */
function topic(seed: number): Uint8Array {
	return Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + seed * 31 + 3) & 0xff);
}

const REG = { followOn: false as const, treeTier: 0 };

describe('cohort-topic: scale lifecycle (mock-tier e2e, N=48 ring / k=16 cohort)', function () {
	// Real-Ed25519 single-process suite: raised to 120s to match the uniform mesh e2e class ceiling as
	// insurance — these tests use virtual time but still do real Ed25519 in the same heap as the mesh specs.
	this.timeout(120_000);

	describe('§Registration mechanics + §TTL and renewal', () => {
		it('register → accepted; ttl/3 pings keep the record alive; stopping pings evicts it after ttl', async () => {
			const TOPIC = topic(1);
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
			try {
				const { decidingEngine, deciding } = await setupTopic(mesh, TOPIC);
				// A participant whose deterministic primary is the routed/deciding node, so its pings touch here.
				const p = await participantPrimaryAt(deciding, decidingEngine);

				const reg = await signedRegister(p, TOPIC, T0, 'reg', { ttl: DEFAULT_TTL_MS });
				expect((await decidingEngine.engine.handleRegister(reg, REG, T0)).result, 'fresh register admits').to.equal('accepted');
				expect(decidingEngine.holds(TOPIC, p.bytes), 'the record is resident').to.equal(true);

				const third = Math.floor(DEFAULT_TTL_MS / 3);
				// Ping at ttl/3 and 2·ttl/3 — each lands on the computed primary and touches `lastPing`.
				expect(decidingEngine.engine.handleRenew(await signedPing(p, TOPIC, T0 + third, 'ping1'), T0 + third).result, 'first ttl/3 ping served').to.equal('ok');
				expect(decidingEngine.engine.handleRenew(await signedPing(p, TOPIC, T0 + 2 * third, 'ping2'), T0 + 2 * third).result, 'second ttl/3 ping served').to.equal('ok');

				// A sweep at the original attach + ttl would have evicted a never-pinged record, but `lastPing`
				// moved to 2·ttl/3, so the record SURVIVES (now − lastPing = ttl/3 < ttl).
				decidingEngine.engine.sweepStale(T0 + DEFAULT_TTL_MS);
				expect(decidingEngine.holds(TOPIC, p.bytes), 'a renewed record survives the original-attach + ttl sweep').to.equal(true);

				// Stop pinging. One ttl past the last touch, the record is evicted (now − lastPing > ttl).
				const evictAt = T0 + 2 * third + DEFAULT_TTL_MS + 1;
				const evicted = decidingEngine.engine.sweepStale(evictAt);
				expect(evicted.some((r) => bytesToB64url(r.participantId) === bytesToB64url(p.bytes)), 'the un-renewed record is swept').to.equal(true);
				expect(decidingEngine.holds(TOPIC, p.bytes), 'evicted after ttl with no renewal').to.equal(false);
			} finally {
				await mesh.stop();
			}
		});
	});

	describe('§Willingness — per-tier admission gating', () => {
		it('an edge cohort member refuses to instantiate a T3 (luxury) topic (no_state); a core member admits the same topic', async () => {
			const TOPIC = topic(2);
			const members = await makeMembers(N);
			// Node 0 is an Edge profile (T0/T1 only); the rest are Core (T0–T3).
			const profiles = members.map((_m, i) => (i === 0 ? 'edge' : 'core') as 'edge' | 'core');
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, profiles });
			try {
				const setup = await setupTopic(mesh, TOPIC);
				const coord0 = setup.coord0;
				const edgeNode = mesh.nodes[0]!;
				const seed = members[0]!.bytes;

				// Edge node: a cold T3 register is gated *before* any willingness gossip — Edge serves no T3.
				const edgeEngine = edgeNode.host.registry.forCoord(coord0, 0 as Tier, seed);
				const edgeP = await makeMember();
				const edgeReply = await edgeEngine.engine.handleRegister(await signedRegister(edgeP, TOPIC, T0, 'edge-t3', { tier: 3 }), REG, T0);
				expect(edgeReply.result, 'an Edge member will not instantiate a T3 luxury topic').to.equal('no_state');
				expect(edgeEngine.servesTopic(TOPIC), 'no forwarder state instantiated on the Edge member').to.equal(false);

				// Core cohort member (≠ the edge node, willingness-seeded by setupTopic): admits the same T3 topic.
				const coreId = setup.cohortIds.find((id) => id !== edgeNode.member.idStr)!;
				const coreEngine = setup.engines.get(coreId)!;
				const coreP = await makeMember();
				const coreReply = await coreEngine.engine.handleRegister(await signedRegister(coreP, TOPIC, T0, 'core-t3', { tier: 3 }), REG, T0);
				expect(coreReply.result, 'a Core member admits the T3 topic under a willing quorum').to.equal('accepted');
				expect(coreEngine.servesTopic(TOPIC), 'the Core member instantiated forwarder state').to.equal(true);
			} finally {
				await mesh.stop();
			}
		});
	});

	describe('§Tree growth and lookup + §Promotion and demotion lifecycle', () => {
		it('driving > cap_promote registrations at one coordinate fires promotion and redirects further arrivals with Promoted(d+1)', async () => {
			const TOPIC = topic(3);
			const capPromote = 8; // lowered so a small participant count crosses the threshold deterministically
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, capPromote });
			try {
				const { decidingEngine } = await setupTopic(mesh, TOPIC);
				await decidingEngine.onStabilized(T0); // publish the cohort cert so the promotion notice can be carried

				for (let i = 0; i < capPromote; i++) {
					const p = await makeMember();
					const reply = await decidingEngine.engine.handleRegister(await signedRegister(p, TOPIC, T0, `grow-${i}`), REG, T0);
					expect(reply.result, `arrival ${i} admitted up to the cap`).to.equal('accepted');
				}

				// Promotion is fire-and-forget (threshold-signs off the reply path); it lands within a few rounds.
				expect(await waitFor(() => decidingEngine.isPromoted(TOPIC), 8_000), 'the cohort promotes once direct participants reach cap_promote').to.equal(true);

				// Every further same-tier arrival is bounced onward with the cheap single-RPC redirect.
				const overflow = await makeMember();
				const redirect = await decidingEngine.engine.handleRegister(await signedRegister(overflow, TOPIC, T0, 'overflow'), REG, T0);
				expect(redirect.result, 'a post-promotion arrival is redirected, not admitted').to.equal('promoted');
				expect(redirect.targetTier, 'redirected to tier d+1').to.equal(1);
			} finally {
				await mesh.stop();
			}
		});

		it('claim 5 — sticky promotion: a freshly-promoted cohort keeps redirecting within T_promote_sticky (no flap back to accepting)', async () => {
			const TOPIC = topic(4);
			const capPromote = 6;
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, capPromote });
			try {
				const { decidingEngine } = await setupTopic(mesh, TOPIC);
				await decidingEngine.onStabilized(T0);
				for (let i = 0; i < capPromote; i++) {
					await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC, T0, `sticky-${i}`), REG, T0);
				}
				expect(await waitFor(() => decidingEngine.isPromoted(TOPIC), 8_000), 'promoted').to.equal(true);
				const promotedAt = T0;

				// Within the sticky window the cohort must NOT flap back to admitting — it keeps redirecting.
				const within = promotedAt + Math.floor(DEFAULT_T_PROMOTE_STICKY_MS / 2);
				expect(stickyHolds(promotedAt, within), 'the chosen instant is inside T_promote_sticky').to.equal(true);
				const reply = await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC, within, 'within-sticky'), REG, within);
				expect(reply.result, 'still redirecting inside the sticky window (no flap to accepting)').to.equal('promoted');
				expect(decidingEngine.isPromoted(TOPIC), 'still promoted inside the sticky window').to.equal(true);
			} finally {
				await mesh.stop();
			}
		});

		it('§Demotion — a tier-0 root never demotes: draining below cap_demote past T_demote leaves it serving + promoted', async () => {
			const TOPIC = topic(5);
			const capPromote = 6;
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, capPromote });
			try {
				const { decidingEngine } = await setupTopic(mesh, TOPIC);
				await decidingEngine.onStabilized(T0);
				for (let i = 0; i < capPromote; i++) {
					await decidingEngine.engine.handleRegister(await signedRegister(await makeMember(), TOPIC, T0, `drain-${i}`), REG, T0);
				}
				expect(await waitFor(() => decidingEngine.isPromoted(TOPIC), 8_000), 'promoted').to.equal(true);
				expect(capPromote, 'the cohort drained well below cap_demote').to.be.lessThan(DEFAULT_CAP_DEMOTE + 1);

				// Drain every direct participant (TTL sweep), then run the demotion check a full T_demote later.
				const drainAt = T0 + DEFAULT_TTL_MS + 1;
				decidingEngine.engine.sweepStale(drainAt);
				const checkAt = drainAt + DEFAULT_T_DEMOTE_MS + 1;
				await decidingEngine.demotionTick(checkAt);

				// The root (tier 0) never demotes — the forwarder state (and promoted mode) survive the drain.
				expect(decidingEngine.treeTier, 'this is the tier-0 root').to.equal(0);
				expect(decidingEngine.servesTopic(TOPIC), 'the root retains forwarder state after draining past T_demote').to.equal(true);
				expect(decidingEngine.isPromoted(TOPIC), 'the root stays promoted — root-never-demotes').to.equal(true);
			} finally {
				await mesh.stop();
			}
		});

		it.skip('multi-tier tree grows to depth ⌈log_F(N/cap_promote)⌉ via live Promoted-redirect follow-on [DOC EXPECTATION NOT YET IMPLEMENTED — followOn instantiation parked: cohort-topic-followon-derivation]', () => {
			// A live walk that draws Promoted(1) recomputes coord_1 and registers there, but the host hardcodes
			// `followOn: false` and only the root sets `bootstrap`, so a tier-1 cohort answers `no_state` rather
			// than instantiating (see host.ts dispatchRegister + coldstart shouldInstantiate). Real multi-tier
			// depth — and therefore the simulator's ⌈log_F(N/cap_promote)⌉ depth law over the live engine — is
			// unreachable until follow-on derivation lands. The depth law itself is validated by the simulator
			// (promotion-convergence.ts); this placeholder marks the e2e gap rather than omitting the claim.
		});

		it.skip('tier-(d>0) demotion threshold-signs a DemotionNoticeV1 to the parent cohort [DOC EXPECTATION NOT YET IMPLEMENTED at e2e — parent child-link recording parked: cohort-topic-parent-child-link]', () => {
			// demotionTick at a tier-d>0 engine can threshold-sign + broadcast a DemotionNoticeV1, but the
			// parent-side childCohortCount recording (the observable effect, "drop me from your children") is
			// parked, so there is no end-to-end parent state to assert against. Promotion/demotion hysteresis
			// and the no-children/T_demote gate are covered at unit level by db-core promotion.spec.ts.
		});
	});

	describe('§Membership rotation and primary handoff + §Failure modes', () => {
		it('crash failover: a signed reattach on backups[0] promotes it to primary; subsequent plain pings are served via the epoch-scoped override', async () => {
			const TOPIC = topic(6);
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
			try {
				const { decidingEngine, deciding, engines } = await setupTopic(mesh, TOPIC);

				// A participant whose computed primary is the deciding node; its first warm backup is the sibling.
				const p = await participantPrimaryAt(deciding, decidingEngine);
				const { members: cohortMembers, cohortEpoch } = decidingEngine.cohort();
				const slot = slots.assignSlots(p.bytes, cohortEpoch, cohortMembers);
				const backupId = bytesToPeerIdString(slot.backups[0]!);
				const backupEngine = engines.get(backupId)!;

				// Register on the primary, then touch + replicate so the backup holds the record before failover.
				expect((await decidingEngine.engine.handleRegister(await signedRegister(p, TOPIC, T0, 'failover'), REG, T0)).result).to.equal('accepted');
				expect(decidingEngine.engine.handleRenew(await signedPing(p, TOPIC, T0, 'touch'), T0).result, 'primary touches the record').to.equal('ok');
				await decidingEngine.gossipRound(T0);
				await delay(30);
				expect(backupEngine.holds(TOPIC, p.bytes), 'the backup replicated the record').to.equal(true);

				// Crash the primary (unreachable, but still in FRET assembly so the epoch — and slot math — is
				// unchanged). The participant's 3-fail path re-attaches to backups[0] with a SIGNED reattach.
				mesh.crashNode(deciding.member.idStr);
				const reattach = await signedReattach(p, TOPIC, T0 + 1);
				expect(backupEngine.engine.handleRenew(reattach, T0 + 1).result, 'the backup accepts the crash-failover promotion').to.equal('ok');

				// The unchanged epoch still names the dead node as computed primary, so a subsequent PLAIN ping is
				// served only via the epoch-scoped failover override the reattach installed.
				expect(backupEngine.engine.handleRenew(await signedPing(p, TOPIC, T0 + 2, 'post-failover'), T0 + 2).result, 'the promoted backup serves subsequent plain pings').to.equal('ok');
				// Sanity: the slot math is unchanged (the dead node is still the computed primary — only the override serves).
				expect(bytesToPeerIdString(slots.assignSlots(p.bytes, decidingEngine.cohort().cohortEpoch, decidingEngine.cohort().members).primary), 'epoch unchanged by a crash → computed primary is still the dead node').to.equal(deciding.member.idStr);
			} finally {
				await mesh.stop();
			}
		});

		it.skip('membership rotation primary handoff (dual-serve until ack) [DOC EXPECTATION NOT YET IMPLEMENTED — registration/handoff.ts is not wired into the FRET host]', () => {
			// The §Membership rotation handoff state machine (inventory → pull → dual-serve → ack) lives in
			// db-core registration/handoff.ts and is unit-tested there, but host.ts wires no rotation driver
			// (cohort() recomputes the epoch on each call; nothing pulls records or runs the dual-serve window).
			// A real rotation under the mock transport therefore has no host-level handoff to observe. Crash
			// failover (above) is the wired failover path; rotation handoff is the e2e gap.
		});
	});

	describe('§Registration record — gossip replication at cohort scale', () => {
		it('a touched record replicates to the whole k-member cohort in one gossip round; an eviction converges across it', async () => {
			const TOPIC = topic(7);
			const members = await makeMembers(N);
			const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
			try {
				const { decidingEngine, deciding, engines } = await setupTopic(mesh, TOPIC);
				const siblingEngines = [...engines.entries()].filter(([id]) => id !== deciding.member.idStr).map(([, e]) => e);
				expect(siblingEngines.length, 'a production-shaped cohort of k siblings').to.equal(WANT_K - 1);

				const p = await participantPrimaryAt(deciding, decidingEngine);
				expect((await decidingEngine.engine.handleRegister(await signedRegister(p, TOPIC, T0, 'fanout'), REG, T0)).result).to.equal('accepted');
				expect(decidingEngine.engine.handleRenew(await signedPing(p, TOPIC, T0, 'touch'), T0).result).to.equal('ok');

				// One gossip round broadcasts the touched record to the cohort over `cohort-gossip`.
				const g = await decidingEngine.gossipRound(T0);
				expect(g?.records?.length, 'the round carries the touched record').to.equal(1);
				await delay(40);
				const replicated = siblingEngines.filter((e) => e.holds(TOPIC, p.bytes)).length;
				expect(replicated, 'every cohort sibling replicated the record in one round').to.equal(siblingEngines.length);

				// Sweep the now-stale record on the primary and gossip the eviction — the whole cohort converges.
				const later = T0 + DEFAULT_TTL_MS + 1;
				const gEvict = await decidingEngine.gossipRound(later);
				expect(gEvict?.evicted?.length, 'the stale record was swept and queued as an eviction').to.equal(1);
				await delay(40);
				const stillHold = siblingEngines.filter((e) => e.holds(TOPIC, p.bytes)).length;
				expect(stillHold, 'the cohort converged on the eviction').to.equal(0);
			} finally {
				await mesh.stop();
			}
		});
	});
});
