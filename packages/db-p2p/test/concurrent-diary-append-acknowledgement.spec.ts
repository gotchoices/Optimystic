/**
 * Ticket: consensus-pend-refusal-finish-and-verify.
 *
 * Mesh-tier regression for the acknowledged-but-lost concurrent write: several nodes race
 * appends into one diary, and before the fix a losing pend — refused by every member's storage
 * (rival pending action holding the blocks, or the requested revision already committed) — was
 * still reported to the writer as a success, so the writer stopped retrying and the entry
 * silently never appeared. "Acknowledged means durable" is the property under test: every append
 * whose promise FULFILLED must be present in the converged log on every node; an append that
 * lost for good must have REJECTED with a conflict-shaped failure, never vanished quietly.
 *
 * Same scenario as the reference-peer reproducer (distributed-diary.spec.ts, "should handle
 * concurrent writes from multiple nodes") but on the in-process mesh harness — seconds instead
 * of a live libp2p swarm.
 */

import { expect } from 'chai';
import { Diary, type ITransactor, type CommitRequest, type CommitResult } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '../src/testing/mesh-harness.js';

interface DiaryEntry {
	content: string;
}

const transactorFor = (transactors: Map<string, ITransactor>, peerIdStr: string): ITransactor => {
	const t = transactors.get(peerIdStr);
	if (!t) throw new Error(`No transactor for peer ${peerIdStr}`);
	return t;
};

/** One injected tear: how many of the action's blocks were let through, and how many dropped. */
interface TearRecord {
	committed: number;
	dropped: number;
}

const entriesOf = async (diary: Diary<DiaryEntry>): Promise<string[]> => {
	await diary.update();
	const contents: string[] = [];
	for await (const entry of diary.select()) contents.push(entry.content);
	return contents;
};

/**
 * Wraps a transactor so its FIRST commit tears: the collection header and log tail commit for
 * real, every other block of the action is dropped, and the caller is answered with the stale
 * failure a genuine later-block loss produces — `NetworkTransactor.commit`'s non-tail sweep
 * returning `staleFromBatches`' result, which is `{ success: false, missing, staleAt? }` and
 * deliberately carries NO `conflict` flag (that field is set only by producers that classified
 * the loss themselves). `missing: []` is the weakest shape that path can return, so the recovery
 * asserted below is being pinned against the LEAST informative failure production can hand it —
 * `Collection.syncInternal` retries on any stale failure at all, never on `isConflictFailure`.
 *
 * That is the torn action in its exact production shape. `NetworkTransactor.commit` commits the
 * tail, then sweeps the rest (the header included, when the action touches it) — so by the
 * time a later block confirms a conflict the log entry the tail carries is already durable, and
 * the writer is nonetheless told it failed. Everything after that is the code under test: the
 * writer cancels (a no-op on the already-promoted records) and refreshes, and that refresh must
 * recognize the committed entry as its OWN and consume it rather than replaying it into a
 * duplicate.
 *
 * Explicit delegation rather than a spread of `inner`: `NetworkTransactor` is a class, so its
 * methods live on the prototype and a spread would copy none of them. The literal is annotated
 * `ITransactor`, so a new REQUIRED method on that type breaks this file at compile time; only a
 * new OPTIONAL one could go unforwarded silently, the way `queryClusterNominees` is forwarded
 * by hand below.
 *
 * Returns the recorded tears alongside the transactor so a test can assert the injection actually
 * fired — without that, a refactor that stopped committing here would leave the test passing
 * while measuring nothing.
 */
const tearFirstCommit = (inner: ITransactor): { transactor: ITransactor; tears: TearRecord[] } => {
	const tears: TearRecord[] = [];
	let torn = false;
	const wrapper: ITransactor = {
		get: gets => inner.get(gets),
		getStatus: refs => inner.getStatus(refs),
		pend: request => inner.pend(request),
		cancel: ref => inner.cancel(ref),
		commit: async (request: CommitRequest): Promise<CommitResult> => {
			if (torn) return inner.commit(request);
			torn = true;
			// Keep only the tail and (when present) the header — both are already in `blockIds` in
			// production, so this is just naming the two ids that should survive the tear.
			const kept = request.blockIds.filter(id => id === request.tailId || id === request.headerId);
			tears.push({ committed: kept.length, dropped: request.blockIds.length - kept.length });
			const truncated = await inner.commit({ ...request, blockIds: kept });
			// If the truncated commit itself lost, report that verbatim — there is nothing torn to
			// assert about and the test would be measuring the wrong failure.
			if (!truncated.success) return truncated;
			return {
				success: false,
				missing: [],
				reason: 'stale commit: injected later-block conflict after tail commit'
			};
		}
	};
	if (inner.queryClusterNominees) {
		wrapper.queryClusterNominees = blockId => inner.queryClusterNominees!(blockId);
	}
	return { transactor: wrapper, tears };
};

describe('Concurrent diary appends — acknowledged means durable', function () {
	this.timeout(30_000);

	let mesh: Mesh;
	let transactors: Map<string, ITransactor>;

	beforeEach(async () => {
		mesh = await createMesh(3, {
			responsibilityK: 3,
			clusterSize: 3,
			superMajorityThreshold: 0.67
		});
		transactors = buildNetworkTransactors(mesh);
	});

	it('every fulfilled append is present after convergence; losses reject as conflicts', async () => {
		const diaryId = 'concurrent-append-ack';

		// All nodes open before anything is committed — the reproducer's shape: every instance
		// stages the header, and the concurrent appends below race their pends for the same
		// revisions.
		const diaries: Diary<DiaryEntry>[] = [];
		for (const node of mesh.nodes) {
			diaries.push(await Diary.createOrOpen<DiaryEntry>(
				transactorFor(transactors, node.peerId.toString()), diaryId));
		}

		const attempted = diaries.map((_, i) => `entry-from-node-${i}`);
		const results = await Promise.allSettled(
			diaries.map((diary, i) => diary.append({ content: attempted[i]! }))
		);

		const fulfilled = attempted.filter((_, i) => results[i]!.status === 'fulfilled');
		expect(fulfilled.length, 'at least one concurrent append must win').to.be.at.least(1);

		// A rejected append must have LOST OUT LOUD as a retryable-conflict shape (the sync loop
		// exhausting its retries over rival pends / taken revisions), never as some unrelated
		// fault — and never fulfilled-but-absent, which the membership assertions below pin.
		for (let i = 0; i < results.length; i++) {
			const result = results[i]!;
			if (result.status === 'rejected') {
				const message = String((result.reason as Error)?.message ?? result.reason);
				expect(message, `node ${i}'s rejection must be conflict-shaped: ${message}`)
					.to.match(/conflict|stale|pending|retr/i);
			}
		}

		// Convergence: every node's view must contain every acknowledged entry, exactly once, and
		// nothing that was never attempted. Each writer syncs once more first so a loser that
		// internally rebased-and-won has pushed everything it acknowledged.
		for (const [i, diary] of diaries.entries()) {
			const contents = await entriesOf(diary);
			for (const entry of fulfilled) {
				expect(contents, `node ${i} must hold acknowledged entry "${entry}"`).to.include(entry);
			}
			expect(new Set(contents).size, `node ${i} must hold no duplicate entries`).to.equal(contents.length);
			for (const entry of contents) {
				expect(attempted, `node ${i} holds unexpected entry "${entry}"`).to.include(entry);
			}
		}
	});

	it('a torn commit — tail durable, a later block refused — lands its entry exactly once', async () => {
		// The third torn-action shape, and the one the acknowledged-means-durable refusal above used
		// to make worse. Deterministic, not raced: `tearFirstCommit` commits the tail for real and
		// then answers the writer with a conflict, so the writer's retry meets its OWN durable
		// revision on re-pend and its OWN committed log entry on refresh. Before the fix that retry
		// either wedged (refused by its own commit) or replayed the entry into a duplicate.
		const diaryId = 'torn-commit-append';
		const writerPeer = mesh.nodes[0]!.peerId.toString();
		const observerPeer = mesh.nodes[1]!.peerId.toString();

		// Seed one entry through the unwrapped transactor so the collection already exists: the torn
		// append below is then an ordinary append against a committed header, not a
		// create-and-append. That also makes the duplicate visible as a third element rather than
		// as a subtly wrong single-entry log.
		//
		// NOTE: a Diary's "append" module touches no blocks (entries live in the log), so this
		// action's commit carries exactly one block — the tail — and `tears[0].dropped` is 0. The
		// tear is therefore real in the way that matters here (the entry committed durably, the
		// writer was told it failed) but it does not exercise the pend-tier own-revision carve-out,
		// because the writer never gets as far as re-pending. Pinning that arm needs a collection
		// whose action writes blocks beyond the log tail; `storage-repo.spec.ts` and
		// `cluster-pend-staleness.spec.ts` cover it directly at their own tier.
		const seedDiary = await Diary.createOrOpen<DiaryEntry>(
			transactorFor(transactors, writerPeer), diaryId);
		await seedDiary.append({ content: 'seed' });

		const { transactor: tornTransactor, tears } = tearFirstCommit(transactorFor(transactors, writerPeer));
		const tornDiary = await Diary.createOrOpen<DiaryEntry>(tornTransactor, diaryId);
		await tornDiary.append({ content: 'torn-entry' });

		// The injection must actually have happened, and the append must still have been
		// acknowledged (it returned) — i.e. the writer recovered rather than wedging.
		expect(tears.length, 'the first commit must have been torn').to.equal(1);
		expect(tears[0]!.committed, 'the tail must have committed for real').to.be.at.least(1);

		// Exactly once in the writer's own view — a replayed entry would show up twice here.
		expect(await entriesOf(tornDiary), 'writer view after a torn commit')
			.to.deep.equal(['seed', 'torn-entry']);

		// And exactly once on a node that never saw the tear: the entry is genuinely durable and
		// converged, not an artifact of the writer's local tracker.
		const observerDiary = await Diary.createOrOpen<DiaryEntry>(
			transactorFor(transactors, observerPeer), diaryId);
		expect(await entriesOf(observerDiary), 'observer view after a torn commit')
			.to.deep.equal(['seed', 'torn-entry']);
	});

	it('sequential appends from different nodes all land (no false conflicts from the fix)', async () => {
		// Guard the other direction: the promise-phase pending-conflict vote and the retained
		// verdict must not refuse writes that do not actually race.
		const diaryId = 'sequential-append-ack';
		const diaries: Diary<DiaryEntry>[] = [];
		for (const node of mesh.nodes) {
			diaries.push(await Diary.createOrOpen<DiaryEntry>(
				transactorFor(transactors, node.peerId.toString()), diaryId));
		}

		for (const [i, diary] of diaries.entries()) {
			await diary.append({ content: `sequential-${i}` });
		}

		const contents = await entriesOf(diaries[0]!);
		expect(contents).to.have.members(['sequential-0', 'sequential-1', 'sequential-2']);
	});
});
