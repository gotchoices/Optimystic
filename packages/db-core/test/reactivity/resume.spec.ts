import { expect } from 'chai';
import {
	PushState,
	createReactivityForwarder,
	createReactivitySubscriber,
	createNotificationVerifier,
	createStickyCohortHintCache,
	reactivityTopicId,
	encodeResumeV1,
	decodeResumeV1,
	encodeResumeReplyV1,
	decodeResumeReplyV1,
	validateResumeReplyV1,
	classifyResume,
	serveResume,
	applyResumeReply,
	RollingCheckpoint,
	type ResumeV1,
	type ResumeReplyV1,
	type CheckpointSummary,
	type NotificationV1,
	type NotificationVerifier,
} from '../../src/reactivity/index.js';
import type { VerifyResult } from '../../src/cohort-topic/membership/verifier.js';
import { createMembershipVerifier } from '../../src/cohort-topic/membership/verifier.js';
import { createMembershipSourceRouter } from '../../src/cohort-topic/membership/source.js';
import { createCohortSigner } from '../../src/cohort-topic/sig/threshold.js';
import { createTierAddressing } from '../../src/cohort-topic/addressing.js';
import { createRingHash } from '../../src/cohort-topic/ring-hash.js';
import { Tier } from '../../src/cohort-topic/tiers.js';
import { bytesToB64url, b64urlToBytes } from '../../src/cohort-topic/wire/codec.js';
import { CohortWireError } from '../../src/cohort-topic/wire/validate.js';
import type { ICohortThresholdCrypto, IMembershipSource } from '../../src/cohort-topic/ports.js';
import type { MembershipCertV1 } from '../../src/cohort-topic/wire/types.js';

const COLLECTION = bytesToB64url(new Uint8Array([1, 2, 3, 4]));
const TAIL = bytesToB64url(new Uint8Array([2, 2, 2, 2]));
const OTHER_TAIL = bytesToB64url(new Uint8Array([7, 7, 7, 7]));
const COORD = bytesToB64url(new Uint8Array([5, 5]));
const SIG = bytesToB64url(new Uint8Array([9, 9]));
const SIGNER_A = bytesToB64url(new Uint8Array([0xa1, 0xa1]));
const SIGNER_B = bytesToB64url(new Uint8Array([0xb2, 0xb2]));

function note(revision: number, over: Partial<NotificationV1> = {}): NotificationV1 {
	return {
		v: 1,
		collectionId: COLLECTION,
		tailId: TAIL,
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [SIGNER_A, SIGNER_B],
		...over,
	};
}

function resumeReq(fromRevision: number, latestKnownTailId = TAIL): ResumeV1 {
	return { v: 1, collectionId: COLLECTION, fromRevision, latestKnownTailId, subscriberCoord: COORD, timestamp: 1_700_000_000_999, signature: SIG };
}

class FakeVerifier implements NotificationVerifier {
	constructor(private readonly verdict: VerifyResult = 'verified') {}
	verify(): Promise<VerifyResult> {
		return Promise.resolve(this.verdict);
	}
}

/** A verifier whose raw crypto always passes, so the verdict turns purely on the signer-subset check. */
function realishVerifier(members: string[], minSigs: number): NotificationVerifier {
	const crypto: ICohortThresholdCrypto = { assemble: () => Promise.reject(new Error('verify-only')), verify: () => true };
	const empty: IMembershipSource = { current: () => Promise.resolve(undefined), fetch: () => Promise.resolve(undefined) };
	const expectedCoord = createTierAddressing(createRingHash()).coord0(reactivityTopicId(b64urlToBytes(TAIL)));
	const cert: MembershipCertV1 = {
		v: 1,
		cohortCoord: bytesToB64url(expectedCoord),
		cohortEpoch: bytesToB64url(new Uint8Array([7])),
		members,
		stabilizedAt: 1_700_000_000_000,
		thresholdSig: bytesToB64url(new Uint8Array([0])),
		signers: members.slice(0, minSigs),
	};
	const mv = createMembershipVerifier({ signer: createCohortSigner(crypto, minSigs), router: createMembershipSourceRouter({ committed: empty, fret: empty }), minSigs });
	mv.cache(cert);
	return createNotificationVerifier({ verifier: mv, tier: Tier.T3 });
}

/** A PushState fed `1..count` through the forwarder, so eviction populates the rolling checkpoint. */
async function fedState(count: number, w = 4, wCheckpoint = 8): Promise<PushState> {
	const state = new PushState({ collectionId: COLLECTION, topicId: bytesToB64url(new Uint8Array([3])), tailIdAtJoin: TAIL, w, wCheckpoint });
	const fwd = createReactivityForwarder({ state, verifier: new FakeVerifier('verified') });
	for (let rev = 1; rev <= count; rev++) {
		await fwd.receive(note(rev), 1000 + rev);
	}
	return state;
}

const serveDeps = (state: PushState, currentTailId = TAIL) => ({
	buffer: state.replayBuffer,
	checkpoint: state.checkpoint,
	currentTailId,
	currentRevision: state.lastRevision,
	expectedCollectionId: COLLECTION,
});

/** A standalone {@link CheckpointSummary} over `[fromRev, toRev]` — stands in for the new tail's handoff. */
function inheritedSummary(fromRev: number, toRev: number): CheckpointSummary {
	const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: toRev - fromRev + 1 });
	for (let rev = fromRev; rev <= toRev; rev++) cp.retire({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
	return cp.summary()!;
}

describe('reactivity resume — wire codecs', () => {
	it('round-trips a ResumeV1', () => {
		const req = resumeReq(1043);
		expect(decodeResumeV1(encodeResumeV1(req))).to.deep.equal(req);
	});

	it('round-trips each ResumeReplyV1 variant', () => {
		const backfill: ResumeReplyV1 = { v: 1, result: 'backfill', entries: [note(11)], currentRevision: 11 };
		const outOfWindow: ResumeReplyV1 = { v: 1, result: 'out_of_window', currentTailId: TAIL, currentRevision: 99 };
		const rotated: ResumeReplyV1 = { v: 1, result: 'tail_rotated', newTailId: OTHER_TAIL, newRevisionAtRotation: 50 };
		for (const reply of [backfill, outOfWindow, rotated]) {
			expect(decodeResumeReplyV1(encodeResumeReplyV1(reply))).to.deep.equal(reply);
		}
	});

	it('round-trips a checkpoint_window reply carrying a single-link checkpoint chain', () => {
		const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 8 });
		for (let rev = 9; rev <= 16; rev++) cp.retire({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
		const reply: ResumeReplyV1 = { v: 1, result: 'checkpoint_window', checkpoints: [cp.summary()!], recentEntries: [note(17), note(18)], currentRevision: 18 };
		expect(decodeResumeReplyV1(encodeResumeReplyV1(reply))).to.deep.equal(reply);
	});

	it('round-trips a checkpoint_window reply carrying a two-link (bridge) checkpoint chain', () => {
		const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 8 });
		for (let rev = 9; rev <= 16; rev++) cp.retire({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
		const reply: ResumeReplyV1 = { v: 1, result: 'checkpoint_window', checkpoints: [inheritedSummary(1, 8), cp.summary()!], recentEntries: [note(17), note(18)], currentRevision: 18 };
		expect(decodeResumeReplyV1(encodeResumeReplyV1(reply))).to.deep.equal(reply);
	});

	it('rejects an empty checkpoint chain', () => {
		expect(() => validateResumeReplyV1({ v: 1, result: 'checkpoint_window', checkpoints: [], recentEntries: [] })).to.throw(CohortWireError, /non-empty/);
	});

	it('rejects a non-contiguous checkpoint chain (gap / overlap / misorder)', () => {
		const gapped = { v: 1, result: 'checkpoint_window', checkpoints: [inheritedSummary(1, 8), inheritedSummary(10, 16)], recentEntries: [] };
		expect(() => validateResumeReplyV1(gapped), 'gap [9] between links').to.throw(CohortWireError, /contiguous/);
		const overlapping = { v: 1, result: 'checkpoint_window', checkpoints: [inheritedSummary(1, 9), inheritedSummary(9, 16)], recentEntries: [] };
		expect(() => validateResumeReplyV1(overlapping), 'overlap at 9').to.throw(CohortWireError, /contiguous/);
		const misordered = { v: 1, result: 'checkpoint_window', checkpoints: [inheritedSummary(9, 16), inheritedSummary(1, 8)], recentEntries: [] };
		expect(() => validateResumeReplyV1(misordered), 'high link before low link').to.throw(CohortWireError, /contiguous/);
	});

	it('rejects a mixed-collectionId checkpoint chain', () => {
		const foreign = { ...inheritedSummary(9, 16), collectionId: bytesToB64url(new Uint8Array([9, 9])) };
		const mixed = { v: 1, result: 'checkpoint_window', checkpoints: [inheritedSummary(1, 8), foreign], recentEntries: [] };
		expect(() => validateResumeReplyV1(mixed)).to.throw(CohortWireError, /collectionId/);
	});

	it('rejects an unknown result discriminant', () => {
		expect(() => validateResumeReplyV1({ v: 1, result: 'nope' })).to.throw(CohortWireError, /result/);
	});

	it('rejects a backfill reply missing its currentRevision', () => {
		expect(() => validateResumeReplyV1({ v: 1, result: 'backfill', entries: [] })).to.throw(CohortWireError, /currentRevision/);
	});
});

describe('reactivity resume — classification + serving (stacked windows)', () => {
	it('classifies lag < W as Backfill and serves the ring slice in one reply', async () => {
		const state = await fedState(20); // ring [17,18,19,20], checkpoint [9,16]
		const req = resumeReq(18);
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL)).to.equal('backfill');
		const reply = serveResume(req, serveDeps(state));
		expect(reply.result).to.equal('backfill');
		expect(reply.entries!.map((e) => e.revision)).to.deep.equal([18, 19, 20]);
		expect(reply.currentRevision).to.equal(20);
	});

	it('classifies W ≤ lag < W + W_checkpoint as CheckpointWindow (checkpoint + recent entries)', async () => {
		const state = await fedState(20);
		const req = resumeReq(12); // 12 is below ringLow 17 but inside checkpoint [9,16]
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL)).to.equal('checkpoint_window');
		const reply = serveResume(req, serveDeps(state));
		expect(reply.result).to.equal('checkpoint_window');
		expect(reply.checkpoints).to.have.length(1); // steady state: a single rolling-checkpoint link
		expect(reply.checkpoints![0]!.fromRevision).to.equal(9);
		expect(reply.checkpoints![0]!.toRevision).to.equal(16);
		expect(reply.recentEntries!.map((e) => e.revision)).to.deep.equal([17, 18, 19, 20]);
	});

	it('classifies lag ≥ W + W_checkpoint as OutOfWindow (chain-read fallback)', async () => {
		const state = await fedState(20);
		const req = resumeReq(5); // below the checkpoint's low edge (9)
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL)).to.equal('out_of_window');
		const reply = serveResume(req, serveDeps(state));
		expect(reply.result).to.equal('out_of_window');
		expect(reply.currentTailId).to.equal(TAIL);
		expect(reply.currentRevision).to.equal(20);
	});

	it('classifies a stale latestKnownTailId as TailRotated before any lag check', async () => {
		const state = await fedState(20);
		const req = resumeReq(18, OTHER_TAIL); // within the ring by lag, but the tail moved
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL)).to.equal('tail_rotated');
		const reply = serveResume(req, { ...serveDeps(state), rotationRevision: 16 });
		expect(reply.result).to.equal('tail_rotated');
		expect(reply.newTailId).to.equal(TAIL);
		expect(reply.newRevisionAtRotation).to.equal(16);
	});

	it('rejects a resume for a different collection', async () => {
		const state = await fedState(20);
		expect(() => serveResume({ ...resumeReq(18), collectionId: bytesToB64url(new Uint8Array([9])) }, serveDeps(state))).to.throw(CohortWireError, /collectionId/);
	});
});

describe('reactivity resume — inherited (cross-rotation) checkpoint', () => {
	it('classifies + serves a resume below the rolling window from the inherited checkpoint (gap-free)', async () => {
		const state = await fedState(20); // ring [17,18,19,20], rolling checkpoint [9,16]
		// Right after a rotation the new tail's ring still holds every revision since the handoff, so the
		// inherited window abuts the ring's low edge (toRevision 16 == ringLow 17 − 1). serveResume then emits a
		// contiguous `inherited summary + ring` reply.
		const inherited = inheritedSummary(1, 16);
		const req = resumeReq(5); // below ringLow (17) and the rolling checkpoint low (9), but inside [1,16]
		// Without the inherited checkpoint this is out_of_window; with it, the new tail answers from the handoff.
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL)).to.equal('out_of_window');
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL, inherited)).to.equal('checkpoint_window');
		const reply = serveResume(req, { ...serveDeps(state), inheritedCheckpoint: inherited });
		expect(reply.result).to.equal('checkpoint_window');
		expect(reply.checkpoints).to.have.length(1); // inherited abuts the ring directly (no bridge needed)
		expect(reply.checkpoints![0]!.fromRevision).to.equal(1);
		expect(reply.checkpoints![0]!.toRevision).to.equal(16);
		// Same shape as the rolling-checkpoint branch: the inherited summary + the live ring's recent entries.
		expect(reply.recentEntries!.map((e) => e.revision)).to.deep.equal([17, 18, 19, 20]);
		expect(reply.currentRevision).to.equal(20);
	});

	it('subscriber applies a gap-free inherited reply contiguously (no skipped revisions)', async () => {
		// The end-to-end proof the serve shape is actually recoverable: a subscriber at the inherited window's
		// low edge applies the reply and ends up current with nothing skipped.
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const delivered: number[] = [];
		const digests: CheckpointSummary[] = [];
		const state = await fedState(20);
		const inherited = inheritedSummary(1, 16);
		const reply = serveResume(resumeReq(5), { ...serveDeps(state), inheritedCheckpoint: inherited });
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier, deliver: (n) => delivered.push(n.revision), lastKnownRev: 4 });
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier, onCheckpointDigest: (s) => digests.push(s) });
		expect(outcome).to.equal('checkpoint_applied');
		expect(digests[0]!.toRevision).to.equal(16);
		expect(delivered).to.deep.equal([17, 18, 19, 20]); // contiguous after rebaseline to 16 — nothing skipped
		expect(sub.lastRevision).to.equal(20);
	});

	it('bridges the inherited + rolling windows in one reply when the new tail rolling checkpoint sits between them', async () => {
		const state = await fedState(20); // ring [17,18,19,20], new tail's own rolling checkpoint [9,16]
		// The handoff [1,8] abuts the rolling checkpoint [9,16] (8 + 1 == 9), which abuts the ring (16 == 17 − 1):
		// the three windows stack inherited → rolling → ring with no gap. The reply carries the ordered two-link
		// chain [[1,8],[9,16]] so the full cross-rotation span recovers in one round trip (the gap this ticket
		// exists to close — previously this fell to out_of_window).
		const inherited = inheritedSummary(1, 8);
		const req = resumeReq(5); // inside the inherited window [1,8], below the rolling checkpoint and the ring
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL, inherited)).to.equal('checkpoint_window');
		const reply = serveResume(req, { ...serveDeps(state), inheritedCheckpoint: inherited });
		expect(reply.result).to.equal('checkpoint_window');
		expect(reply.checkpoints!.map((c) => [c.fromRevision, c.toRevision])).to.deep.equal([[1, 8], [9, 16]]);
		expect(reply.recentEntries!.map((e) => e.revision)).to.deep.equal([17, 18, 19, 20]);
		expect(reply.currentRevision).to.equal(20);
	});

	it('falls to out_of_window for an unbridgeable gap (inherited high edge below the rolling low edge)', async () => {
		const state = await fedState(20); // ring [17,18,19,20], rolling checkpoint [9,16]
		// A handoff [1,6] whose high edge (6) is two revisions below the rolling checkpoint's low edge (9): the
		// new tail evicted past the handoff seam, so [7,8] is summarized by neither window — the inherited window
		// is legitimately > W + W_checkpoint behind. No gap-free chain exists, so the classifier declines (an
		// honest chain read) rather than emit a reply that skips [7,8].
		const inherited = inheritedSummary(1, 6);
		const req = resumeReq(5);
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL, inherited)).to.equal('out_of_window');
		const reply = serveResume(req, { ...serveDeps(state), inheritedCheckpoint: inherited });
		expect(reply.result).to.equal('out_of_window');
		expect(reply.currentTailId).to.equal(TAIL);
		expect(reply.currentRevision).to.equal(20);
	});

	it('serves each bridge link with its own original mergedDigest (no re-fold; a non-composable override fold composes)', async () => {
		// Fold composability is a non-issue under the chain design: each link keeps its already-correct merged
		// digest and is applied independently, so nothing is ever re-folded across windows. Prove it with a
		// deliberately non-composable override fold (its output is not a seedable running accumulator) on the
		// new tail's rolling checkpoint, and a default-fold inherited summary.
		const weirdFold = (digests: readonly Uint8Array[]): Uint8Array => new Uint8Array([digests.length & 0xff, 0xee]);
		const rolling = new RollingCheckpoint({ collectionId: COLLECTION, span: 8, fold: weirdFold });
		for (let rev = 9; rev <= 16; rev++) rolling.retire({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
		const inherited = inheritedSummary(1, 8); // default fold
		const state = await fedState(20); // borrow its ring [17..20]
		const deps = { buffer: state.replayBuffer, checkpoint: rolling, inheritedCheckpoint: inherited, currentTailId: TAIL, currentRevision: 20, expectedCollectionId: COLLECTION };
		const reply = serveResume(resumeReq(5), deps);
		expect(reply.result).to.equal('checkpoint_window');
		expect(reply.checkpoints!.map((c) => [c.fromRevision, c.toRevision])).to.deep.equal([[1, 8], [9, 16]]);
		// Each link carries its own digest unchanged — nothing was re-folded across the seam.
		expect(reply.checkpoints![0]!.mergedDigest).to.equal(inherited.mergedDigest);
		expect(reply.checkpoints![1]!.mergedDigest).to.equal(rolling.summary()!.mergedDigest);
		// End-to-end apply still succeeds (the digest is a hint; the endpoints verify).
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const delivered: number[] = [];
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier, deliver: (n) => delivered.push(n.revision), lastKnownRev: 4 });
		expect(await applyResumeReply(reply, { subscriber: sub, verifier })).to.equal('checkpoint_applied');
		expect(delivered).to.deep.equal([17, 18, 19, 20]);
		expect(sub.lastRevision).to.equal(20);
	});

	it('prefers the rolling checkpoint when both it and the inherited one cover fromRevision', async () => {
		const state = await fedState(20); // rolling checkpoint [9,16]
		const inherited = inheritedSummary(1, 16); // overlaps the rolling window from below
		const req = resumeReq(12); // 12 sits inside both windows → rolling wins (the fresher, narrower window)
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL, inherited)).to.equal('checkpoint_window');
		const reply = serveResume(req, { ...serveDeps(state), inheritedCheckpoint: inherited });
		expect(reply.checkpoints).to.have.length(1); // a single rolling link — no bridge when rolling covers it
		expect(reply.checkpoints![0]!.fromRevision).to.equal(9); // rolling, not the inherited low edge (1)
		expect(reply.checkpoints![0]!.toRevision).to.equal(16);
		// A resume at exactly the rolling checkpoint's low edge still classifies rolling, not inherited.
		const lowEdge = serveResume(resumeReq(9), { ...serveDeps(state), inheritedCheckpoint: inherited });
		expect(lowEdge.checkpoints![0]!.fromRevision).to.equal(9);
	});

	it('prefers the ring (backfill) over an inherited checkpoint when fromRevision is above the ring low', async () => {
		const state = await fedState(20); // ring [17,18,19,20]
		const inherited = inheritedSummary(1, 16);
		const req = resumeReq(18); // inside the ring → backfill regardless of the inherited window
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL, inherited)).to.equal('backfill');
	});

	it('is unchanged (out_of_window) when no inherited checkpoint is supplied', async () => {
		const state = await fedState(20);
		const req = resumeReq(5);
		expect(classifyResume(req, state.replayBuffer, state.checkpoint, TAIL, undefined)).to.equal('out_of_window');
		const reply = serveResume(req, serveDeps(state)); // serveDeps carries no inheritedCheckpoint
		expect(reply.result).to.equal('out_of_window');
		expect(reply.currentTailId).to.equal(TAIL);
		expect(reply.currentRevision).to.equal(20);
	});

	it('subscriber-side: a non-abutting inherited checkpoint reply is still rejected (chain-reads)', async () => {
		// The serve picks the inherited branch on checkpointCovers (inclusive span), blind to the subscriber's
		// contiguity head. The subscriber's existing guard must still fire for an inherited summary: a low edge
		// above `lastRevision + 1` leaves an un-summarized gap, so the reply must not advance state.
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const delivered: number[] = [];
		const chainReads: Array<[string | undefined, number | undefined]> = [];
		const inherited = inheritedSummary(100, 116); // endpoints verify, but low edge 100 ≫ head 11 + 1
		const reply: ResumeReplyV1 = { v: 1, result: 'checkpoint_window', checkpoints: [inherited], recentEntries: [note(117)], currentRevision: 117 };
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier, deliver: (n) => delivered.push(n.revision), lastKnownRev: 11 });
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier, onChainRead: (t, r) => chainReads.push([t, r]) });
		expect(outcome).to.equal('checkpoint_untrusted');
		expect(chainReads).to.have.length(1);
		expect(delivered).to.have.length(0); // never advanced past the gap
		expect(sub.lastRevision).to.equal(11);
	});
});

describe('reactivity resume — subscriber-side apply', () => {
	it('backfill: replays the entries through the delivery path', async () => {
		const delivered: number[] = [];
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier: new FakeVerifier('verified'), deliver: (n) => delivered.push(n.revision), lastKnownRev: 17 });
		const reply: ResumeReplyV1 = { v: 1, result: 'backfill', entries: [note(18), note(19), note(20)], currentRevision: 20 };
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier: new FakeVerifier('verified') });
		expect(outcome).to.equal('backfilled');
		expect(delivered).to.deep.equal([18, 19, 20]);
		expect(sub.lastRevision).to.equal(20);
	});

	it('checkpoint_window: verifies endpoints, applies the digest, rebaselines, replays recent (deduping)', async () => {
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const delivered: number[] = [];
		const digests: CheckpointSummary[] = [];
		// Subscriber sits at 11 (inside the checkpoint's range); a real PushState gives the reply.
		const state = await fedState(20);
		const reply = serveResume(resumeReq(12), serveDeps(state));
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier, deliver: (n) => delivered.push(n.revision), lastKnownRev: 11 });
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier, onCheckpointDigest: (s) => digests.push(s) });
		expect(outcome).to.equal('checkpoint_applied');
		expect(digests).to.have.length(1);
		expect(digests[0]!.toRevision).to.equal(16);
		// The digest covered 12..16; recent entries 17..20 replayed contiguously after the rebaseline to 16.
		expect(delivered).to.deep.equal([17, 18, 19, 20]);
		expect(sub.lastRevision).to.equal(20);
	});

	it('checkpoint_window: dedupes recent entries at/below the rebaselined head', async () => {
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const delivered: number[] = [];
		const cp = new RollingCheckpoint({ collectionId: COLLECTION, span: 8 });
		for (let rev = 9; rev <= 16; rev++) cp.retire({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
		// recentEntries deliberately includes 16 (== toRevision) and 15 (< toRevision) which must dedupe.
		const reply: ResumeReplyV1 = { v: 1, result: 'checkpoint_window', checkpoints: [cp.summary()!], recentEntries: [note(15), note(16), note(17), note(18)], currentRevision: 18 };
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier, deliver: (n) => delivered.push(n.revision), lastKnownRev: 11 });
		await applyResumeReply(reply, { subscriber: sub, verifier });
		expect(delivered).to.deep.equal([17, 18]); // 15 and 16 dedupe against the rebaselined head (16)
		expect(sub.lastRevision).to.equal(18);
	});

	it('checkpoint_window: a forged endpoint is not applied — falls back to a chain read', async () => {
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const delivered: number[] = [];
		const chainReads: Array<[string | undefined, number | undefined]> = [];
		const forgedTo = note(16, { signers: [bytesToB64url(new Uint8Array([0xde, 0xad])), bytesToB64url(new Uint8Array([0xbe, 0xef]))] });
		const summary: CheckpointSummary = { collectionId: COLLECTION, fromRevision: 9, toRevision: 16, mergedDigest: bytesToB64url(new Uint8Array([1])), bracketingEntries: [note(9), forgedTo] };
		const reply: ResumeReplyV1 = { v: 1, result: 'checkpoint_window', checkpoints: [summary], recentEntries: [note(17)], currentRevision: 17 };
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier, deliver: (n) => delivered.push(n.revision), lastKnownRev: 11 });
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier, onChainRead: (t, r) => chainReads.push([t, r]) });
		expect(outcome).to.equal('checkpoint_untrusted');
		expect(chainReads).to.have.length(1);
		expect(delivered).to.have.length(0); // a forged checkpoint never advances state
		expect(sub.lastRevision).to.equal(11);
	});

	it('checkpoint_window: a verified-but-non-abutting checkpoint is not applied — chain-reads instead of skipping revisions', async () => {
		// Endpoints verify (real committed revisions), but the checkpoint's low edge (100) sits far above the
		// subscriber's head (last = 11). Rebaselining to 116 would silently skip 12..99. The guard must
		// reject it and chain-read rather than advance the contiguity head past un-summarized revisions.
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const delivered: number[] = [];
		const chainReads: Array<[string | undefined, number | undefined]> = [];
		const summary: CheckpointSummary = { collectionId: COLLECTION, fromRevision: 100, toRevision: 116, mergedDigest: bytesToB64url(new Uint8Array([1])), bracketingEntries: [note(100), note(116)] };
		const reply: ResumeReplyV1 = { v: 1, result: 'checkpoint_window', checkpoints: [summary], recentEntries: [note(117)], currentRevision: 117 };
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier, deliver: (n) => delivered.push(n.revision), lastKnownRev: 11 });
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier, onChainRead: (t, r) => chainReads.push([t, r]) });
		expect(outcome).to.equal('checkpoint_untrusted');
		expect(chainReads).to.have.length(1);
		expect(delivered).to.have.length(0); // never advanced past the gap
		expect(sub.lastRevision).to.equal(11);
	});

	it('checkpoint_window (bridge): applies both links in order, lands current, nothing skipped', async () => {
		// The gap this ticket exists to close, end-to-end: a two-link [inherited, rolling] chain + the ring.
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const delivered: number[] = [];
		const digests: CheckpointSummary[] = [];
		const state = await fedState(20); // ring [17..20], rolling checkpoint [9,16]
		const inherited = inheritedSummary(1, 8); // the handoff, abutting the rolling checkpoint
		// Subscriber head at 4 (inside the inherited window's reach): the chain's low edge (1) abuts.
		const reply = serveResume(resumeReq(5), { ...serveDeps(state), inheritedCheckpoint: inherited });
		expect(reply.checkpoints).to.have.length(2); // sanity: the serve really built the bridge
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier, deliver: (n) => delivered.push(n.revision), lastKnownRev: 4 });
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier, onCheckpointDigest: (s) => digests.push(s) });
		expect(outcome).to.equal('checkpoint_applied');
		expect(digests.map((d) => [d.fromRevision, d.toRevision]), 'onCheckpointDigest fires once per link, in order').to.deep.equal([[1, 8], [9, 16]]);
		expect(delivered).to.deep.equal([17, 18, 19, 20]); // contiguous after rebaselining through both links — nothing skipped
		expect(sub.lastRevision).to.equal(20);
	});

	it('checkpoint_window (bridge): a forged endpoint in the SECOND link rejects the whole reply (no partial advance)', async () => {
		// verify-all-before-apply: a single forged link kills the entire reply — nothing is delivered and
		// lastRevision is unchanged (in particular, no partial advance to the first link's toRevision 8).
		const verifier = realishVerifier([SIGNER_A, SIGNER_B], 2);
		const delivered: number[] = [];
		const chainReads: Array<[string | undefined, number | undefined]> = [];
		const inherited = inheritedSummary(1, 8); // first link verifies
		const forgedTo = note(16, { signers: [bytesToB64url(new Uint8Array([0xde, 0xad])), bytesToB64url(new Uint8Array([0xbe, 0xef]))] });
		const forgedRolling: CheckpointSummary = { collectionId: COLLECTION, fromRevision: 9, toRevision: 16, mergedDigest: bytesToB64url(new Uint8Array([1])), bracketingEntries: [note(9), forgedTo] };
		const reply: ResumeReplyV1 = { v: 1, result: 'checkpoint_window', checkpoints: [inherited, forgedRolling], recentEntries: [note(17), note(18), note(19), note(20)], currentRevision: 20 };
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier, deliver: (n) => delivered.push(n.revision), lastKnownRev: 4 });
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier, onChainRead: (t, r) => chainReads.push([t, r]) });
		expect(outcome).to.equal('checkpoint_untrusted');
		expect(chainReads).to.have.length(1);
		expect(delivered).to.have.length(0); // nothing delivered
		expect(sub.lastRevision, 'no partial advance to the first link toRevision (8)').to.equal(4);
	});

	it('out_of_window: escalates to a chain read', async () => {
		const chainReads: Array<[string | undefined, number | undefined]> = [];
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier: new FakeVerifier('verified'), deliver: () => {}, lastKnownRev: 1 });
		const reply: ResumeReplyV1 = { v: 1, result: 'out_of_window', currentTailId: TAIL, currentRevision: 5000 };
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier: new FakeVerifier('verified'), onChainRead: (t, r) => chainReads.push([t, r]) });
		expect(outcome).to.equal('out_of_window');
		expect(chainReads).to.deep.equal([[TAIL, 5000]]);
	});

	it('tail_rotated: escalates to re-registration', async () => {
		const rotations: Array<[string, number]> = [];
		const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier: new FakeVerifier('verified'), deliver: () => {}, lastKnownRev: 1 });
		const reply: ResumeReplyV1 = { v: 1, result: 'tail_rotated', newTailId: OTHER_TAIL, newRevisionAtRotation: 42 };
		const outcome = await applyResumeReply(reply, { subscriber: sub, verifier: new FakeVerifier('verified'), onTailRotated: (t, r) => rotations.push([t, r]) });
		expect(outcome).to.equal('tail_rotated');
		expect(rotations).to.deep.equal([[OTHER_TAIL, 42]]);
	});
});

describe('reactivity resume — sticky cohort-hint cache (one-RT after a flap)', () => {
	it('caches a hint across reads and drops it only on explicit invalidation', () => {
		const cache = createStickyCohortHintCache();
		expect(cache.get(COLLECTION)).to.equal(undefined);
		const hint = { topicId: bytesToB64url(new Uint8Array([3])), primary: bytesToB64url(new Uint8Array([4])), cohortHint: [SIGNER_A, SIGNER_B] };
		cache.set(COLLECTION, hint);
		expect(cache.get(COLLECTION)).to.deep.equal(hint); // survives reconnects (sticky)
		expect(cache.get(COLLECTION)).to.deep.equal(hint);
		cache.invalidate(COLLECTION);
		expect(cache.get(COLLECTION)).to.equal(undefined);
	});
});
