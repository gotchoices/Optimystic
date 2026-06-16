import { expect } from 'chai';
import {
	BoundedQueue,
	SubscriberBackpressure,
	createSubscriberBackpressure,
	QUEUE_MAX_DEFAULT,
	type NotificationV1,
} from '../../src/reactivity/index.js';
import { bytesToB64url } from '../../src/cohort-topic/wire/codec.js';

const b = (n: number): string => bytesToB64url(new Uint8Array([n]));

function note(revision: number): NotificationV1 {
	return {
		v: 1,
		collectionId: b(1),
		tailId: b(2),
		revision,
		digest: bytesToB64url(new Uint8Array([revision & 0xff])),
		timestamp: 1_700_000_000_000 + revision,
		sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
		signers: [b(8)],
	};
}

describe('reactivity backpressure', () => {
	describe('BoundedQueue (drop-oldest)', () => {
		it('accepts up to capacity without dropping', () => {
			const q = new BoundedQueue(3);
			expect(q.enqueue(note(1)).droppedOldest).to.equal(false);
			expect(q.enqueue(note(2)).droppedOldest).to.equal(false);
			const r = q.enqueue(note(3));
			expect(r.droppedOldest).to.equal(false);
			expect(r.depth).to.equal(3);
			expect(q.full).to.equal(true);
			expect(q.dropped).to.equal(0);
		});

		it('drops the OLDEST entry on overflow and increments the counter', () => {
			const q = new BoundedQueue(3);
			for (let rev = 1; rev <= 3; rev++) q.enqueue(note(rev));
			const r = q.enqueue(note(4)); // overflow: revision 1 (oldest) is evicted
			expect(r.droppedOldest).to.equal(true);
			expect(r.evicted?.revision).to.equal(1);
			expect(r.depth).to.equal(3);
			expect(q.dropped).to.equal(1);
			// The queue now holds the freshest revisions 2,3,4 — a slow subscriber keeps the head, not the tail.
			expect(q.pending().map((n) => n.revision)).to.deep.equal([2, 3, 4]);
		});

		it('counts every drop monotonically across sustained overflow', () => {
			const q = new BoundedQueue(2);
			for (let rev = 1; rev <= 10; rev++) q.enqueue(note(rev));
			expect(q.dropped).to.equal(8); // 10 enqueued, capacity 2 → 8 evictions
			expect(q.pending().map((n) => n.revision)).to.deep.equal([9, 10]);
		});

		it('drains FIFO and dequeues oldest-first', () => {
			const q = new BoundedQueue(4);
			for (let rev = 5; rev <= 8; rev++) q.enqueue(note(rev));
			expect(q.peek()?.revision).to.equal(5);
			expect(q.dequeue()?.revision).to.equal(5);
			expect(q.drain().map((n) => n.revision)).to.deep.equal([6, 7, 8]);
			expect(q.size).to.equal(0);
		});

		it('defaults to queue_max and rejects a non-positive capacity', () => {
			expect(new BoundedQueue().capacity).to.equal(QUEUE_MAX_DEFAULT);
			expect(() => new BoundedQueue(0)).to.throw(RangeError);
			expect(() => new BoundedQueue(2.5)).to.throw(RangeError);
		});
	});

	describe('SubscriberBackpressure (per-subscriber isolation)', () => {
		it('isolates a slow subscriber: it drops while fast subscribers stay contiguous', () => {
			// capacity 4 per subscriber. "fast" is drained every revision; "slow" never drains.
			const bp = createSubscriberBackpressure(4);
			const fast = b(10);
			const slow = b(20);
			const fastDelivered: number[] = [];

			for (let rev = 1; rev <= 12; rev++) {
				const drops = bp.fanOut([fast, slow], note(rev));
				// the fast subscriber consumes immediately (no backlog) — it never drops.
				const fq = bp.queue(fast);
				while (fq.size > 0) fastDelivered.push(fq.dequeue()!.revision);
				// any drop reported is the slow subscriber's, never the fast one's.
				expect(drops.every((d) => d.subscriberId === slow)).to.equal(true);
			}

			// Fast subscriber saw every revision contiguously — its slow peer never stalled its fan-out.
			expect(fastDelivered).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
			// Slow subscriber's queue dropped the oldest revisions (8 of 12) and kept only the freshest 4.
			const sq = bp.queue(slow);
			expect(sq.dropped).to.equal(8);
			expect(sq.pending().map((n) => n.revision)).to.deep.equal([9, 10, 11, 12]);
			// The gap the slow subscriber will detect (its head jumped from <=8 to 9) is what triggers backfill.
		});

		it('lazily creates one queue per subscriber and tracks total drops', () => {
			const bp = new SubscriberBackpressure(2);
			expect(bp.subscriberCount).to.equal(0);
			bp.enqueue(b(1), note(1));
			bp.enqueue(b(2), note(1));
			expect(bp.subscriberCount).to.equal(2);
			for (let rev = 2; rev <= 5; rev++) bp.enqueue(b(1), note(rev)); // overflow subscriber 1 only
			expect(bp.peekQueue(b(1))!.dropped).to.equal(3);
			expect(bp.peekQueue(b(2))!.dropped).to.equal(0);
			expect(bp.totalDropped()).to.equal(3);
		});

		it('reclaims a departed subscriber\'s queue', () => {
			const bp = new SubscriberBackpressure(2);
			bp.enqueue(b(1), note(1));
			expect(bp.peekQueue(b(1))).to.not.equal(undefined);
			bp.remove(b(1));
			expect(bp.peekQueue(b(1))).to.equal(undefined);
			expect(bp.subscriberCount).to.equal(0);
		});
	});
});
