import { expect } from 'chai'
import { processBatches, retryWaitMs, type CoordinatorBatch, type RetryBackoff } from '../src/utility/batch-coordinator.js'
import type { BlockId, PeerId } from '../src/index.js'

/** Minimal stub PeerId that satisfies equality/toString comparisons used in processBatches. */
function makePeerId(id: string): PeerId {
	return { toString: () => id, equals: (o: any) => o?.toString?.() === id } as unknown as PeerId;
}

describe('batch-coordinator.processBatches (solo-node error preservation)', () => {
	it('preserves original first-attempt batch error even when retry findCoordinator throws', async () => {
		const selfId = makePeerId('self-peer');
		const blockId = 'solo-block' as BlockId;

		const batches: CoordinatorBatch<string, void>[] = [
			{ peerId: selfId, blockId, payload: 'payload', excludedPeers: [] }
		];

		const originalErr = new Error('FIRST_ATTEMPT_FAILURE: pend timed out waiting for restoration');
		const retryErr = Object.assign(
			new Error('Self-coordination exhausted on solo/bootstrap node (self already attempted).'),
			{ code: 'SELF_COORDINATION_EXHAUSTED' }
		);

		let processCalls = 0;
		let findCoordinatorCalls = 0;

		await processBatches<string, void>(
			batches,
			async () => { processCalls++; throw originalErr; },
			() => [blockId],
			(payload) => payload,
			Date.now() + 5000,
			async (_bid, _opts) => {
				findCoordinatorCalls++;
				// Simulate solo-bootstrap: self now excluded → retry-exhausted.
				throw retryErr;
			}
		);

		// Process was attempted once; findCoordinator was consulted for retry.
		expect(processCalls).to.equal(1);
		expect(findCoordinatorCalls).to.equal(1);

		// batch.request must preserve the original error — NOT the retry-exhausted error.
		const batch = batches[0]!;
		expect(batch.request).to.exist;
		expect(batch.request!.isError).to.be.true;
		expect(batch.request!.error).to.equal(originalErr);
		expect((batch.request!.error as Error).message).to.include('FIRST_ATTEMPT_FAILURE');
	});

	it('propagates original error when retry path produces a successful new batch', async () => {
		const selfId = makePeerId('self-peer');
		const otherId = makePeerId('other-peer');
		const blockId = 'b1' as BlockId;

		const batches: CoordinatorBatch<string, string>[] = [
			{ peerId: selfId, blockId, payload: 'p', excludedPeers: [] }
		];

		const originalErr = new Error('first-failure');
		let callsFor: string[] = [];

		await processBatches<string, string>(
			batches,
			async (b) => {
				callsFor.push(b.peerId.toString());
				if (b.peerId.toString() === 'self-peer') throw originalErr;
				return 'ok';
			},
			() => [blockId],
			(payload) => payload,
			Date.now() + 5000,
			async (_bid, opts) => {
				// On retry, hand back a different peer so retries work
				const excluded = new Set(opts.excludedPeers.map(p => p.toString()));
				if (excluded.has('self-peer')) return otherId;
				return selfId;
			}
		);

		// Original batch carries original error
		expect(batches[0]!.request!.error).to.equal(originalErr);
		// Retry batch(es) attached via subsumedBy should have succeeded
		const retries = batches[0]!.subsumedBy ?? [];
		expect(retries.length).to.be.greaterThan(0);
		expect(retries[0]!.request?.response).to.equal('ok');
	});
});

// Ticket coordinator-and-read-retries-back-off: a retry waits one declared round trip, doubling per
// further coordinator, and at least as long as the failed request was outstanding when it goes out
// through this node's own queue to the failed peer.
describe('batch-coordinator.retryWaitMs', () => {
	const failed = makePeerId('failed-peer');
	const local = makePeerId('local-peer');
	const third = makePeerId('third-peer');
	const cases: { name: string; backoff: RetryBackoff; attempt: number; retryPeers: PeerId[]; expected: number }[] = [
		{ name: 'a zero base waits nothing, floor or not', backoff: { baseMs: 0, localPeerId: local }, attempt: 2, retryPeers: [failed], expected: 0 },
		{ name: 'the first retry waits the base', backoff: { baseMs: 100 }, attempt: 1, retryPeers: [third], expected: 100 },
		{ name: 'the third coordinator tried waits four bases', backoff: { baseMs: 100 }, attempt: 3, retryPeers: [third], expected: 400 },
		{ name: 'a re-pick of the failed peer waits as long as it was outstanding', backoff: { baseMs: 100 }, attempt: 1, retryPeers: [failed], expected: 750 },
		{ name: 'a retry this node coordinates waits as long as it was outstanding', backoff: { baseMs: 100, localPeerId: local }, attempt: 1, retryPeers: [third, local], expected: 750 },
		{ name: 'a retry to a third peer takes no floor', backoff: { baseMs: 100, localPeerId: local }, attempt: 1, retryPeers: [third], expected: 100 },
	];
	for (const c of cases) {
		it(c.name, () => {
			expect(retryWaitMs(c.backoff, { attempt: c.attempt, failedPeer: failed, outstandingMs: 750, retryPeers: c.retryPeers })).to.equal(c.expected);
		});
	}
});

describe('batch-coordinator.processBatches (retry backoff)', () => {
	const first = makePeerId('first-peer');
	const second = makePeerId('second-peer');
	const blockId = 'b1' as BlockId;
	const firstErr = new Error('first-attempt-timeout');

	/** One batch to `first`, which throws; the retry goes to `second`, which answers. Records the sleeps and the sends in order. */
	async function runWithRetry(baseMs: number, budgetMs: number) {
		const events: string[] = [];
		const backoff: RetryBackoff = { baseMs, sleep: async ms => { events.push(`sleep:${ms}`); } };
		const batches: CoordinatorBatch<string, string>[] = [{ peerId: first, blockId, payload: 'p', excludedPeers: [] }];
		await processBatches<string, string>(
			batches,
			async b => {
				events.push(`process:${b.peerId.toString()}`);
				if (b.peerId.toString() === 'first-peer') throw firstErr;
				return 'ok';
			},
			() => [blockId],
			payload => payload,
			Date.now() + budgetMs,
			async (_bid, opts) => opts.excludedPeers.some(p => p.toString() === 'first-peer') ? second : first,
			backoff
		);
		return { events, batch: batches[0]! };
	}

	it('a zero base never sleeps and still sends the retry', async () => {
		const { events } = await runWithRetry(0, 5000);
		expect(events).to.deep.equal(['process:first-peer', 'process:second-peer']);
	});

	it('a positive base sleeps that long before the second coordinator is asked', async () => {
		const { events } = await runWithRetry(200, 5000);
		expect(events).to.deep.equal(['process:first-peer', 'sleep:200', 'process:second-peer']);
	});

	it('a wait that would reach the expiration sends no retry and keeps the first attempt\'s error', async () => {
		const { events, batch } = await runWithRetry(10_000, 5000);
		expect(events).to.deep.equal(['process:first-peer']);
		expect(batch.subsumedBy ?? []).to.have.length(0);
		expect(batch.request!.error).to.equal(firstErr);
	});
});
