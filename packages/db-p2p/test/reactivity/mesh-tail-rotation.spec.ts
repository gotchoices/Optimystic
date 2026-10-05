/**
 * Reactivity **mock-tier e2e — tail rotation: same topic, the root moves** (`docs/reactivity.md` §Tail
 * rotation, §Anchor — one topic per collection, a root that follows the tail, §Worked scenarios — tail
 * rotation during steady-state load).
 *
 * Drives the **real** rotation lifecycle over the reactivity mesh: a tail block fills under steady commit
 * load, the filling commit carries the real `rotationHint` pre-announce (built by `buildRotationHint`,
 * detected subscriber-side by the real manager's `detectRotation` → a jittered follow plan), the tail
 * rotates (new `tailId` → a new root coord/group for the **unchanged** topic), the outgoing replay ring is
 * folded into a final handoff checkpoint onto the new root (`buildRotationHandoffCheckpoint` /
 * `applyRotationHandoff`), every live subscriber's real manager follows the new tail (`followTail`: a
 * registration at the root re-registers under the new root key over the real walk, one below the root moves
 * its root key and sends nothing), and the delivered revision stream stays **continuous with no gap across
 * the handoff**. The old root's drain lifecycle (serve renewals/replays for `T_drain`, bounce new
 * subscriptions with a `Promoted`-shaped redirect naming the new tail) is exercised against the real
 * `TailDrainGate` over the harness virtual clock.
 *
 * **At-scale burst is the simulator's.** The re-registration wave staying within `cap_promote_fast = 32`
 * inside `T_drain = 60 s` is validated quantitatively by the design simulator (`docs/reactivity.md` §Worked
 * scenarios) — for the previous design, in which every subscriber re-registered. Here the wave is planned via
 * the real `planReRegistrationWave` with `capPromote = cap_promote_fast` over the root's direct subscribers
 * only; the mock tier asserts the bound holds and the wiring composes.
 */

import { expect } from 'chai';
import { TailDrainGate, bytesToB64url, DEFAULT_CAP_PROMOTE_FAST, T_REJOIN_JITTER_MS } from '@optimystic/db-core';
import { buildReactivityMesh, type ReactivityMesh } from '../../src/testing/reactivity-mesh-harness.js';

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_v, i) => lo + i);

/** The first node index above every one of `others` whose tier-1 shard (`coord_1(P, topicId)`) none of them shares. */
function shardApartFrom(rx: ReactivityMesh, collection: string, others: readonly number[]): number {
	const taken = new Set(others.map((i) => bytesToB64url(rx.tierOneCoord(i, collection))));
	for (let i = Math.max(...others) + 1; i < rx.members.length; i++) {
		if (!taken.has(bytesToB64url(rx.tierOneCoord(i, collection)))) {
			return i;
		}
	}
	throw new Error(`every node shares a tier-1 shard with one of nodes ${others.join(', ')}`);
}

describe('reactivity / mesh — tail rotation continuity', function () {
	// Real-Ed25519 multi-cohort mesh: setup + round-trips are CPU-bound. The suite runs serially in a single
	// ~7-minute Node process, so tests near the back face large GC-pressured heaps and wall-clock variance
	// stacks on top of the isolation cost — machine load, not a defect, threatens the clock. 120s is the
	// uniform ceiling across the full real-Ed25519 mesh e2e class so no member becomes the next timeout victim.
	this.timeout(120_000);
	let rx: ReactivityMesh;
	afterEach(async () => {
		await rx?.stop();
	});

	it('the filling commit pre-announces the rotation; subscribers surface a jittered follow plan carrying lastRevision', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		await rx.registerCollection('books', { blockFillSize: 8 });
		const s = await rx.subscribe(1, 'books');

		await rx.commit('books', 7); // no rotation hint yet
		expect(s.rotationNotices, 'no pre-announce before the block fills').to.have.length(0);

		await rx.commit('books', 1); // the 8th commit fills the block → carries the rotationHint
		expect(s.delivered.map((n) => n.revision)).to.deep.equal(range(1, 8));
		expect(s.rotationNotices, 'exactly one pre-announce surfaced').to.have.length(1);
		const notice = s.rotationNotices[0]!;
		expect(notice.preAnnounced, 'a pre-announce, not a hard rotation').to.equal(true);
		expect(notice.newTailId).to.equal(bytesToB64url(new TextEncoder().encode('books:tail-8')));
		expect(notice.plan.lastRevision, 'the follow carries lastRevision (continuous across the rotation)').to.equal(8);
		expect([...notice.plan.newTailId], 'the plan names the new root key').to.deep.equal([...new TextEncoder().encode('books:tail-8')]);
	});

	it('the delivered revision stream is continuous with no gap across the handoff; the root moved, the topic did not', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		await rx.registerCollection('stream', { blockFillSize: 8 });
		const a = await rx.subscribe(1, 'stream');
		const b = await rx.subscribe(2, 'stream');
		const topicBefore = bytesToB64url(rx.collectionTopicId('stream'));
		const handleBefore = a.registration!;

		await rx.commit('stream', 8); // fills the block at revision 8 (pre-announce rides revision 8)
		const rotation = await rx.rotateTail('stream');
		expect(rotation.rotationRevision).to.equal(8);
		expect(bytesToB64url(rx.collectionTopicId('stream')), 'the collection keeps its topic').to.equal(topicBefore);
		// Both subscribers were registered at the root, so each registered again under the new root key.
		expect(a.registration, 'a registration at the root is a new registration after the move').to.not.equal(handleBefore);
		expect([...a.registration!.rootKey!]).to.deep.equal([...rotation.newTailId]);
		expect([...a.registration!.topicId], 'on the same topic').to.deep.equal([...rx.collectionTopicId('stream')]);
		expect(rx.cohortSubscriberCount('stream'), 'the new root holds both registrations').to.equal(2);

		// The outgoing replay ring folded into a final handoff checkpoint, landed on the new root.
		expect(rotation.handoff, 'buffer-to-checkpoint handoff produced').to.not.equal(undefined);
		expect(rotation.handoff!.toRevision, 'handoff covers up to the rotation revision').to.equal(8);
		expect(rx.pushStateOf('stream').inheritedCheckpoint?.toRevision, 'new root holds the old checkpoint (resume-across-rotation seam)').to.equal(8);

		// Commit at the NEW root; the followed subscribers continue with no gap.
		await rx.commit('stream', 4); // revisions 9..12 at the new root
		expect(a.delivered.map((n) => n.revision), 'continuous 1..12 across the rotation boundary').to.deep.equal(range(1, 12));
		expect(b.delivered.map((n) => n.revision)).to.deep.equal(range(1, 12));
		// Continuity is by revision monotonicity, not tail identity: revisions 1..8 were announced at the old root, 9..12 at the new.
		expect(a.delivered[7]!.tailId).to.not.equal(a.delivered[8]!.tailId);
		expect(a.delivered[7]!.collectionId, 'one collection, one topic, across the move').to.equal(a.delivered[8]!.collectionId);
	});

	it('the re-registration wave stays within cap_promote_fast (the fast-promote bound)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 10, wantK: 4 });
		await rx.registerCollection('wave', { blockFillSize: 16 });
		const subs = await Promise.all(range(1, 6).map((n) => rx.subscribe(n, 'wave')));
		await rx.commit('wave', 5);
		const rotation = await rx.rotateTail('wave');

		expect(rotation.plans, 'one plan per live subscriber registered at the root').to.have.length(subs.length);
		expect(rotation.peakWindowArrivals, 'peak arrivals per T_rejoin_jitter window stays within cap_promote_fast').to.be.at.most(DEFAULT_CAP_PROMOTE_FAST);
		for (const plan of rotation.plans) {
			expect(plan.lastRevision, 'every plan carries the subscriber lastRevision (continuity)').to.equal(5);
		}
		// NOTE [unimplemented:mock-tier]: the at-scale burst peaking at exactly 32 within T_drain is the design
		// simulator's quantitative claim for the previous whole-tree wave (docs/reactivity.md §Worked scenarios);
		// in this design only the root's direct subscribers (at most `cap_promote`) re-register.
	});

	it('the outgoing root drain gate serves renewals/replays and bounces new subscriptions for T_drain (Promoted-shaped redirect naming the new tail)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		await rx.registerCollection('drain', { blockFillSize: 8 });
		await rx.subscribe(1, 'drain');
		await rx.commit('drain', 8);
		const rotation = await rx.rotateTail('drain');
		const topicId = bytesToB64url(rx.collectionTopicId('drain'));

		// The real drain gate over the harness virtual clock (T_drain default 60 s).
		const gate = new TailDrainGate({ rotatedAt: rx.now, newTailId: rotation.newTailIdB64, topicId, effectiveAtRevision: rotation.rotationRevision + 1 });
		const redirect = gate.classify('new_subscribe', rx.now);
		expect(redirect.kind, 'a new subscription is bounced to the new root').to.equal('redirect');
		if (redirect.kind === 'redirect') {
			expect(redirect.redirect.result).to.equal('rotated');
			expect(redirect.redirect.newTailId, 'the redirect names the new root key').to.equal(rotation.newTailIdB64);
			expect(redirect.redirect.newTopicId, 'the topic on the redirect is the collection topic, unchanged').to.equal(topicId);
		}
		expect(gate.classify('renew', rx.now).kind, 'renewals served through the drain').to.equal('serve');
		expect(gate.classify('replay', rx.now).kind, 'replays served through the drain').to.equal('serve');

		// After T_drain elapses the old root holds nothing — every op is `drained` (re-register from d_max).
		rx.advanceTime(60_001);
		expect(gate.classify('new_subscribe', rx.now).kind).to.equal('drained');
		expect(gate.classify('replay', rx.now).kind).to.equal('drained');
	});

	it('a recover redirect drives the follow end-to-end with no gap (markRotated → rotated reply → onRotation → scheduler → reRegister → followTail)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		// Default block fill (32) → no pre-announce in this short run, so the rotation is driven purely through
		// the recover redirect path (preAnnounced: false), not a notification-driven pre-announce.
		await rx.registerCollection('redir');
		const s = await rx.subscribe(1, 'redir');
		const handleBefore = s.registration!;
		await rx.commit('redir', 8);
		expect(s.delivered.map((n) => n.revision)).to.deep.equal(range(1, 8));
		expect(s.rotationNotices, 'no pre-announce before the block fills').to.have.length(0);

		// Rotate WITHOUT following at once: the live recover serve models markRotated, so a stale resume is bounced.
		const rotation = await rx.rotateTail('redir', { autoReattach: false });

		// The subscriber slept across the rotation; resuming against the OLD root returns the kind:"rotated"
		// redirect, which the manager honors through the SAME onRotation seam a pre-announce uses.
		rx.sleepSubscriber(s);
		expect(await rx.resume(s), 'the redirect resolves resume() as a tail rotation (never throws out)').to.equal('tail_rotated');
		expect(s.rotationNotices, 'the recover redirect surfaced a rotation once').to.have.length(1);
		expect(s.rotationNotices[0]!.preAnnounced, 'recover-driven, not a pre-announce').to.equal(false);
		expect(s.rotationNotices[0]!.newTailId).to.equal(bytesToB64url(new TextEncoder().encode('redir:tail-8')));
		expect(s.scheduler.pendingCount, 'the host scheduler armed the jittered follow timer').to.equal(1);

		// Until the jittered timer fires the subscriber is still at the old root. Advance the virtual clock past
		// the jitter window → the scheduler fires reRegister → the manager follows the new tail: a registration at
		// the root, so it registers again under the new root key.
		rx.advanceTime(T_REJOIN_JITTER_MS + 1);
		expect(s.scheduler.pendingCount, 'the follow timer fired over the virtual clock').to.equal(0);

		// Commit at the NEW root (which first waits for the follow to land); the subscriber continues with NO gap.
		await rx.commit('redir', 4); // revisions 9..12 at the new root
		expect(s.registration, 'the root-direct subscriber re-registered').to.not.equal(handleBefore);
		expect([...s.registration!.rootKey!]).to.deep.equal([...rotation.newTailId]);
		expect(s.delivered.map((n) => n.revision), 'continuous 1..12 across the redirect-driven follow').to.deep.equal(range(1, 12));
		expect(s.manager.lastRevision).to.equal(12);
	});

	it('a cross-rotation resume is served from the inherited checkpoint (checkpoint_window, not out_of_window)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		// Scaled stacked windows (ring W = 4) and default block fill (32 → no pre-announce in this short run).
		await rx.registerCollection('inherit', { w: 4, wCheckpoint: 12 });
		await rx.commit('inherit', 8); // old ring holds [5..8], rolling checkpoint [1..4]

		const rotation = await rx.rotateTail('inherit');
		// The outgoing replay ring folded into a final handoff checkpoint, landed on the new root.
		expect(rotation.handoff!.toRevision, 'handoff covers up to the rotation revision').to.equal(8);
		expect(rx.pushStateOf('inherit').inheritedCheckpoint?.toRevision, 'new root holds the inherited checkpoint').to.equal(8);

		await rx.commit('inherit', 4); // new ring holds [9..12], low edge 9 abuts the inherited window's high edge 8

		// A subscriber at the NEW root whose resume `fromRevision` (7) is below the new ring's low edge (9) but
		// within the inherited checkpoint [5..8]: served checkpoint_window from the inherited summary, then the
		// ring's recent entries — NOT out_of_window.
		const s = await rx.subscribe(2, 'inherit', { lastKnownRev: 6 });
		rx.sleepSubscriber(s);
		expect(await rx.resume(s), 'cross-rotation resume served from the inherited checkpoint').to.equal('checkpoint_applied');
		expect(s.checkpointDigests, 'exactly one (inherited) checkpoint summary applied').to.have.length(1);
		expect(s.checkpointDigests[0]!.toRevision).to.equal(8);
		expect(s.delivered.map((n) => n.revision), 'the new ring entries replay gap-free above the inherited window').to.deep.equal([9, 10, 11, 12]);
		expect(s.manager.lastRevision).to.equal(12);
		expect(s.chainRead, 'a covered inherited checkpoint never forces a chain read').to.equal(false);
	});

	it('a cross-rotation resume bridges the inherited + new-rolling windows when the new root evicted past the handoff (two-link chain, one round trip)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		// Scaled stacked windows (ring W = 4, generous W_checkpoint) and default block fill (32 → no second rotation).
		await rx.registerCollection('bridge', { w: 4, wCheckpoint: 12 });
		await rx.commit('bridge', 8); // old root: ring [5..8], rolling checkpoint [1..4]

		const rotation = await rx.rotateTail('bridge');
		expect(rotation.handoff!.toRevision, 'handoff covers up to the rotation revision').to.equal(8);
		expect(rx.pushStateOf('bridge').inheritedCheckpoint?.toRevision, 'new root holds the inherited handoff [5,8]').to.equal(8);

		// Commit ENOUGH at the new root that its OWN rolling checkpoint forms BETWEEN the inherited window and the
		// ring: revisions 9..16 into a W=4 ring leave the ring holding [13..16] and the new rolling checkpoint
		// holding [9..12]. The three windows now stack inherited [5,8] → rolling [9,12] → ring [13,16] with no gap.
		await rx.commit('bridge', 8);
		expect(rx.pushStateOf('bridge').checkpoint.toRevision, 'new root rolling checkpoint sits between the inherited window and the ring').to.equal(12);

		// A subscriber at the NEW root whose resume `fromRevision` (7) is inside the inherited window [5,8] —
		// below BOTH the new rolling checkpoint [9,12] and the ring [13,16]. Pre-bridge this was out_of_window (a
		// single-checkpoint reply could not carry all three windows); now it is answered with the two-link chain.
		const s = await rx.subscribe(2, 'bridge', { lastKnownRev: 6 });
		rx.sleepSubscriber(s);
		expect(await rx.resume(s), 'the bridge recovers the full cross-rotation span in one round trip').to.equal('checkpoint_applied');
		expect(s.checkpointDigests.map((d) => d.toRevision), 'both links applied in order: inherited [.,8] then rolling [.,12]').to.deep.equal([8, 12]);
		expect(s.delivered.map((n) => n.revision), 'the ring entries replay gap-free above the bridged chain').to.deep.equal([13, 14, 15, 16]);
		expect(s.manager.lastRevision).to.equal(16);
		expect(s.chainRead, 'the bridge never forces a chain read').to.equal(false);
	});

	it('tiers below the root survive a rotation: root-direct subscribers re-register at the new root, a tier-1 subscriber sends no register frame', async () => {
		// cap_promote 2: the second root-direct subscriber crosses the cap, and once the root's certificate is
		// published the root is promoted, so the next subscriber's walk is redirected to tier 1 (the live-tier
		// specs drive promotion by lowering the cap the same way). A tier-1 cohort instantiates only where a
		// willing quorum exists, so one is seeded at that subscriber's coord_1 first.
		rx = await buildReactivityMesh({ nodeCount: 12, wantK: 4, capPromote: 2 });
		await rx.registerCollection('tiers');
		const topicId = rx.collectionTopicId('tiers');
		const a = await rx.subscribe(1, 'tiers');
		const b = await rx.subscribe(2, 'tiers');
		await rx.stabilizeCohort('tiers');
		expect(rx.isPromoted('tiers'), 'the root promoted once its direct subscribers crossed cap_promote').to.equal(true);

		// A root-direct subscriber's follow re-walks from d_max, and a walk that meets a tier-1 cohort serving the
		// topic in its own shard lands there — correctly. So the tier-1 subscriber must sit in a shard neither
		// root-direct subscriber shares, or one of them leaves the root on the rotation. Keys are random per mesh.
		const tierOneIndex = shardApartFrom(rx, 'tiers', [1, 2]);
		const tierOne = await rx.seedTierOneCohort(tierOneIndex, 'tiers');
		const c = await rx.subscribe(tierOneIndex, 'tiers');
		expect(a.registration!.treeTier, 'the first subscribers landed at the root').to.equal(0);
		expect(b.registration!.treeTier).to.equal(0);
		expect(c.registration!.treeTier, 'the third was redirected and landed at tier 1').to.equal(1);
		expect(tierOne.engine.holds(topicId, rx.members[tierOneIndex]!.bytes), 'its record sits in the tier-1 cohort at coord_1(P, topicId)').to.equal(true);
		// NOTE: the harness models the notification transport as fan-out to every tracked subscriber; a running node
		// does not yet reach a subscriber below the root (backlog `feat-reactivity-notifications-reach-child-cohorts`).
		await rx.commit('tiers', 2);

		const before = { a: a.registration, c: c.registration };
		rx.mesh.clearRouteLog();
		const rotation = await rx.rotateTail('tiers');

		// The root's direct subscribers registered again, under the new root key, on the same topic.
		expect(a.registration, 'a registration at the root is made again at the new root').to.not.equal(before.a);
		expect(a.registration!.treeTier).to.equal(0);
		expect([...a.registration!.rootKey!]).to.deep.equal([...rotation.newTailId]);
		expect([...a.registration!.topicId]).to.deep.equal([...topicId]);
		expect(rx.cohortSubscriberCount('tiers'), 'the new root holds exactly the two root-direct subscribers').to.equal(2);
		expect(rotation.plans, 'the re-registration wave counts only the root-direct subscribers').to.have.length(2);

		// The tier-1 subscriber kept its registration: the same handle, its root key moved in place, its record still
		// at the tier-1 cohort, and no register frame routed anywhere near it.
		expect(c.registration, 'a registration below the root is kept').to.equal(before.c);
		expect(c.registration!.treeTier).to.equal(1);
		expect([...c.registration!.rootKey!], 'moveRoot pointed its next re-walk at the new root').to.deep.equal([...rotation.newTailId]);
		expect(tierOne.engine.holds(topicId, rx.members[tierOneIndex]!.bytes), 'the tier-1 cohort still holds it').to.equal(true);
		expect(rx.mesh.routedCoords.includes(bytesToB64url(tierOne.coord)), 'the rotation routed no register frame to the tier-1 cohort').to.equal(false);

		// Delivery continues across the move for everyone.
		await rx.commit('tiers', 2);
		for (const s of [a, b, c]) {
			expect(s.delivered.map((n) => n.revision), 'continuous across the root move').to.deep.equal(range(1, 4));
		}
	});
});
