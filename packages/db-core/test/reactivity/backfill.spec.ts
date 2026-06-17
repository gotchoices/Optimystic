import { expect } from 'chai';
import {
	createReplayBuffer,
	createReactivitySubscriber,
	encodeBackfillV1,
	decodeBackfillV1,
	encodeBackfillReplyV1,
	decodeBackfillReplyV1,
	serveBackfill,
	createBackfillRequester,
	type BackfillV1,
	type BackfillReplyV1,
	type NotificationV1,
	type NotificationVerifier,
} from '../../src/reactivity/index.js';
import type { VerifyResult } from '../../src/cohort-topic/membership/verifier.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';
import { CohortWireError } from '../../src/cohort-topic/wire/validate.js';

const COLLECTION = bytesToB64url(new Uint8Array([1, 2, 3, 4]));
const TAIL = bytesToB64url(new Uint8Array([2, 2, 2, 2]));
const SIG = bytesToB64url(new Uint8Array([9, 9]));
const TS = 1_700_000_000_500;

function note(revision: number): NotificationV1 {
	return {
		v: 1,
		collectionId: COLLECTION,
		tailId: TAIL,
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [bytesToB64url(new Uint8Array([8]))],
	};
}

function bufferWith(revs: number[]) {
	const buf = createReplayBuffer(256);
	for (const rev of revs) {
		buf.append({ revision: rev, payload: note(rev), receivedAt: 1000 + rev });
	}
	return buf;
}

class FakeVerifier implements NotificationVerifier {
	constructor(private readonly verdict: VerifyResult = 'verified') {}
	verify(): Promise<VerifyResult> {
		return Promise.resolve(this.verdict);
	}
}

describe('reactivity backfill', () => {
	describe('wire codecs', () => {
		it('round-trips a BackfillV1 request', () => {
			const req: BackfillV1 = { v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, timestamp: TS, signature: SIG };
			expect(decodeBackfillV1(encodeBackfillV1(req))).to.deep.equal(req);
		});

		it('rejects a request missing the timestamp', () => {
			const bad = { v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, signature: SIG };
			expect(() => encodeBackfillV1(bad as BackfillV1)).to.throw(CohortWireError, /timestamp/);
		});

		it('rejects a non-finite timestamp', () => {
			const bad = { v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, timestamp: Number.NaN, signature: SIG };
			expect(() => encodeBackfillV1(bad as BackfillV1)).to.throw(CohortWireError, /timestamp/);
		});

		it('round-trips a BackfillReplyV1 with the available window', () => {
			const reply: BackfillReplyV1 = {
				v: 1,
				entries: [note(11), note(12)],
				available: { fromRevision: 10, toRevision: 15 },
			};
			expect(decodeBackfillReplyV1(encodeBackfillReplyV1(reply))).to.deep.equal(reply);
		});

		it('rejects a request whose toRevision precedes fromRevision', () => {
			const bad = { v: 1, collectionId: COLLECTION, fromRevision: 14, toRevision: 11, timestamp: TS, signature: SIG };
			expect(() => encodeBackfillV1(bad as BackfillV1)).to.throw(CohortWireError, /toRevision/);
		});

		it('rejects a non-base64url collectionId', () => {
			const bad = { v: 1, collectionId: '!!bad!!', fromRevision: 1, toRevision: 2, timestamp: TS, signature: SIG };
			expect(() => encodeBackfillV1(bad as BackfillV1)).to.throw(CohortWireError, /base64url/);
		});
	});

	describe('serveBackfill (intersection with the replay ring)', () => {
		it('returns the full requested range when the ring covers it, reporting the held window', () => {
			const reply = serveBackfill(bufferWith([10, 11, 12, 13, 14, 15]), { v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, timestamp: TS, signature: SIG }, COLLECTION);
			expect(reply.entries.map((e) => e.revision)).to.deep.equal([11, 12, 13, 14]);
			expect(reply.available).to.deep.equal({ fromRevision: 10, toRevision: 15 });
		});

		it('returns only the intersection for a sub-range request that overruns the ring low edge', () => {
			// The subscriber's lag fell past the ring's low edge: it asks [5,12] but the ring only holds [10,15].
			const reply = serveBackfill(bufferWith([10, 11, 12, 13, 14, 15]), { v: 1, collectionId: COLLECTION, fromRevision: 5, toRevision: 12, timestamp: TS, signature: SIG }, COLLECTION);
			expect(reply.entries.map((e) => e.revision)).to.deep.equal([10, 11, 12]);
			// `available.fromRevision` (10) > requested.from (5) tells the subscriber to fall back further.
			expect(reply.available).to.deep.equal({ fromRevision: 10, toRevision: 15 });
		});

		it('returns an empty intersection (and a collapsed available) for an empty ring', () => {
			const reply = serveBackfill(createReplayBuffer(256), { v: 1, collectionId: COLLECTION, fromRevision: 11, toRevision: 14, timestamp: TS, signature: SIG }, COLLECTION);
			expect(reply.entries).to.have.length(0);
			expect(reply.available).to.deep.equal({ fromRevision: 11, toRevision: 11 });
		});

		it('rejects a request for a different collection', () => {
			expect(() => serveBackfill(bufferWith([10, 11]), { v: 1, collectionId: bytesToB64url(new Uint8Array([9])), fromRevision: 10, toRevision: 11, timestamp: TS, signature: SIG }, COLLECTION)).to.throw(CohortWireError, /collectionId/);
		});
	});

	describe('createBackfillRequester (the requestBackfill seam ↔ RPC)', () => {
		it('signs + sends the request, replays the reply through delivery, and closes the gap', async () => {
			const delivered: number[] = [];
			const gaps: Array<[number, number]> = [];
			const sub = createReactivitySubscriber({
				collectionId: COLLECTION,
				verifier: new FakeVerifier('verified'),
				deliver: (n) => delivered.push(n.revision),
				requestBackfill: (from, to) => gaps.push([from, to]),
				lastKnownRev: 10,
			});
			let sentReq: BackfillV1 | undefined;
			const requester = createBackfillRequester({
				collectionId: COLLECTION,
				sign: (req) => bytesToB64url(new Uint8Array([req.fromRevision & 0xff, req.toRevision & 0xff])),
				transport: (req) => {
					sentReq = req;
					return Promise.resolve(serveBackfill(bufferWith([10, 11, 12, 13, 14]), req, COLLECTION));
				},
				subscriber: sub,
				clock: () => TS,
			});

			// A gap arrives (10 → 14): the subscriber records the gap; the requester then replays 11..14.
			expect(await sub.onNotification(note(14))).to.equal('gap');
			expect(gaps).to.deep.equal([[11, 14]]);
			const reply = await requester(...gaps[0]!);
			expect(sentReq?.signature).to.be.a('string');
			expect(sentReq?.timestamp).to.equal(TS); // stamped from the injected clock into the signed image

			expect(reply.entries.map((e) => e.revision)).to.deep.equal([11, 12, 13, 14]);
			expect(delivered).to.deep.equal([11, 12, 13, 14]);
			expect(sub.lastRevision).to.equal(14);
		});

		it('reports an underflow when the held window does not reach the gap low edge', async () => {
			const sub = createReactivitySubscriber({ collectionId: COLLECTION, verifier: new FakeVerifier('verified'), deliver: () => {}, lastKnownRev: 4 });
			const underflows: Array<{ from: number; available: { fromRevision: number; toRevision: number } }> = [];
			const requester = createBackfillRequester({
				collectionId: COLLECTION,
				sign: () => SIG,
				// Ring only holds [10,15]; the subscriber asks from 5 → the reply underflows.
				transport: (req) => Promise.resolve(serveBackfill(bufferWith([10, 11, 12, 13, 14, 15]), req, COLLECTION)),
				subscriber: sub,
				clock: () => TS,
				onUnderflow: (requested, available) => underflows.push({ from: requested.from, available }),
			});
			const reply = await requester(5, 12);
			expect(reply.entries.map((e) => e.revision)).to.deep.equal([10, 11, 12]);
			expect(underflows).to.deep.equal([{ from: 5, available: { fromRevision: 10, toRevision: 15 } }]);
		});

		it('does not replay (or recurse) on underflow when the subscriber seam is wired back to the requester', async () => {
			// Mirror the db-p2p manager wiring: the subscriber's `requestBackfill` seam drives the same
			// requester. On an underflow the held window cannot reach the gap low edge, so replaying the
			// (non-contiguous) entries would re-fire the gap seam and recurse without bound. The requester
			// must escalate via `onUnderflow` and NOT replay.
			const delivered: number[] = [];
			let transportCalls = 0;
			let requester!: (from: number, to: number) => Promise<BackfillReplyV1>;
			const sub = createReactivitySubscriber({
				collectionId: COLLECTION,
				verifier: new FakeVerifier('verified'),
				deliver: (n) => delivered.push(n.revision),
				requestBackfill: (from, to) => { void requester(from, to); },
				lastKnownRev: 4,
			});
			requester = createBackfillRequester({
				collectionId: COLLECTION,
				sign: () => SIG,
				transport: (req) => { transportCalls++; return Promise.resolve(serveBackfill(bufferWith([10, 11, 12, 13, 14, 15]), req, COLLECTION)); },
				subscriber: sub,
				clock: () => TS,
				onUnderflow: () => {},
			});

			// Gap 5 → 12 underflows the ring (low edge 10 > 5): one RPC, no replay, no recursion.
			await requester(5, 12);
			expect(transportCalls).to.equal(1);
			expect(delivered).to.have.length(0);
			expect(sub.lastRevision).to.equal(4);
		});
	});
});
