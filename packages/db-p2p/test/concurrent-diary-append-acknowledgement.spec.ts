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
import { Diary, type ITransactor } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '../src/testing/mesh-harness.js';

interface DiaryEntry {
	content: string;
}

const transactorFor = (transactors: Map<string, ITransactor>, peerIdStr: string): ITransactor => {
	const t = transactors.get(peerIdStr);
	if (!t) throw new Error(`No transactor for peer ${peerIdStr}`);
	return t;
};

const entriesOf = async (diary: Diary<DiaryEntry>): Promise<string[]> => {
	await diary.update();
	const contents: string[] = [];
	for await (const entry of diary.select()) contents.push(entry.content);
	return contents;
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
