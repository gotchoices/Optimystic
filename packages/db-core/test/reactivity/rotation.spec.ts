import { expect } from 'chai';
import {
	detectRotation,
	buildRotationHint,
	BlockFillTracker,
	TailDrainGate,
	planReRegistration,
	planReRegistrationWave,
	buildRotationHandoffCheckpoint,
	applyRotationHandoff,
	checkpointCovers,
	verifyCheckpointEndpoints,
	reactivityTopicId,
	PushState,
	BLOCK_FILL_SIZE_DEFAULT,
	WARM_THRESHOLD_DEFAULT,
	T_DRAIN_MS,
	T_REJOIN_JITTER_MS,
	type NotificationV1,
	type NotificationVerifier,
} from '../../src/reactivity/index.js';
import { createRejoinJitter } from '../../src/cohort-topic/antiflood/jitter.js';
import { bytesToB64url, b64urlToBytes } from '../../src/cohort-topic/wire/codec.js';

const b = (n: number): string => bytesToB64url(new Uint8Array([n]));
const TAIL_OLD = b(5);
const TAIL_NEW = b(6);

function note(revision: number, over: Partial<NotificationV1> = {}): NotificationV1 {
	return {
		v: 1,
		collectionId: b(1),
		tailId: TAIL_OLD,
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [b(8)],
		...over,
	};
}

/** A verifier with a fixed verdict (the rotation handoff only needs endpoint verification to resolve). */
const fixedVerifier = (verdict: 'verified' | 'untrusted' = 'verified'): NotificationVerifier => ({
	verify: () => Promise.resolve(verdict),
});

describe('reactivity tail rotation', () => {
	describe('subscriber-side detection', () => {
		it('detects a hard rotation when the delivered tailId differs from tailIdAtAttach', () => {
			const d = detectRotation(TAIL_OLD, note(100, { tailId: TAIL_NEW }));
			expect(d.rotated).to.equal(true);
			expect(d.newTailId).to.equal(TAIL_NEW);
			expect(d.preAnnounced).to.equal(false);
		});

		it('detects a pre-announce from rotationHint on a still-current-tail notification', () => {
			const d = detectRotation(TAIL_OLD, note(100, { rotationHint: { newTailId: TAIL_NEW, effectiveAtRevision: 101 } }));
			expect(d.rotated).to.equal(true);
			expect(d.newTailId).to.equal(TAIL_NEW);
			expect(d.preAnnounced).to.equal(true);
		});

		it('reports no rotation for a same-tail notification with no hint', () => {
			expect(detectRotation(TAIL_OLD, note(100)).rotated).to.equal(false);
		});

		it('treats an already-rotated delivery as a hard rotation even if a hint is also present', () => {
			const d = detectRotation(TAIL_OLD, note(100, { tailId: TAIL_NEW, rotationHint: { newTailId: b(7), effectiveAtRevision: 200 } }));
			expect(d.preAnnounced).to.equal(false);
			expect(d.newTailId).to.equal(TAIL_NEW);
		});
	});

	describe('buildRotationHint', () => {
		it('makes the rotation effective at fillingRevision + 1', () => {
			expect(buildRotationHint(TAIL_NEW, 5400)).to.deep.equal({ newTailId: TAIL_NEW, effectiveAtRevision: 5401 });
		});
	});

	describe('BlockFillTracker (warm-up + filling signal)', () => {
		it('uses the documented defaults (fill 64, warm 8 → warm at 56)', () => {
			const t = new BlockFillTracker();
			expect(t.blockFillSize).to.equal(BLOCK_FILL_SIZE_DEFAULT);
			expect(t.warmThreshold).to.equal(WARM_THRESHOLD_DEFAULT);
			expect(t.warmAt).to.equal(56);
		});

		it('fires warmup at block_fill_size − warm_threshold and filling at block_fill_size, then resets', () => {
			const t = new BlockFillTracker({ blockFillSize: 8, warmThreshold: 2 }); // warm at 6
			const kinds: string[] = [];
			for (let i = 0; i < 8; i++) kinds.push(t.onCommit().kind);
			expect(kinds).to.deep.equal(['none', 'none', 'none', 'none', 'none', 'warmup', 'none', 'filling']);
			expect(t.transactionsInBlock).to.equal(0); // reset after filling
			// the warmup signal carries the remaining-transaction count.
			const t2 = new BlockFillTracker({ blockFillSize: 8, warmThreshold: 2 });
			let warm;
			for (let i = 0; i < 6; i++) warm = t2.onCommit();
			expect(warm).to.deep.equal({ kind: 'warmup', count: 6, remaining: 2 });
		});

		it('disables warm-up when warm_threshold is 0', () => {
			const t = new BlockFillTracker({ blockFillSize: 4, warmThreshold: 0 });
			const kinds = [t.onCommit(), t.onCommit(), t.onCommit(), t.onCommit()].map((s) => s.kind);
			expect(kinds).to.deep.equal(['none', 'none', 'none', 'filling']);
		});

		it('rejects an out-of-range warm_threshold or block size', () => {
			expect(() => new BlockFillTracker({ blockFillSize: 4, warmThreshold: 4 })).to.throw(RangeError);
			expect(() => new BlockFillTracker({ blockFillSize: 0 })).to.throw(RangeError);
		});
	});

	describe('TailDrainGate (serve renewals/replays, bounce new subscriptions)', () => {
		const gate = (): TailDrainGate => new TailDrainGate({ rotatedAt: 1000, newTailId: TAIL_NEW, effectiveAtRevision: 5401, tDrainMs: 60_000 });

		it('redirects a new subscription to the new tree with the derived topicId during the drain', () => {
			const decision = gate().classify('new_subscribe', 1000 + 30_000); // mid-drain
			expect(decision.kind).to.equal('redirect');
			if (decision.kind !== 'redirect') throw new Error('unreachable');
			expect(decision.redirect.result).to.equal('rotated');
			expect(decision.redirect.newTailId).to.equal(TAIL_NEW);
			expect(decision.redirect.effectiveAtRevision).to.equal(5401);
			const expectedTopic = bytesToB64url(reactivityTopicId(b64urlToBytes(TAIL_NEW)));
			expect(decision.redirect.newTopicId).to.equal(expectedTopic);
		});

		it('serves renewals and replays through the drain window', () => {
			const g = gate();
			expect(g.classify('renew', 1000 + 10_000).kind).to.equal('serve');
			expect(g.classify('replay', 1000 + 59_999).kind).to.equal('serve');
		});

		it('reports drained for everything once T_drain has elapsed', () => {
			const g = gate();
			const after = 1000 + 60_000;
			expect(g.classify('renew', after).kind).to.equal('drained');
			expect(g.classify('replay', after).kind).to.equal('drained');
			expect(g.classify('new_subscribe', after).kind).to.equal('drained');
			expect(g.isDraining(after)).to.equal(false);
			expect(g.drainEndsAt).to.equal(1000 + 60_000);
		});

		it('defaults the drain window to T_drain', () => {
			const g = new TailDrainGate({ rotatedAt: 0, newTailId: TAIL_NEW, effectiveAtRevision: 1 });
			expect(g.drainEndsAt).to.equal(T_DRAIN_MS);
		});
	});

	describe('jittered re-registration', () => {
		it('plans one re-registration at the new topic carrying lastRevision, within the jitter window', () => {
			const jitter = createRejoinJitter({ tRejoinJitterMs: T_REJOIN_JITTER_MS, random: () => 0.999 });
			const plan = planReRegistration({ hint: { newTailId: TAIL_NEW }, lastRevision: 5400, now: 1000, jitter });
			expect([...plan.newTailId]).to.deep.equal([...b64urlToBytes(TAIL_NEW)]);
			expect([...plan.newTopicId]).to.deep.equal([...reactivityTopicId(b64urlToBytes(TAIL_NEW))]);
			expect(plan.lastRevision).to.equal(5400); // revisions continuous across the rotation
			expect(plan.fireAt).to.be.greaterThan(1000);
			expect(plan.fireAt).to.be.lessThan(1000 + T_REJOIN_JITTER_MS);
		});

		it('rate-bounds a re-registration storm to cap_promote_fast per T_rejoin_jitter window, inside T_drain', () => {
			// The new tail must never see more than cap_promote_fast (32) re-registrations in any
			// T_rejoin_jitter (30 s) window — the wave staggers at windowMs/cap so the bound holds by
			// construction (docs/reactivity.md §Tail rotation rotation-cost).
			const CAP_PROMOTE_FAST = 32;
			const jitter = createRejoinJitter({ tRejoinJitterMs: T_REJOIN_JITTER_MS, capPromote: CAP_PROMOTE_FAST });
			const subscribers = Array.from({ length: 40 }, (_v, i) => ({ lastRevision: 5400 + i }));
			const plans = planReRegistrationWave({ hint: { newTailId: TAIL_NEW }, subscribers, now: 0, jitter });

			expect(plans).to.have.length(40);
			// every plan re-registers at the same new tree, each carrying its own lastRevision.
			expect(plans.every((p) => [...p.newTopicId].join() === [...reactivityTopicId(b64urlToBytes(TAIL_NEW))].join())).to.equal(true);
			expect(plans.map((p) => p.lastRevision)).to.deep.equal(subscribers.map((s) => s.lastRevision));

			// any 30 s sliding window holds at most cap_promote_fast arrivals.
			const fireAts = plans.map((p) => p.fireAt);
			for (let i = 0; i < fireAts.length; i++) {
				const windowCount = fireAts.filter((t) => t >= fireAts[i]! && t < fireAts[i]! + T_REJOIN_JITTER_MS).length;
				expect(windowCount).to.be.at.most(CAP_PROMOTE_FAST);
			}
			// the first cap_promote_fast subscribers all land inside one drain window.
			expect(fireAts[CAP_PROMOTE_FAST - 1]!).to.be.at.most(T_DRAIN_MS);
		});
	});

	describe('buffer-to-checkpoint handoff', () => {
		// w=4 ring, wCheckpoint=8: seed 1..6 → ring [3,4,5,6], rolling checkpoint summarizes [1,2].
		const seededTail = (): PushState => {
			const state = new PushState({ collectionId: b(1), topicId: b(3), tailIdAtJoin: TAIL_OLD, w: 4, wCheckpoint: 8 });
			for (let rev = 1; rev <= 6; rev++) {
				state.replayBuffer.append({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
				if (rev > state.lastRevision) state.lastRevision = rev;
			}
			return state;
		};

		it('folds the replay buffer into a final checkpoint covering [lastCheckpoint.toRevision + 1, rotationRevision]', () => {
			const outgoing = seededTail();
			expect(outgoing.checkpoint.toRevision).to.equal(2); // rolling checkpoint holds the retired [1,2]
			const handoff = buildRotationHandoffCheckpoint(outgoing);
			expect(handoff).to.not.equal(undefined);
			expect(handoff!.rotationRevision).to.equal(6);
			expect(handoff!.checkpoint.fromRevision).to.equal(3); // abuts the rolling checkpoint's high edge
			expect(handoff!.checkpoint.toRevision).to.equal(6);
			expect(handoff!.checkpoint.bracketingEntries[0].revision).to.equal(3);
			expect(handoff!.checkpoint.bracketingEntries[1].revision).to.equal(6);
		});

		it('produces a checkpoint whose bracketing endpoints verify end-to-end', async () => {
			const handoff = buildRotationHandoffCheckpoint(seededTail())!;
			expect(await verifyCheckpointEndpoints(handoff.checkpoint, fixedVerifier('verified'))).to.equal('verified');
		});

		it('lands the handoff at the new tail so a resume spanning the rotation is recoverable', () => {
			const handoff = buildRotationHandoffCheckpoint(seededTail())!;
			const newTail = new PushState({ collectionId: b(1), topicId: b(9), tailIdAtJoin: TAIL_NEW });
			expect(newTail.inheritedCheckpoint).to.equal(undefined);
			applyRotationHandoff(newTail, handoff);
			expect(newTail.inheritedCheckpoint).to.deep.equal(handoff.checkpoint);
			expect(checkpointCovers(newTail.inheritedCheckpoint!, 4)).to.equal(true);
			expect(checkpointCovers(newTail.inheritedCheckpoint!, 2)).to.equal(false);
			expect(checkpointCovers(newTail.inheritedCheckpoint!, 7)).to.equal(false);
		});

		it('adopting a lower handoff never rewinds the inherited span', () => {
			const handoff = buildRotationHandoffCheckpoint(seededTail())!;
			const newTail = new PushState({ collectionId: b(1), topicId: b(9), tailIdAtJoin: TAIL_NEW });
			applyRotationHandoff(newTail, handoff);
			// a stale/older handoff covering a lower toRevision must not replace the current one.
			const older = { ...handoff.checkpoint, toRevision: 4, fromRevision: 3 };
			newTail.adoptRotationCheckpoint(older);
			expect(newTail.inheritedCheckpoint!.toRevision).to.equal(6);
		});

		it('returns undefined when the outgoing tail ring is empty (nothing to migrate)', () => {
			const empty = new PushState({ collectionId: b(1), topicId: b(3), tailIdAtJoin: TAIL_OLD });
			expect(buildRotationHandoffCheckpoint(empty)).to.equal(undefined);
		});
	});
});
