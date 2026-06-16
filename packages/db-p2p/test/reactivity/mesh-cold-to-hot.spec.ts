/**
 * Reactivity **mock-tier e2e — cold-to-hot subscription growth + delivery verification**
 * (`docs/reactivity.md` §Worked scenarios — cold collection becomes popular, §Delivery, §Notification
 * origination, §Authentication and integrity).
 *
 * Drives the **real** reactivity hot path over the in-process reactivity mesh
 * ({@link import("../../src/testing/reactivity-mesh-harness.js").ReactivityMesh}): a cold collection gains
 * subscribers across nodes, commits flow through the real local-change-notifier bridge → real origination
 * (reusing the commit cert's threshold signature unchanged), and every subscriber's real
 * `ReactivitySubscriptionManager` surfaces the notifications **contiguous, deduped, and verified against the
 * tail cohort's `MembershipCertV1` with real Ed25519 collected-multisig crypto** (no pass-crypto stub).
 *
 * **Single-tier-0 reach (honest).** The cohort-topic substrate under this mesh serves a single tier-0
 * cohort; multi-tier *serving* promotion to a tier-`d ≥ 1` forwarder cohort is gated on the cohort-topic
 * follow-ons (same posture as the matchmaking mesh harness). So "a tree forms" is asserted at the mock tier
 * as **the promotion machinery firing** (the tail cohort begins to grow once subscribers cross
 * `cap_promote`) and **delivery reaching every direct subscriber**; the deep multi-tier forwarder fan-out,
 * and the quantitative "depth tracks subscriber count" regime (the simulator's job), are tagged
 * **[unimplemented:mock-tier]** below.
 */

import { expect } from 'chai';
import { Tier, bytesToB64url } from '@optimystic/db-core';
import { buildReactivityMesh, type ReactivityMesh } from '../../src/testing/reactivity-mesh-harness.js';

describe('reactivity / mesh — cold-to-hot growth + delivery', () => {
	let rx: ReactivityMesh;
	afterEach(async () => {
		await rx?.stop();
	});

	it('a cold collection gains subscribers across nodes and every one receives contiguous, verified notifications', async () => {
		rx = await buildReactivityMesh({ nodeCount: 12, wantK: 6 });
		await rx.registerCollection('orders');

		// Subscribers attach from distinct nodes (the cold collection becoming popular).
		const subs = await Promise.all([1, 3, 5, 7, 9].map((node) => rx.subscribe(node, 'orders')));
		// The real subscribe walk landed each registration in the tier-0 cohort store.
		expect(rx.cohortSubscriberCount('orders'), 'every reactivity subscribe record is in the tier-0 cohort').to.equal(subs.length);

		// Commit a run of transactions; each originates one notification fanned to every subscriber.
		await rx.commit('orders', 6);

		for (const s of subs) {
			const revs = s.delivered.map((n) => n.revision);
			expect(revs, 'contiguous, in-order delivery 1..6').to.deep.equal([1, 2, 3, 4, 5, 6]);
			// Origination reused the commit cert: the digest is the commit-vote signed payload utf8(hash:approve).
			expect(s.delivered[0]!.digest).to.equal(bytesToB64url(new TextEncoder().encode(`${bytesToB64url(new TextEncoder().encode('reactivity:orders'))}:1:approve`)));
		}
	});

	it('drops an untrusted notification (signers not the tail cohort) — no pass-crypto stub', async () => {
		rx = await buildReactivityMesh({ nodeCount: 10, wantK: 5 });
		await rx.registerCollection('ledger');
		const s = await rx.subscribe(2, 'ledger');
		await rx.commit('ledger', 1);
		expect(s.delivered.map((n) => n.revision)).to.deep.equal([1]);

		// A forged notification at the next revision, "signed" by a non-cohort key, must fail the real verify.
		const real = s.delivered[0]!;
		const forged = { ...real, revision: 2, sig: bytesToB64url(new Uint8Array(64).fill(7)) };
		const outcome = await s.manager.onNotification(forged);
		expect(outcome, 'real Ed25519 verify rejects the forged sig').to.equal('untrusted');
		expect(s.delivered.map((n) => n.revision), 'the forged revision was not surfaced').to.deep.equal([1]);
	});

	it('a duplicate re-delivery is deduped by (collectionId, revision) — at-least-once tolerated', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		await rx.registerCollection('inventory');
		const s = await rx.subscribe(1, 'inventory');
		await rx.commit('inventory', 3);
		expect(s.delivered.map((n) => n.revision)).to.deep.equal([1, 2, 3]);

		// Re-deliver revision 2 (a forwarder retransmit / partition-merge duplicate): the subscriber discards it.
		const dup = s.delivered[1]!;
		expect(await s.manager.onNotification(dup)).to.equal('duplicate');
		expect(s.delivered.map((n) => n.revision), 'no double-delivery').to.deep.equal([1, 2, 3]);
	});

	it('a late subscriber adopts the first verified notification as its baseline (no spurious backfill)', async () => {
		rx = await buildReactivityMesh({ nodeCount: 8, wantK: 4 });
		await rx.registerCollection('feed');
		await rx.commit('feed', 5); // collection is already at revision 5 when the subscriber attaches

		const late = await rx.subscribe(3, 'feed');
		await rx.commit('feed', 2); // revisions 6, 7
		expect(late.delivered.map((n) => n.revision), 'fresh subscribe baselines on rev 6, then 7 contiguous').to.deep.equal([6, 7]);
		expect(late.backfills, 'no backfill — a fresh subscriber adopts the first notification').to.equal(0);
	});

	it('[mock-tier] the tier-0 cohort promotes once subscribers cross cap_promote (the tree begins to form), and delivery still reaches all', async () => {
		// Drive the cohort-side promotion decision with a lowered cap. The cohort-topic scale specs own the
		// full multi-tier walk; here we assert reactivity subscribers crossing the cap trip a *real* promotion.
		rx = await buildReactivityMesh({ nodeCount: 16, wantK: 8, capPromote: 4 });
		await rx.registerCollection('hot');
		expect(rx.isPromoted('hot'), 'a cold cohort has not promoted').to.equal(false);

		// More than cap_promote (4) reactivity subscribers attach at the root, crossing the threshold.
		const subs = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => rx.subscribe(n, 'hot')));
		for (const s of subs) {
			// Tier.T3 is the *reactivity application tier* every subscribe registers under — not a tree depth.
			expect(s.registration!.tier, 'each reactivity subscribe admits at the reactivity tier T3').to.equal(Tier.T3);
		}
		expect(rx.cohortSubscriberCount('hot'), 'all subscribers landed in the tier-0 cohort store').to.equal(subs.length);

		// Publish the cohort cert so the fire-and-forget promotion decision lands deterministically.
		await rx.stabilizeCohort('hot');
		expect(rx.isPromoted('hot'), 'the cohort promoted once direct participants crossed cap_promote').to.equal(true);

		// Delivery still reaches every subscriber while the tree begins to form.
		await rx.commit('hot', 2);
		for (const s of subs) {
			expect(s.delivered.map((n) => n.revision)).to.deep.equal([1, 2]);
		}
		// NOTE [unimplemented:mock-tier]: the multi-tier *serving* fan-out (a tier-d>=1 forwarder cohort
		// actually relaying notifications) and the quantitative depth-vs-subscriber-count regime are gated on
		// the cohort-topic follow-ons + the design simulator; this mesh serves a single tier-0 cohort. The
		// cold-to-hot growth claim is covered here as: the cohort's promotion decision fires + delivery to all.
	});
});
