/**
 * Ticket: feat-unreferenced-blobs-are-reclaimed.
 *
 * The reference pass of docs/blobs.md §Lifetime: a blob listed by no registered reference tree at two
 * counting passes a grace period apart loses its `responsible` hold, and an owed entry whose own
 * scope has stopped listing its blob is dropped with its `owed` hold. This is the only code in the
 * repository that deletes replicated data on a schedule, so the specs here are mostly about the
 * passes that must NOT count: an unreadable registry, a tree that could not be trusted, a partition,
 * and a read no cohort member vouched for on a node that is not alone.
 *
 * Committed state is a db-core `TestTransactor`, whose answers never carry `cohortConfirmed`, so the
 * pass's reads are unvouched and the cohort gate decides whether they may be acted on. Everything
 * else is the real class: a real `LocalBlobService` over a `MemoryPieceStore`, a real
 * `OwedBlobLedger`, a real `KeyNetworkCohortReachability` over a key-network double, and a real
 * `PartitionDetector`. The clock is injected, and `start()` is called only by the one case about the
 * schedule, which injects a timer seam too, so no case arms a real timer.
 */

import { expect } from 'chai';
import {
	BlobReferenceTree,
	BlobScopeRegistry,
	BlockPossiblyStaleError,
	rootPieceId,
	type BlobRef,
	type BlobScope,
	type BlockGets,
	type ClusterPeers,
	type GetBlockResults,
	type PieceId,
} from '@optimystic/db-core';
import { TestTransactor } from '@optimystic/db-core/test';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { DEFAULT_BLOB_OWNER } from '../src/blob/blob-record.js';
import { BlobRecordStore } from '../src/blob/blob-record-store.js';
import { LocalBlobService } from '../src/blob/local-blob-service.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { OwedBlobLedger } from '../src/blob/owed-blob-ledger.js';
import { DEFAULT_RECLAIM_GRACE_MS } from '../src/blob/reclaim-marks.js';
import { BlobReclaimPass, whyPassDoesNotCount, type ReclaimEvidence, type ReclaimPassReport } from '../src/blob/reclaim-pass.js';
import { createLogger } from '../src/logger.js';
import { KeyNetworkCohortReachability, type CohortReachabilityDeps } from '../src/network/cohort-reachability.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';

const SELF = 'self-peer';
const PARTNER = 'partner-peer';
const SCOPE: BlobScope = 'app/photos/blobrefs';
const OTHER_SCOPE: BlobScope = 'app/drafts/blobrefs';
/** Sorts before both scopes above, so the registry's ascending walk reads it first. */
const BAD_SCOPE: BlobScope = 'app/archive/blobrefs';
/** The default grace period; every case here measures in it. */
const G = DEFAULT_RECLAIM_GRACE_MS;
const PIECE = 256 * 1024;

/** Records nothing and refuses a read of `staleHeader` as possibly stale. A tree's header block id is
 *  its collection id, and every open reads it first, so this makes one tree's read uncertain. */
class StalingTransactor extends TestTransactor {
	staleHeader?: string;

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		if (this.staleHeader !== undefined && gets.blockIds.includes(this.staleHeader)) {
			throw new BlockPossiblyStaleError(this.staleHeader, 99);
		}
		return await super.get(gets);
	}
}

/** Every answer vouched for by a cohort member other than the answerer, which a `TestTransactor`'s
 *  never is. Subclassed rather than wrapped in a `DelegatingTransactor`, as the reference-check
 *  spec's `WatchedTransactor` is. */
class ConfirmingTransactor extends TestTransactor {
	override async get(gets: BlockGets): Promise<GetBlockResults> {
		const results = await super.get(gets);
		for (const result of Object.values(results)) {
			(result as { cohortConfirmed?: true }).cohortConfirmed = true;
		}
		return results;
	}
}

/** A key network whose every routing key resolves to the same cohort, with the same absent members. */
function keyNetworkOver(members: readonly string[], absent: readonly string[] = []): CohortReachabilityDeps['keyNetwork'] {
	return {
		async findCluster() {
			return Object.fromEntries(members.map(id => [id, { multiaddrs: [], publicKey: '' }])) as ClusterPeers;
		},
		async absentCohortMembers() {
			return [...absent];
		},
		async awaitingBootstrapContact() {
			return false;
		},
	};
}

type HarnessOptions = {
	/** Default `[SELF]`: a one-machine deployment, which is alone and so may act on unvouched reads. */
	readonly members?: readonly string[];
	readonly absent?: readonly string[];
	/** Default a `StalingTransactor`. */
	readonly net?: TestTransactor;
};

type Harness = {
	readonly net: TestTransactor;
	readonly kv: MemoryKVStore;
	readonly pieces: MemoryPieceStore;
	readonly blobs: LocalBlobService;
	readonly records: BlobRecordStore;
	readonly owed: OwedBlobLedger;
	readonly detector: PartitionDetector;
	/** A pass at `now`, which also becomes the pass's `startedAt`. */
	readonly passAt: (now: number) => Promise<ReclaimPassReport>;
	/** A second pass over the SAME stores, as a restart builds. */
	readonly restart: () => { passAt: (now: number) => Promise<ReclaimPassReport> };
};

function harness(options: HarnessOptions = {}): Harness {
	const net = options.net ?? new StalingTransactor();
	const kv = new MemoryKVStore();
	const pieces = new MemoryPieceStore();
	// Scheduled sweeps never fire, so every sweep in a case is the one the pass ran.
	const blobs = new LocalBlobService({ pieces, kv, setTimer: () => () => undefined });
	const owed = new OwedBlobLedger(kv);
	const detector = new PartitionDetector();
	const cohort = new KeyNetworkCohortReachability({
		keyNetwork: keyNetworkOver(options.members ?? [SELF], options.absent),
		selfId: SELF,
		identifying: () => 0,
	});
	const log = createLogger('blob:reclaim', SELF);
	const passFor = (records: LocalBlobService, ledger: OwedBlobLedger) => {
		let now = 0;
		const pass = new BlobReclaimPass({ records, owed: ledger, transactor: net, cohort, partitionDetector: detector, log }, { now: () => now });
		return async (at: number): Promise<ReclaimPassReport> => {
			now = at;
			return await pass.runNow();
		};
	};
	return {
		net, kv, pieces, blobs, owed, detector,
		records: new BlobRecordStore(kv),
		passAt: passFor(blobs, owed),
		restart: () => {
			const restarted = new LocalBlobService({ pieces, kv, setTimer: () => () => undefined });
			return { passAt: passFor(restarted, new OwedBlobLedger(kv)) };
		},
	};
}

/** Deterministic bytes that differ by `seed`, as `local-blob-service.spec.ts` builds them. */
function bytesOf(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let state = seed * 2654435761 >>> 0;
	for (let index = 0; index < length; index++) {
		state = (state * 1103515245 + 12345) >>> 0;
		bytes[index] = state >>> 24;
	}
	return bytes;
}

async function* streamOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
	yield* chunks;
}

/** A stored blob whose only hold is `responsible`: `put` pins it, and the pin is dropped again. */
async function responsibleBlob(blobs: LocalBlobService, scope: BlobScope, ...chunks: Uint8Array[]): Promise<BlobRef> {
	const { ref } = await blobs.put(streamOf(...chunks));
	await blobs.holdResponsible(ref, scope);
	await blobs.unpin(ref, DEFAULT_BLOB_OWNER);
	return ref;
}

async function pieceIdOf(blobs: LocalBlobService, bytes: Uint8Array): Promise<PieceId> {
	const { ref } = await blobs.put(streamOf(bytes));
	await blobs.unpin(ref, DEFAULT_BLOB_OWNER);
	return rootPieceId(ref);
}

async function listIn(net: TestTransactor, scope: BlobScope, ref: BlobRef): Promise<void> {
	const references = await BlobReferenceTree.createOrOpen(net, scope);
	await references.stageAdd(ref, 'row-1');
	await references.tree.sync();
}

async function unlistFrom(net: TestTransactor, scope: BlobScope, ref: BlobRef): Promise<void> {
	const references = await BlobReferenceTree.createOrOpen(net, scope);
	await references.stageRemove(ref, 'row-1');
	await references.tree.sync();
}

/** Five peers each failing three times in a row, which is what `detectPartition` reads as a partition. */
function intoPartition(detector: PartitionDetector): void {
	for (let peer = 0; peer < 5; peer++) {
		for (let attempt = 0; attempt < 3; attempt++) {
			detector.recordFailure(`churned-peer-${peer}`);
		}
	}
}

type ArmedTimer = { readonly delayMs: number; live: boolean };

/** A timer seam that records every arm and whether it is still live, so a pass that armed without
 *  cancelling the one before it is visible. */
function timerSpy(): { readonly armed: ArmedTimer[]; readonly setTimer: (fn: () => void, ms: number) => () => void } {
	const armed: ArmedTimer[] = [];
	return {
		armed,
		setTimer: (_fn, ms) => {
			const entry: ArmedTimer = { delayMs: ms, live: true };
			armed.push(entry);
			return () => { entry.live = false; };
		},
	};
}

/** A clean pass's evidence, which every predicate case varies one field of. */
const CLEAN: ReclaimEvidence = {
	partitionAtStart: false,
	partitionAtEnd: false,
	registry: { certain: true, exists: true },
	holdsAny: true,
	trees: [{ scope: SCOPE, outcome: 'certain' }, { scope: OTHER_SCOPE, outcome: 'certain' }],
	unconfirmedBlocks: 0,
	aloneForUnconfirmed: undefined,
	stopped: false,
};

describe('blob reclaim pass', () => {
	describe('whyPassDoesNotCount', () => {
		it('names every disqualifying condition, and nothing on a clean pass', () => {
			expect(whyPassDoesNotCount(CLEAN)).to.deep.equal([]);

			expect(whyPassDoesNotCount({ ...CLEAN, partitionAtStart: true })).to.deep.equal(['partition']);
			expect(whyPassDoesNotCount({ ...CLEAN, partitionAtEnd: true })).to.deep.equal(['partition']);
			expect(whyPassDoesNotCount({ ...CLEAN, registry: 'threw' })).to.deep.equal(['registry-threw']);
			expect(whyPassDoesNotCount({ ...CLEAN, registry: { certain: false, exists: true } })).to.deep.equal(['registry-uncertain']);
			expect(whyPassDoesNotCount({ ...CLEAN, registry: { certain: true, exists: false } })).to.deep.equal(['registry-absent']);
			// A node holding nothing has nothing an absent registry could wrongly reclaim.
			expect(whyPassDoesNotCount({ ...CLEAN, registry: { certain: true, exists: false }, holdsAny: false })).to.deep.equal([]);
			// An EXISTING, empty registry counts: every reference tree was unregistered, so every blob
			// really is unreferenced there.
			expect(whyPassDoesNotCount({ ...CLEAN, trees: [], unconfirmedBlocks: 3, aloneForUnconfirmed: true })).to.deep.equal([]);

			const trees = [{ scope: SCOPE, outcome: 'certain' } as const, { scope: OTHER_SCOPE, outcome: 'threw' } as const];
			expect(whyPassDoesNotCount({ ...CLEAN, trees })).to.deep.equal(['tree-threw']);
			expect(whyPassDoesNotCount({ ...CLEAN, trees: [{ scope: SCOPE, outcome: 'uncertain' }, { scope: OTHER_SCOPE, outcome: 'certain' }] }))
				.to.deep.equal(['tree-uncertain']);

			// Only a false answer disqualifies; `undefined` is "no answer needed vouching".
			expect(whyPassDoesNotCount({ ...CLEAN, unconfirmedBlocks: 4, aloneForUnconfirmed: false })).to.deep.equal(['unconfirmed-not-alone']);
			expect(whyPassDoesNotCount({ ...CLEAN, unconfirmedBlocks: 4, aloneForUnconfirmed: true })).to.deep.equal([]);
			expect(whyPassDoesNotCount({ ...CLEAN, stopped: true })).to.deep.equal(['stopped']);

			// Several at once, in the declaration order of ReclaimNotCountedReason.
			expect(whyPassDoesNotCount({
				...CLEAN,
				partitionAtEnd: true,
				registry: { certain: false, exists: true },
				trees: [{ scope: SCOPE, outcome: 'threw' }, { scope: OTHER_SCOPE, outcome: 'uncertain' }],
				unconfirmedBlocks: 2,
				aloneForUnconfirmed: false,
				stopped: true,
			})).to.deep.equal(['partition', 'registry-uncertain', 'tree-threw', 'tree-uncertain', 'unconfirmed-not-alone', 'stopped']);
		});
	});

	it('releases on a one-machine deployment after two passes a grace period apart, keeping shared pieces', async () => {
		const h = harness();
		const shared = bytesOf(PIECE, 1);
		const aOwn = bytesOf(PIECE, 2);
		const bOwn = bytesOf(PIECE, 3);
		const sharedId = await pieceIdOf(h.blobs, shared);
		const aOwnId = await pieceIdOf(h.blobs, aOwn);
		const bOwnId = await pieceIdOf(h.blobs, bOwn);
		const a = await responsibleBlob(h.blobs, SCOPE, shared, aOwn);
		const b = await responsibleBlob(h.blobs, SCOPE, shared, bOwn);
		await BlobScopeRegistry.register(h.net, SCOPE);
		await listIn(h.net, SCOPE, a);

		const first = await h.passAt(1_000);
		expect(first.counted, first.notCounted.join(',')).to.equal(true);
		expect(first).to.deep.include({ scopes: 1, treesRead: 1, responsibleChecked: 2, listed: 1, newlyMarked: 1, released: 0 });
		expect(await h.blobs.responsibleMarks()).to.deep.equal(
			[a, b].sort().map(ref => ref === b ? { ref: b, unreferencedSince: 1_000 } : { ref: a })
		);

		const second = await h.passAt(1_000 + G);
		expect(second).to.deep.include({ counted: true, released: 1, owedReleased: 0, newlyMarked: 0 });
		expect(await h.blobs.responsibleScope(b)).to.equal(undefined);
		expect(await h.records.get(b), "B held nothing else, so its record is gone").to.equal(undefined);
		expect(await h.blobs.responsibleScope(a), "A is still listed").to.equal(SCOPE);

		// The pass swept once after releasing, so B's own pieces are gone and nothing A needs is.
		expect(await h.pieces.has(bOwnId), "B's own piece").to.equal(false);
		expect(await h.pieces.has(rootPieceId(b)), "B's list piece").to.equal(false);
		expect(await h.pieces.has(sharedId), 'the piece A and B share').to.equal(true);
		expect(await h.pieces.has(aOwnId), "A's own piece").to.equal(true);
		expect(await h.pieces.has(rootPieceId(a)), "A's list piece").to.equal(true);
	});

	it('keeps the mark unchanged over two passes closer together than the grace period', async () => {
		const h = harness();
		const b = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 4));
		await BlobScopeRegistry.register(h.net, SCOPE);
		await listIn(h.net, SCOPE, await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 5)));

		await h.passAt(1_000);
		const second = await h.passAt(1_000 + G - 1);
		expect(second).to.deep.include({ counted: true, newlyMarked: 0, released: 0 });
		expect(await h.blobs.responsibleMarks()).to.deep.include({ ref: b, unreferencedSince: 1_000 });
		expect(await h.blobs.responsibleScope(b)).to.equal(SCOPE);
	});

	it('restarts the grace period from the pass after a blob is referenced again', async () => {
		const h = harness();
		const b = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 6));
		await BlobScopeRegistry.register(h.net, SCOPE);

		expect(await h.passAt(1_000)).to.deep.include({ counted: true, newlyMarked: 1 });
		await listIn(h.net, SCOPE, b);
		expect(await h.passAt(1_001)).to.deep.include({ counted: true, listed: 1, cleared: 1 });
		expect(await h.blobs.responsibleMarks()).to.deep.equal([{ ref: b }]);

		await unlistFrom(h.net, SCOPE, b);
		expect(await h.passAt(1_002)).to.deep.include({ counted: true, newlyMarked: 1 });
		// A grace period after the FIRST mark is no longer enough: the second mark is what counts.
		expect(await h.passAt(1_000 + G)).to.deep.include({ counted: true, released: 0 });
		expect(await h.blobs.responsibleScope(b)).to.equal(SCOPE);
		expect(await h.passAt(1_002 + G)).to.deep.include({ counted: true, released: 1 });
		expect(await h.blobs.responsibleScope(b)).to.equal(undefined);
	});

	it('does not count for any blob when one tree of several could not be trusted, but still clears marks', async () => {
		const h = harness();
		const listedBlob = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 7));
		const unlistedBlob = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 8));
		await BlobScopeRegistry.register(h.net, SCOPE);
		await BlobScopeRegistry.register(h.net, BAD_SCOPE);
		await listIn(h.net, SCOPE, listedBlob);
		await listIn(h.net, BAD_SCOPE, await responsibleBlob(h.blobs, BAD_SCOPE, bytesOf(64, 9)));
		// A mark an earlier pass left on a blob that is in fact still listed.
		expect(await h.blobs.markUnreferenced(listedBlob, 500)).to.equal(true);
		(h.net as StalingTransactor).staleHeader = BAD_SCOPE;

		for (const at of [1_000, 1_000 + G]) {
			const report = await h.passAt(at);
			expect(report.counted).to.equal(false);
			expect(report.notCounted).to.deep.equal(['tree-uncertain']);
			expect(report).to.deep.include({ scopes: 2, treesRead: 2, newlyMarked: 0, released: 0 });
		}
		// The clean tree still listed it, so its stale mark is gone — which is what keeps a later
		// counting pass from reclaiming it with no grace period at all.
		expect(await h.blobs.responsibleMarks()).to.deep.include({ ref: listedBlob });
		expect(await h.blobs.responsibleScope(unlistedBlob)).to.equal(SCOPE);
	});

	it('does not count on a node that cannot see its cohort', async () => {
		const h = harness({ members: [SELF], absent: [PARTNER] });
		const b = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 10));
		await BlobScopeRegistry.register(h.net, SCOPE);

		for (const at of [1_000, 1_000 + G]) {
			const report = await h.passAt(at);
			expect(report.notCounted).to.deep.equal(['unconfirmed-not-alone']);
			expect(report.unconfirmedBlocks).to.be.greaterThan(0);
			expect(report).to.deep.include({ counted: false, newlyMarked: 0, released: 0 });
		}
		expect(await h.blobs.responsibleMarks()).to.deep.equal([{ ref: b }]);
	});

	it('counts on a node that is not alone when every answer was cohort-confirmed', async () => {
		const h = harness({ members: [SELF, PARTNER], net: new ConfirmingTransactor() });
		const b = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 11));
		await BlobScopeRegistry.register(h.net, SCOPE);

		// Nothing was unvouched, so `aloneFor` — which would answer false here — is never consulted.
		expect(await h.passAt(1_000)).to.deep.include({ counted: true, unconfirmedBlocks: 0, newlyMarked: 1 });
		expect(await h.passAt(1_000 + G)).to.deep.include({ counted: true, released: 1 });
		expect(await h.blobs.responsibleScope(b)).to.equal(undefined);
	});

	it('reads nothing and counts nothing during a detected partition', async () => {
		const h = harness();
		const b = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 12));
		await BlobScopeRegistry.register(h.net, SCOPE);
		await listIn(h.net, SCOPE, b);
		intoPartition(h.detector);

		const report = await h.passAt(1_000);
		expect(report.notCounted).to.deep.equal(['partition']);
		expect(report).to.deep.include({ counted: false, scopes: 0, treesRead: 0, unconfirmedBlocks: 0, newlyMarked: 0 });
		expect(await h.blobs.responsibleMarks()).to.deep.equal([{ ref: b }]);
	});

	it('does not count while the registry reads as absent and this node holds a blob', async () => {
		const h = harness();
		const b = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 13));

		const report = await h.passAt(1_000);
		expect(report.notCounted).to.deep.equal(['registry-absent']);
		expect(report).to.deep.include({ counted: false, scopes: 0, treesRead: 0, newlyMarked: 0 });
		expect(await h.blobs.responsibleMarks()).to.deep.equal([{ ref: b }]);
	});

	it('drops the owed entry and the owed hold of a blob whose row was deleted', async () => {
		const h = harness();
		const { ref: b } = await h.blobs.put(streamOf(bytesOf(64, 14)));
		await h.blobs.holdOwed(b);
		await h.blobs.unpin(b, DEFAULT_BLOB_OWNER);
		await h.owed.record(b, SCOPE);
		await BlobScopeRegistry.register(h.net, SCOPE);
		// The tree exists and lists another row's reference; B's row is the one that was deleted.
		await listIn(h.net, SCOPE, await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 15)));

		expect(await h.passAt(1_000)).to.deep.include({ counted: true, owedChecked: 1, newlyMarked: 1, owedReleased: 0 });
		expect(await h.owed.get(b)).to.deep.include({ unlistedSince: 1_000 });

		expect(await h.passAt(1_000 + G)).to.deep.include({ counted: true, owedReleased: 1 });
		expect(await h.owed.get(b), 'the entry the drain reads').to.equal(undefined);
		expect(await h.owed.list()).to.deep.equal([]);
		expect(await h.records.get(b), 'the record held nothing else, so it is gone').to.equal(undefined);
	});

	it('leaves a pinned blob its record and its pieces when its responsible hold is released', async () => {
		const h = harness();
		const bytes = bytesOf(PIECE, 16);
		const pieceId = await pieceIdOf(h.blobs, bytes);
		const b = await responsibleBlob(h.blobs, SCOPE, bytes);
		await h.blobs.pin(b, 'app');
		await BlobScopeRegistry.register(h.net, SCOPE);

		await h.passAt(1_000);
		expect(await h.passAt(1_000 + G)).to.deep.include({ counted: true, released: 1 });
		expect(await h.blobs.responsibleScope(b)).to.equal(undefined);
		expect(await h.blobs.pinsOf(b)).to.deep.equal(['app']);
		expect((await h.records.get(b))?.holds.map(hold => hold.kind)).to.deep.equal(['pin']);
		expect(await h.pieces.has(pieceId), 'the pinned blob keeps its pieces').to.equal(true);
	});

	it('releases after a restart, because the first pass left its mark in the record store', async () => {
		const h = harness();
		const b = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 17));
		await BlobScopeRegistry.register(h.net, SCOPE);

		expect(await h.passAt(1_000)).to.deep.include({ counted: true, newlyMarked: 1 });
		// A second service, ledger and pass over the same key-value and piece stores. Deliberately not a
		// `PowerLossKVStore`: a mark is not flushed by design, so modelling a crash would pin a
		// durability this pass does not promise. What this pins is that the mark lives in the store.
		const restarted = h.restart();
		expect(await restarted.passAt(1_000 + G)).to.deep.include({ counted: true, released: 1 });
		expect(await h.blobs.responsibleScope(b)).to.equal(undefined);
	});

	it('does not release on one pass a blob whose responsible hold was released and re-taken', async () => {
		const h = harness();
		const b = await responsibleBlob(h.blobs, SCOPE, bytesOf(64, 18));
		await BlobScopeRegistry.register(h.net, SCOPE);

		expect(await h.passAt(1_000)).to.deep.include({ counted: true, newlyMarked: 1 });
		// Taking the hold again is fresh evidence the blob is referenced, so it carries no mark.
		await h.blobs.releaseResponsible(b);
		await h.blobs.holdResponsible(b, SCOPE);

		const report = await h.passAt(1_000 + G);
		expect(report).to.deep.include({ counted: true, released: 0, newlyMarked: 1 });
		expect(await h.blobs.responsibleMarks()).to.deep.equal([{ ref: b, unreferencedSince: 1_000 + G }]);
	});

	it('keeps one timer armed when a pass is asked for while the schedule is pending', async () => {
		// `runNow` on a started pass lands while the schedule's timer is pending, and the pass re-arms
		// from the same place: an arm that did not cancel first would leave the earlier timer live, so
		// every such call would add a timer that `stop()` cannot reach and that fires passes of its own.
		const timer = timerSpy();
		const kv = new MemoryKVStore();
		const pass = new BlobReclaimPass({
			// Holds nothing, so each pass returns `skipped: 'nothing-held'` and the case is about the schedule alone.
			records: new LocalBlobService({ pieces: new MemoryPieceStore(), kv, setTimer: () => () => undefined }),
			owed: new OwedBlobLedger(kv),
			transactor: new StalingTransactor(),
			cohort: new KeyNetworkCohortReachability({ keyNetwork: keyNetworkOver([SELF]), selfId: SELF }),
			partitionDetector: new PartitionDetector(),
			log: createLogger('blob:reclaim', SELF),
		}, { setTimer: timer.setTimer, firstPassDelayMs: 1_000, intervalMs: 2_000 });
		pass.start();
		expect(timer.armed.map(entry => entry.delayMs)).to.deep.equal([1_000]);

		await pass.runNow();
		expect(timer.armed.map(entry => entry.delayMs), 'the pass re-armed at the interval').to.deep.equal([1_000, 2_000]);
		expect(timer.armed.filter(entry => entry.live).length, 'the first-pass timer was cancelled, not left behind').to.equal(1);

		await pass.stop();
		expect(timer.armed.some(entry => entry.live), 'nothing is left armed after stop').to.equal(false);
	});

	it('reads nothing when this node holds no responsible blob and owes none', async () => {
		const h = harness();
		await BlobScopeRegistry.register(h.net, SCOPE);

		const report = await h.passAt(1_000);
		expect(report).to.deep.include({ skipped: 'nothing-held', counted: false, scopes: 0, treesRead: 0 });
		expect(report.notCounted).to.deep.equal([]);
	});
});
