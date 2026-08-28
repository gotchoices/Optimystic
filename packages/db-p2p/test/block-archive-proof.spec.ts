import { expect } from 'chai';
import {
	latestClaimFromArchive, servableProof, serveBlockArchive, singleRevisionArchive,
	type ArchiveServingRepo
} from '../src/storage/block-archive.js';
import type { BlockArchive } from '../src/storage/struct.js';
import { verifyBlockCommitProofClaim, verifyBlockCommitProofContent, type BlockCommitProof } from '../src/cluster/commit-proof.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { MAX_BLOCK_MESSAGE_BYTES } from '../src/protocol-limits.js';
import { createMesh, type Mesh } from '../src/testing/mesh-harness.js';
import { PROOF_THRESHOLDS, makeSignedProof } from './support/commit-proof-fixtures.js';
import { canonicalBlockHash } from '@optimystic/db-core';
import type { ActionId, ActionRev, BlockId, CommitRequest, IBlock } from '@optimystic/db-core';

/**
 * The commit proof on the two block-repair wires: the archive a peer serves a repair fetch with,
 * and the latest-revision claim projected out of that archive.
 *
 * Nothing here DECIDES anything with a proof — accepting one as repair evidence is a later ticket.
 * What these tests pin is that a proof survives the trip intact and still verifies, that its absence
 * changes nothing, and that a proof can never be served paired with a revision it does not certify.
 */

const BLOCK = 'block-1' as BlockId;
const OTHER_BLOCK = 'block-2' as BlockId;
const ACTION = 'action-1' as ActionId;
const ACTION_2 = 'action-2' as ActionId;

const makeBlock = (id: BlockId = BLOCK, marker = 'x'): IBlock => ({
	header: { id, type: 'test', collectionId: 'collection-1' as BlockId },
	items: [marker]
} as unknown as IBlock);

const makeCommit = (over: Partial<CommitRequest> = {}): CommitRequest => ({
	actionId: ACTION, blockIds: [BLOCK], tailId: BLOCK, rev: 1, ...over
});

/** A `StorageRepo` over its own `MemoryRawStorage`, so a test can also reach the raw proof keys. */
const makeRepo = () => {
	const raw = new MemoryRawStorage();
	return { raw, repo: new StorageRepo((blockId) => new BlockStorage(blockId, raw)) };
};

/**
 * Land one revision of `BLOCK` through the real `StorageRepo` commit path. With `certified` the
 * commit declares the block's true digest and carries a fully-signed `peers`-member proof, so the
 * retention rule keeps it; without, the commit declares no digest and the repo stores no proof —
 * which is the pre-proof revision every wire must still handle.
 */
const landRevision = async (
	repo: StorageRepo,
	{ rev, actionId, block, certified, peers = 3 }: {
		rev: number; actionId: ActionId; block: IBlock; certified: boolean; peers?: number;
	}
): Promise<BlockCommitProof | undefined> => {
	const pended = await repo.pend({
		actionId,
		transforms: { inserts: { [BLOCK]: block }, updates: {}, deletes: [] },
		...(rev > 1 ? { rev } : {}),
		policy: 'c'
	});
	expect(pended.success, `pend for rev ${rev} must land`).to.equal(true);

	if (!certified) {
		expect((await repo.commit(makeCommit({ rev, actionId }))).success).to.equal(true);
		return undefined;
	}
	const commit = makeCommit({ rev, actionId, blockDigests: { [BLOCK]: { digest: await canonicalBlockHash(block) } } });
	const { proof } = await makeSignedProof(peers, commit);
	expect((await repo.commit(commit, undefined, proof)).success).to.equal(true);
	return proof;
};

/** The single revision entry a `singleRevisionArchive` carries. */
const soleEntry = (archive: BlockArchive) => {
	const revs = Object.keys(archive.revisions);
	expect(revs, 'a served archive carries exactly one revision').to.have.length(1);
	return archive.revisions[Number(revs[0])]!;
};

describe('block archive commit proof', () => {

	describe('serveBlockArchive', () => {
		it('serves the retained proof in the revision entry, and it certifies the served block', async () => {
			const { repo } = makeRepo();
			const block = makeBlock();
			const proof = await landRevision(repo, { rev: 1, actionId: ACTION, block, certified: true });

			const archive = (await serveBlockArchive(repo, BLOCK))!;
			const entry = soleEntry(archive);
			expect(entry.proof, 'the retained proof rides on the archive').to.deep.equal(proof);

			// The whole point of carrying it: a receiver with only this archive can check the claim
			// AND the bytes, with no second holder to corroborate against.
			const verdict = await verifyBlockCommitProofContent(
				entry.proof!, { blockId: BLOCK, rev: 1, actionId: ACTION }, entry.block!, PROOF_THRESHOLDS);
			expect(verdict.ok, `proof must verify, got ${JSON.stringify(verdict)}`).to.equal(true);
		});

		it('omits the proof key entirely when the repo retained none (a pre-proof revision)', async () => {
			const { repo } = makeRepo();
			await landRevision(repo, { rev: 1, actionId: ACTION, block: makeBlock(), certified: false });

			const archive = (await serveBlockArchive(repo, BLOCK))!;
			const entry = soleEntry(archive);
			expect('proof' in entry, 'absent means absent, not `proof: undefined`').to.equal(false);
			// Everything a pre-proof consumer reads is untouched.
			expect(entry.action.actionId).to.equal(ACTION);
			expect(entry.block).to.deep.equal(makeBlock());
			expect(archive.range).to.deep.equal([1, 2]);
		});

		it('serves an archive from a repo with no proof accessor at all (an un-upgraded serving repo)', async () => {
			// A plain `IRepo` — the shape the unit-test doubles and any non-StorageRepo server pass.
			const latest: ActionRev = { actionId: ACTION, rev: 4 };
			const block = makeBlock();
			const plain = { get: async () => ({ [BLOCK]: { block, state: { latest } } }) } as unknown as ArchiveServingRepo;

			const archive = (await serveBlockArchive(plain, BLOCK))!;
			const entry = soleEntry(archive);
			expect('proof' in entry).to.equal(false);
			expect(entry.action.actionId).to.equal(ACTION);
			expect(archive.range).to.deep.equal([4, 5]);
		});

		it('survives the sync protocol\'s JSON round trip and still verifies afterwards', async () => {
			const { repo } = makeRepo();
			const block = makeBlock();
			await landRevision(repo, { rev: 1, actionId: ACTION, block, certified: true });
			const archive = (await serveBlockArchive(repo, BLOCK))!;

			// Exactly what SyncService/SyncClient do to it: JSON.stringify on the wire, JSON.parse on
			// arrival. Verification recomputes hashes over `message` with canonicalJson, so any key
			// reordering or numeric/undefined mangling in transit would surface here as a failure.
			const overWire = JSON.parse(JSON.stringify({ success: true, archive })) as { archive: BlockArchive };
			const entry = soleEntry(overWire.archive);
			expect(entry.proof).to.deep.equal(soleEntry(archive).proof);

			const verdict = await verifyBlockCommitProofContent(
				entry.proof!, { blockId: BLOCK, rev: 1, actionId: ACTION }, entry.block!, PROOF_THRESHOLDS);
			expect(verdict.ok, `proof must still verify after the wire, got ${JSON.stringify(verdict)}`).to.equal(true);
		});

		it('serves the requested revision labelled as itself, with that revision\'s own proof', async () => {
			const { repo } = makeRepo();
			const proof1 = await landRevision(repo, { rev: 1, actionId: ACTION, block: makeBlock(BLOCK, 'one'), certified: true });
			const proof2 = await landRevision(repo, { rev: 2, actionId: ACTION_2, block: makeBlock(BLOCK, 'two'), certified: true });
			expect(proof1).to.not.deep.equal(proof2);
			expect(await repo.getBlockProof(BLOCK, 1), 'rev 1 keeps its own proof').to.deep.equal(proof1);

			// A pinned request is answered with the PINNED revision — its bytes, its action id, its
			// revision number, its proof — and an unpinned request with the latest. The proof is
			// verified against the served CONTENT, not just the claim: rev 2's proof over rev 1's bytes
			// would pass the claim check and fail this one, which is exactly the mislabel this pins out.
			const expected = {
				1: { rev: 1, actionId: ACTION, marker: 'one', proof: proof1 },
				2: { rev: 2, actionId: ACTION_2, marker: 'two', proof: proof2 }
			};
			for (const requested of [undefined, 1, 2] as const) {
				const want = expected[requested ?? 2];
				const archive = (await serveBlockArchive(repo, BLOCK, requested))!;
				const entry = soleEntry(archive);
				expect(archive.range, `requested ${requested}: served revision`).to.deep.equal([want.rev, want.rev + 1]);
				expect(entry.action.actionId, `requested ${requested}: served action`).to.equal(want.actionId);
				expect(entry.block, `requested ${requested}: served bytes`).to.deep.equal(makeBlock(BLOCK, want.marker));
				expect(entry.proof, `requested ${requested}: served proof`).to.deep.equal(want.proof);
				const verdict = await verifyBlockCommitProofContent(
					entry.proof!, { blockId: BLOCK, rev: want.rev, actionId: want.actionId }, entry.block!, PROOF_THRESHOLDS);
				expect(verdict.ok, `served proof must certify the served content: ${JSON.stringify(verdict)}`).to.equal(true);
			}
		});

		it('withholds a stored proof whose message names a different revision', async () => {
			// Written straight to raw storage, bypassing the retention rule: this is the local
			// storage-integrity fault (or a hostile write) the serving guard exists for. Publishing it
			// would hand every receiver an artifact that can only fail verification.
			const { raw, repo } = makeRepo();
			await landRevision(repo, { rev: 1, actionId: ACTION, block: makeBlock(), certified: false });
			const { proof } = await makeSignedProof(3, makeCommit({ rev: 9 }));
			await raw.saveBlockProof(BLOCK, 1, proof);

			expect(await repo.getBlockProof(BLOCK, 1), 'the mis-paired proof IS stored').to.deep.equal(proof);
			expect('proof' in soleEntry((await serveBlockArchive(repo, BLOCK))!)).to.equal(false);
		});

		it('withholds a stored proof whose message names a different block or action', async () => {
			const { raw, repo } = makeRepo();
			await landRevision(repo, { rev: 1, actionId: ACTION, block: makeBlock(), certified: false });

			const otherBlock = await makeSignedProof(3, makeCommit({ blockIds: [OTHER_BLOCK], tailId: OTHER_BLOCK }));
			await raw.saveBlockProof(BLOCK, 1, otherBlock.proof);
			expect('proof' in soleEntry((await serveBlockArchive(repo, BLOCK))!)).to.equal(false);

			const otherAction = await makeSignedProof(3, makeCommit({ actionId: 'action-elsewhere' as ActionId }));
			await raw.saveBlockProof(BLOCK, 1, otherAction.proof);
			expect('proof' in soleEntry((await serveBlockArchive(repo, BLOCK))!)).to.equal(false);
		});

		it('still serves the archive when the proof lookup throws', async () => {
			// Failing closed to "no proof" is safe; failing to "no archive" would turn a real holder
			// into a phantom non-holder, which is the availability bug the archive shape exists to
			// prevent. It is also what keeps a local storage fault from changing the latest-consult's
			// three-way contract: the self short-circuit shares this lookup.
			const { repo } = makeRepo();
			await landRevision(repo, { rev: 1, actionId: ACTION, block: makeBlock(), certified: true });
			const faulty: ArchiveServingRepo = {
				get: (gets: any, options: any) => repo.get(gets, options),
				getBlockProof: async () => { throw new Error('simulated disk fault'); }
			} as unknown as ArchiveServingRepo;

			const archive = await serveBlockArchive(faulty, BLOCK);
			expect(archive, 'the archive is still served').to.not.equal(undefined);
			expect('proof' in soleEntry(archive!)).to.equal(false);
		});

		it('leaves a proof-carrying archive far below the sync response cap', async () => {
			// The NOTE on serveBlockArchive quotes these numbers; this is what keeps them honest.
			const sizes: Record<number, number> = {};
			for (const peers of [10, 20]) {
				const { repo } = makeRepo();
				await landRevision(repo, { rev: 1, actionId: ACTION, block: makeBlock(), certified: true, peers });
				const archive = (await serveBlockArchive(repo, BLOCK))!;
				expect(soleEntry(archive).proof, `${peers}-peer proof must be served`).to.not.equal(undefined);
				sizes[peers] = JSON.stringify(archive).length;
			}
			// eslint-disable-next-line no-console
			console.log(`      proof-carrying single-revision archive: ${sizes[10]} bytes (10 peers), ${sizes[20]} bytes (20 peers)`);

			// Two orders of magnitude of headroom against MAX_BLOCK_MESSAGE_BYTES (8 MiB, the cap
			// SyncClient.requestBlock puts on a sync RESPONSE). If a future proof shape breaks this,
			// the per-peer cost has grown by ~100x and the NOTE needs rewriting, not the assertion.
			expect(sizes[20]!).to.be.lessThan(MAX_BLOCK_MESSAGE_BYTES / 100);
		});
	});

	describe('serveBlockArchive pinned to an older revision (a historical restore)', () => {
		/**
		 * Two repos that both landed rev 1 (`one`, ACTION) and rev 2 (`two`, ACTION_2). The asker's
		 * `BlockStorage` restores through the server's `serveBlockArchive` — the production wiring,
		 * minus the transport — and has been made to FORGET rev 1 (`meta.ranges` trimmed to
		 * `[[2, 3]]`), which is exactly the state a historical read of rev 1 restores from.
		 */
		const askerForgettingRev1 = async () => {
			const server = makeRepo();
			const askerRaw = new MemoryRawStorage();
			const asker = new StorageRepo((blockId) => new BlockStorage(
				blockId, askerRaw, (id, rev) => serveBlockArchive(server.repo, id, rev)));
			for (const repo of [server.repo, asker]) {
				await landRevision(repo, { rev: 1, actionId: ACTION, block: makeBlock(BLOCK, 'one'), certified: true });
				await landRevision(repo, { rev: 2, actionId: ACTION_2, block: makeBlock(BLOCK, 'two'), certified: true });
			}
			const meta = (await askerRaw.getMetadata(BLOCK))!;
			expect(meta.latest).to.deep.equal({ rev: 2, actionId: ACTION_2 });
			meta.ranges = [[2, 3]];
			await askerRaw.saveMetadata(BLOCK, meta);
			return { server: server.repo, asker, askerRaw };
		};

		it('never overwrites a revision the asker already holds (the ticket\'s corruption)', async () => {
			// Before the fix the server answered a rev-1 request with rev 1's bytes under rev 2's
			// number and action id, and the asker's `saveRestored` — keyed by action id — wrote those
			// bytes over its own good rev 2. Whatever the pinned read does (serve rev 1, or fail
			// loudly), rev 2 must be untouched afterwards.
			const { asker, askerRaw } = await askerForgettingRev1();

			await asker.get({ blockIds: [BLOCK], context: { rev: 1, committed: [] } });

			expect(await askerRaw.getMaterializedBlock(BLOCK, ACTION_2), 'rev 2\'s stored bytes are still rev 2\'s')
				.to.deep.equal(makeBlock(BLOCK, 'two'));
			const latest = (await asker.get({ blockIds: [BLOCK] }))[BLOCK]!;
			expect(latest.block, 'and rev 2 still reads back as rev 2').to.deep.equal(makeBlock(BLOCK, 'two'));
			expect(latest.state.latest).to.deep.equal({ rev: 2, actionId: ACTION_2 });
		});

		it('lands the requested revision, labelled as itself, beside the one already held', async () => {
			const { server, asker, askerRaw } = await askerForgettingRev1();

			// What goes over the wire: rev 1, as rev 1.
			const archive = (await serveBlockArchive(server, BLOCK, 1))!;
			expect(archive.range).to.deep.equal([1, 2]);
			expect(soleEntry(archive).action.actionId).to.equal(ACTION);
			expect(soleEntry(archive).block).to.deep.equal(makeBlock(BLOCK, 'one'));

			// What the asker ends up with: rev 1's content on a rev-1 read, rev 1 recorded as held.
			const pinned = (await asker.get({ blockIds: [BLOCK], context: { rev: 1, committed: [] } }))[BLOCK]!;
			expect(pinned.block, 'the pinned read serves rev 1').to.deep.equal(makeBlock(BLOCK, 'one'));
			expect('unavailable' in pinned, 'a restored revision is a real answer').to.equal(false);
			expect(pinned.state.latest, 'state.latest keeps meaning the newest held').to.deep.equal({ rev: 2, actionId: ACTION_2 });
			expect(pinned.materialized, 'the result says which revision its bytes actually are').to.deep.equal({ rev: 1, actionId: ACTION });
			expect((await askerRaw.getMetadata(BLOCK))!.ranges, 'rev 1 is now recorded as held').to.deep.equal([[1, 3]]);
			expect(await askerRaw.getMaterializedBlock(BLOCK, ACTION), 'stored under its OWN action id')
				.to.deep.equal(makeBlock(BLOCK, 'one'));
		});

		it('serves nothing rather than a mislabel when the repo cannot say what it materialized', async () => {
			// A plain `IRepo` that reports no materialized revision can only be describing its latest.
			// Asked for a revision BELOW that latest, the honest answer is "cannot serve" — the content
			// may be pinned or may not, and either way the only label available would be wrong for
			// one of them. Asked for its latest or anything above it, the latest IS the highest
			// committed revision at or below the pin, so it is served exactly as before.
			const latest: ActionRev = { actionId: ACTION, rev: 4 };
			const plain = { get: async () => ({ [BLOCK]: { block: makeBlock(), state: { latest } } }) } as unknown as ArchiveServingRepo;

			expect(await serveBlockArchive(plain, BLOCK, 2), 'below latest: refused').to.equal(undefined);
			for (const requested of [undefined, 4, 7]) {
				const archive = (await serveBlockArchive(plain, BLOCK, requested))!;
				expect(archive.range, `requested ${requested}: latest is at or below the pin`).to.deep.equal([4, 5]);
				expect(soleEntry(archive).action.actionId).to.equal(ACTION);
			}
		});
	});

	describe('servableProof', () => {
		it('returns the retained proof, and undefined where none was retained', async () => {
			const { repo } = makeRepo();
			const proof = await landRevision(repo, { rev: 1, actionId: ACTION, block: makeBlock(), certified: true });
			expect(await servableProof(repo, BLOCK, { actionId: ACTION, rev: 1 })).to.deep.equal(proof);
			expect(await servableProof(repo, BLOCK, { actionId: ACTION, rev: 2 })).to.equal(undefined);
			expect(await servableProof(repo, OTHER_BLOCK, { actionId: ACTION, rev: 1 })).to.equal(undefined);
		});

		it('StorageRepo.getBlockProof is the raw accessor behind it', async () => {
			const { repo } = makeRepo();
			const proof = await landRevision(repo, { rev: 1, actionId: ACTION, block: makeBlock(), certified: true });
			expect(await repo.getBlockProof(BLOCK, 1)).to.deep.equal(proof);
			expect(await repo.getBlockProof(BLOCK, 2)).to.equal(undefined);
			expect(await repo.getBlockProof('never-committed' as BlockId, 1)).to.equal(undefined);
		});
	});

	describe('latestClaimFromArchive', () => {
		const archiveWith = (rev: number, actionId: ActionId, proof?: BlockCommitProof): BlockArchive =>
			singleRevisionArchive(BLOCK, { actionId, rev }, makeBlock(), proof);

		it('projects the claim with the proof from the SAME revision entry', async () => {
			const { proof } = await makeSignedProof(3, makeCommit({ rev: 7 }));
			expect(latestClaimFromArchive(archiveWith(7, ACTION, proof)))
				.to.deep.equal({ actionId: ACTION, rev: 7, proof });
		});

		it('projects a bare claim when the entry carries no proof', () => {
			const claim = latestClaimFromArchive(archiveWith(3, ACTION));
			expect(claim).to.deep.equal({ actionId: ACTION, rev: 3 });
			expect('proof' in claim!, 'no proof key, matching the pre-proof answer').to.equal(false);
		});

		it('takes the highest revision, with that revision\'s own proof', async () => {
			const low = await makeSignedProof(3, makeCommit({ rev: 1 }));
			const high = await makeSignedProof(3, makeCommit({ rev: 5, actionId: 'action-5' as ActionId }));
			const multi: BlockArchive = {
				blockId: BLOCK,
				revisions: {
					1: { action: { actionId: ACTION, transform: {} }, proof: low.proof },
					5: { action: { actionId: 'action-5' as ActionId, transform: {} }, proof: high.proof }
				},
				range: [1, 6]
			};
			expect(latestClaimFromArchive(multi)).to.deep.equal({ actionId: 'action-5' as ActionId, rev: 5, proof: high.proof });
		});

		it('answers undefined for an archive with nothing usable — an absent claim, never silence', () => {
			expect(latestClaimFromArchive({ blockId: BLOCK, revisions: {}, range: [0, 0] })).to.equal(undefined);
			expect(latestClaimFromArchive({
				blockId: BLOCK, revisions: { 1: {} as any }, range: [1, 2]
			})).to.equal(undefined);
			expect(latestClaimFromArchive({ blockId: BLOCK, range: [0, 0] } as unknown as BlockArchive)).to.equal(undefined);
		});

		it('folds a hostilely WIDE archive instead of spreading it into Math.max', async function () {
			// A remote peer chooses this archive's width. `Math.max(...keys)` passes one ARGUMENT per
			// revision and throws `RangeError: Maximum call stack size exceeded` past ~125k of them, so
			// a peer could otherwise decide to make the projection throw -- which the read path counts
			// as SILENCE from that peer rather than an answer. 130k entries is chosen because it is
			// over that limit and, as the assertion below measures, still inside the 8 MiB a sync
			// response may carry, i.e. reachable without breaking any other protocol rule.
			this.timeout(20_000);
			const revisions: BlockArchive['revisions'] = {};
			for (let rev = 0; rev < 130_000; rev++) {
				revisions[rev] = { action: { actionId: `a-${rev}` as ActionId, transform: {} } };
			}
			const wide: BlockArchive = { blockId: BLOCK, revisions, range: [0, 130_000] };
			expect(JSON.stringify(wide).length, 'the width must be reachable within the response cap')
				.to.be.lessThan(MAX_BLOCK_MESSAGE_BYTES);

			expect(latestClaimFromArchive(wide)).to.deep.equal({ actionId: 'a-129999' as ActionId, rev: 129_999 });
		});

		it('survives a JSON round trip and ignores unknown fields from a newer peer', async () => {
			// Both compatibility directions in one: an unknown key on the archive (what an upgraded
			// peer's extra field looks like to any reader) is carried through JSON and simply not read,
			// and a proof-less archive (what an un-upgraded peer serves) projects the same claim it
			// always did. Neither side has a schema that rejects unknown fields — the sync protocol is
			// plain `JSON.parse`.
			const { proof } = await makeSignedProof(3, makeCommit({ rev: 2 }));
			const forward = JSON.parse(JSON.stringify({
				...archiveWith(2, ACTION, proof), somethingNewer: { nested: true }
			})) as BlockArchive;
			expect(latestClaimFromArchive(forward)).to.deep.equal({ actionId: ACTION, rev: 2, proof });

			const legacy = JSON.parse(JSON.stringify(archiveWith(2, ACTION))) as BlockArchive;
			expect(latestClaimFromArchive(legacy)).to.deep.equal({ actionId: ACTION, rev: 2 });
		});
	});

	describe('a real cohort commit, end to end through the mesh harness', () => {
		let mesh: Mesh;

		afterEach(async () => {
			// createMesh nodes hold no timers of their own here; nothing to tear down beyond the ref.
			mesh = undefined as unknown as Mesh;
		});

		it('every responsible node retains a verifiable proof and serves it on the repair wire', async () => {
			mesh = await createMesh(3, { responsibilityK: 3, clusterSize: 3 });
			const blockId = 'mesh-certified-block';
			const block = makeBlock(blockId as BlockId);
			const actionId = 'mesh-action-1';

			const pended = await mesh.nodes[0]!.coordinatorRepo.pend({
				actionId, transforms: { inserts: { [blockId]: block }, updates: {}, deletes: [] }, policy: 'c'
			});
			expect(pended.success, 'mesh pend must land').to.equal(true);

			// `blockDigests` is what a real client declares (`computeBlockContentDigests`), and it is
			// the input the retention rule checks the local materialization against. A commit without
			// it is the pre-upgrade case, which retains nothing.
			const committed = await mesh.nodes[0]!.coordinatorRepo.commit({
				actionId, tailId: blockId as BlockId, rev: 1, blockIds: [blockId],
				blockDigests: { [blockId]: { digest: await canonicalBlockHash(block) } }
			});
			expect(committed.success, `mesh commit must land: ${JSON.stringify(committed)}`).to.equal(true);

			let holders = 0;
			for (const node of mesh.nodes) {
				const archive = await serveBlockArchive(node.storageRepo, blockId);
				if (!archive) continue;
				holders++;
				const entry = soleEntry(archive);
				expect(entry.proof, `node ${node.peerId.toString()} must serve a proof`).to.not.equal(undefined);
				const verdict = await verifyBlockCommitProofClaim(
					entry.proof!, { blockId: blockId as BlockId, rev: 1, actionId: actionId as ActionId }, PROOF_THRESHOLDS);
				expect(verdict.ok, `served proof must verify: ${JSON.stringify(verdict)}`).to.equal(true);

				// The latest-consult and the archive wire must attach the SAME proof — the harness's
				// consult callback and `serveBlockArchive` share one lookup precisely so a mesh test
				// can never exercise a certification path a real peer does not have.
				const latest = { actionId: actionId as ActionId, rev: 1 };
				expect(await servableProof(node.storageRepo, blockId as BlockId, latest)).to.deep.equal(entry.proof);
			}
			expect(holders, 'the cohort must actually hold the block').to.be.greaterThan(0);
		});
	});
});
