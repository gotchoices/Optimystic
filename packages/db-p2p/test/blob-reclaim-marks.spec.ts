/**
 * Ticket: feat-a-blob-remembers-when-it-was-last-found-unreferenced.
 *
 * The two marks a reclaim pass leaves behind so that two passes a grace period apart can be compared
 * across a restart (docs/blobs.md §Lifetime): `BlobRecord.unreferencedSince` on a blob this node
 * holds because it is responsible for it, and `OwedBlobEntry.unlistedSince` on an owed entry. These
 * specs pin the pure grace-period rule, and — on a real `LocalBlobService` and a real
 * `OwedBlobLedger` — that each mark lives and dies with the thing it is about, so a mark can never
 * make one pass release a hold taken since. Nothing here reads committed state: the pass that writes
 * the marks is `feat-unreferenced-blobs-are-reclaimed`.
 */

import { expect } from 'chai';
import { buildBlob, type BlobRef, type BlobScope } from '@optimystic/db-core';
import { BlobRecordStore } from '../src/blob/blob-record-store.js';
import { LocalBlobService } from '../src/blob/local-blob-service.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { OwedBlobLedger } from '../src/blob/owed-blob-ledger.js';
import {
	DEFAULT_RECLAIM_GRACE_MS,
	MIN_RECLAIM_GRACE_MS,
	judgeMark,
	resolveReclaimGraceMs,
} from '../src/blob/reclaim-marks.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';

const SCOPE: BlobScope = 'app/photos/blobrefs';
const OTHER_SCOPE: BlobScope = 'app/drafts/blobrefs';

/** A canonical reference, from bytes nothing stores: marks are about records and entries, not pieces. */
async function refOf(seed: number): Promise<BlobRef> {
	const bytes = new Uint8Array([seed, seed, seed]);
	const { ref } = await buildBlob((async function* () { yield bytes; })(), { put: async () => undefined });
	return ref;
}

/** A service whose scheduled sweeps never fire, so a released hold deletes a record without a sweep racing the assertions. */
function serviceOver(kv: MemoryKVStore): LocalBlobService {
	return new LocalBlobService({ pieces: new MemoryPieceStore(), kv, setTimer: () => () => undefined });
}

describe('blob reclaim marks', () => {
	it('judges a mark against the pass start time, and refuses a grace period below the minimum', () => {
		const grace = 1_000;
		const startedAt = 10_000;

		// No mark is the first counting pass that found the blob listed nowhere; a mark after the pass
		// started is the wall clock having gone back, where restarting the period keeps the blob.
		expect(judgeMark(undefined, startedAt, grace)).to.equal('mark');
		expect(judgeMark(startedAt + 1, startedAt, grace)).to.equal('mark');
		// The boundary itself releases: "a grace period apart" includes exactly a grace period.
		expect(judgeMark(startedAt - grace, startedAt, grace)).to.equal('release');
		expect(judgeMark(startedAt - grace + 1, startedAt, grace)).to.equal('keep');
		expect(judgeMark(startedAt, startedAt, grace)).to.equal('keep');

		expect(resolveReclaimGraceMs(undefined)).to.equal(DEFAULT_RECLAIM_GRACE_MS);
		expect(resolveReclaimGraceMs(MIN_RECLAIM_GRACE_MS)).to.equal(MIN_RECLAIM_GRACE_MS);
		expect(() => resolveReclaimGraceMs(MIN_RECLAIM_GRACE_MS - 1)).to.throw(RangeError, 'reclaimGraceMs');
		expect(() => resolveReclaimGraceMs(Number.NaN)).to.throw(RangeError, 'reclaimGraceMs');
	});

	it('a record mark lives and dies with the responsible hold it is about', async () => {
		const kv = new MemoryKVStore();
		const service = serviceOver(kv);
		const records = new BlobRecordStore(kv);
		const ref = await refOf(1);

		// A mark needs the hold: there is nothing for it to be about without one.
		expect(await service.markUnreferenced(ref, 1_000)).to.equal(false);
		await service.pin(ref, 'app');
		expect(await service.markUnreferenced(ref, 1_000)).to.equal(false);
		await service.unpin(ref, 'app');

		await service.holdResponsible(ref, SCOPE);
		expect(await service.markUnreferenced(ref, 1_000)).to.equal(true);
		expect(await service.responsibleMarks()).to.deep.equal([{ ref, unreferencedSince: 1_000 }]);

		// Taking the hold again is fresh evidence the blob is referenced, so the period starts over.
		await service.holdResponsible(ref, OTHER_SCOPE);
		expect(await service.responsibleMarks()).to.deep.equal([{ ref }]);
		expect(Object.keys((await records.get(ref)) ?? {}), 'the field is dropped, not set to undefined').to.not.include('unreferencedSince');

		// The branch that would otherwise delete a live blob: a mark the record no longer carries
		// releases nothing.
		expect(await service.markUnreferenced(ref, 2_000)).to.equal(true);
		expect(await service.releaseResponsibleIfMarked(ref, 1_000)).to.equal(false);
		expect(await service.responsibleScope(ref)).to.equal(OTHER_SCOPE);
		expect(await service.releaseResponsibleIfMarked(ref, 2_000)).to.equal(true);
		expect(await service.responsibleScope(ref)).to.equal(undefined);
		expect(await records.get(ref), 'the record held nothing else, so it is gone').to.equal(undefined);

		// A pin outlives the released hold, and so does the record carrying it: the mark going is not
		// the record going.
		const pinned = await refOf(2);
		await service.pin(pinned, 'app');
		await service.holdResponsible(pinned, SCOPE);
		expect(await service.markUnreferenced(pinned, 3_000)).to.equal(true);
		expect(await service.releaseResponsibleIfMarked(pinned, 3_000)).to.equal(true);
		const afterRelease = await records.get(pinned);
		expect(afterRelease?.holds.map(hold => hold.kind)).to.deep.equal(['pin']);
		expect(afterRelease?.unreferencedSince).to.equal(undefined);

		// The pass's other door: a blob found referenced again loses its mark and keeps its hold. Only
		// `ref` is listed — `pinned` now carries a pin and nothing else.
		await service.holdResponsible(ref, SCOPE);
		expect(await service.markUnreferenced(ref, 4_000)).to.equal(true);
		await service.clearUnreferenced(ref);
		expect(await service.responsibleMarks()).to.deep.equal([{ ref }]);
		expect(await service.responsibleScope(ref)).to.equal(SCOPE);
	});

	it('an owed entry mark lives and dies with the entry it is about', async () => {
		let at = 1_000;
		const ledger = new OwedBlobLedger(new MemoryKVStore(), { now: () => at++ });
		const ref = await refOf(3);

		// A mark needs an entry, and never creates one.
		expect(await ledger.markUnlisted(ref, 5_000)).to.equal(false);
		expect(await ledger.get(ref)).to.equal(undefined);

		await ledger.record(ref, SCOPE);
		expect(await ledger.markUnlisted(ref, 5_000)).to.equal(true);
		expect(await ledger.list()).to.deep.equal([{ ref, scope: SCOPE, holders: [], recordedAt: 1_000, unlistedSince: 5_000 }]);

		// A confirmed holder is not evidence that a row references the blob, so it must not restart the
		// period; a re-record is the writer saying the reference is live, so it must — even for the
		// scope the entry already carries.
		expect(await ledger.addHolders(ref, ['peer-b'])).to.deep.equal({ ref, scope: SCOPE, holders: ['peer-b'], recordedAt: 1_000, unlistedSince: 5_000 });
		expect(await ledger.record(ref, SCOPE)).to.deep.equal({ ref, scope: SCOPE, holders: ['peer-b'], recordedAt: 1_000 });
		expect(Object.keys((await ledger.get(ref)) ?? {}), 'the field is dropped, not set to undefined').to.not.include('unlistedSince');

		// The branch that would otherwise drop a live entry.
		expect(await ledger.markUnlisted(ref, 6_000)).to.equal(true);
		expect(await ledger.deleteIfUnlisted(ref, 5_000)).to.equal(false);
		expect(await ledger.get(ref)).to.not.equal(undefined);
		expect(await ledger.deleteIfUnlisted(ref, 6_000)).to.equal(true);
		expect(await ledger.get(ref)).to.equal(undefined);
		expect(await ledger.size()).to.equal(0);

		// The pass's other door: an entry found listed again loses its mark and stands.
		await ledger.record(ref, OTHER_SCOPE);
		expect(await ledger.markUnlisted(ref, 7_000)).to.equal(true);
		await ledger.clearUnlisted(ref);
		expect(await ledger.get(ref)).to.deep.equal({ ref, scope: OTHER_SCOPE, holders: [], recordedAt: 1_001 });
	});
});
