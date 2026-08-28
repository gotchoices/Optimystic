import { expect } from 'chai';
import { canonicalBlockHash } from '@optimystic/db-core';
import type { ActionId, BlockHeader, BlockId, CommitRequest, GetBlockResult, IBlock } from '@optimystic/db-core';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import type { ArchiveServingRepo } from '../src/storage/block-archive.js';
import type { BlockCommitProof } from '../src/cluster/commit-proof.js';
import { sourceBlockCertification } from '../src/cluster/block-transfer-service.js';
import { makeSignedProof } from './support/commit-proof-fixtures.js';

/**
 * Ticket: backfill-proof-on-held-revision (Arm 3 — the producer side had no direct coverage).
 *
 * `sourceBlockCertification` is what a PUSHING node attaches to a block it sends: the revision
 * metadata `(rev, actionId)` it claims, plus the cohort commit proof it retained for exactly that
 * revision. Its one guarantee is that those two halves always describe the SAME revision — a proof
 * beside metadata for a different revision is an artifact every receiver would reject, and a
 * receiver running the default `requirePushCertificate: true` refuses a block whose halves do not
 * line up.
 *
 * Every other test reaches it through a push. This one calls it directly and pins its four
 * outcomes, plus the two ways it fails closed:
 *
 *   - the source holds no `latest` for the block → `{}` (nothing to claim);
 *   - the source read the block PINNED at a revision other than `latest` → `{}` (the content in
 *     hand is not the content `latest` names, so labelling it would mislead the receiver);
 *   - the source holds `latest` but retained no proof → metadata only (the pre-proof push: still
 *     useful to a migrating receiver, still refused by a strict one);
 *   - the source holds `latest` AND a matching proof → both halves.
 *
 * Failing closed on the proof half (a stored proof whose message names a different commit; a repo
 * with no proof accessor at all) must degrade to metadata-only — never to a mis-paired attachment,
 * and never to dropping the metadata as well.
 */

const BLOCK = 'src-cert-block' as BlockId;

const makeBlock = (marker = 'x'): IBlock => ({
	header: { id: BLOCK, type: 'test', collectionId: 'col-1' as BlockId } as BlockHeader,
	marker
} as unknown as IBlock);

const makeRepo = (): StorageRepo => {
	// One raw store shared across every BlockStorage, as a real node has.
	const raw = new MemoryRawStorage();
	return new StorageRepo((id) => new BlockStorage(id, raw));
};

/** The cohort proof a genuine holder retained for `(BLOCK, rev, actionId)` over exactly `block`. */
const certify = async (block: IBlock, rev: number, actionId: string): Promise<BlockCommitProof> => {
	const commit: CommitRequest = {
		actionId: actionId as ActionId,
		blockIds: [BLOCK],
		tailId: BLOCK,
		rev,
		blockDigests: { [BLOCK]: { digest: await canonicalBlockHash(block) } }
	};
	const { proof } = await makeSignedProof(4, commit);
	return proof;
};

/** The unpinned read a producer performs before certifying — the input the two push sites pass. */
const readFor = async (repo: StorageRepo): Promise<GetBlockResult | undefined> =>
	(await repo.get({ blockIds: [BLOCK] }))[BLOCK];

describe('sourceBlockCertification (what a pushing node attaches)', () => {
	it('returns nothing when the source holds no latest for the block', async () => {
		const repo = makeRepo();

		// Both shapes a caller can produce for "I hold nothing": no entry at all, and an entry
		// whose state carries no latest.
		expect(await sourceBlockCertification(repo, BLOCK, undefined),
			'no read result ⇒ nothing to claim').to.deep.equal({});
		expect(await sourceBlockCertification(repo, BLOCK, await readFor(repo)),
			'a repo that never saw the block ⇒ nothing to claim').to.deep.equal({});
		expect(await sourceBlockCertification(repo, BLOCK, { state: {} } as GetBlockResult),
			'state present but no latest ⇒ nothing to claim').to.deep.equal({});
	});

	it('returns nothing for a PINNED read of a revision other than latest', async () => {
		// The content in hand is rev 3's; `latest` is rev 4. Attaching rev 4's metadata would label
		// the pushed bytes as a revision they are not — so neither half is attached, proof included.
		const repo = makeRepo();
		const block = makeBlock();
		const source = { rev: 4, actionId: 'a4' as ActionId };
		await repo.saveReplicatedBlock(BLOCK, block, source, await certify(block, 4, 'a4'));

		const pinned = { state: { latest: source }, materializedRev: 3 } as GetBlockResult;

		expect(await sourceBlockCertification(repo, BLOCK, pinned),
			'a pinned read is never labelled with latest').to.deep.equal({});
	});

	it('attaches metadata for an unpinned read that happens to sit at latest', async () => {
		// The benign counterpart of the test above: `materializedRev` IS `latest.rev`, so the read is
		// describing the revision it claims and both halves travel.
		const repo = makeRepo();
		const block = makeBlock();
		const source = { rev: 4, actionId: 'a4' as ActionId };
		const proof = await certify(block, 4, 'a4');
		await repo.saveReplicatedBlock(BLOCK, block, source, proof);

		const atLatest = { state: { latest: source }, materializedRev: 4 } as GetBlockResult;
		const certification = await sourceBlockCertification(repo, BLOCK, atLatest);

		expect(certification.blockMeta).to.deep.equal({ [BLOCK]: source });
		expect(certification.blockProofs?.[BLOCK]).to.deep.equal(proof);
	});

	it('attaches metadata only when the source retained no proof (the pre-proof push)', async () => {
		const repo = makeRepo();
		const source = { rev: 2, actionId: 'a2' as ActionId };
		await repo.saveReplicatedBlock(BLOCK, makeBlock(), source);

		const certification = await sourceBlockCertification(repo, BLOCK, await readFor(repo));

		expect(certification.blockMeta, 'the revision claim still travels').to.deep.equal({ [BLOCK]: source });
		expect(certification.blockProofs, 'nothing to attach').to.equal(undefined);
	});

	it('attaches both halves when the source retained a proof for exactly that revision', async () => {
		const repo = makeRepo();
		const block = makeBlock();
		const source = { rev: 6, actionId: 'a6' as ActionId };
		const proof = await certify(block, 6, 'a6');
		await repo.saveReplicatedBlock(BLOCK, block, source, proof);

		const certification = await sourceBlockCertification(repo, BLOCK, await readFor(repo));

		expect(certification.blockMeta).to.deep.equal({ [BLOCK]: source });
		expect(certification.blockProofs?.[BLOCK],
			'the retained proof is what gets attached, unchanged').to.deep.equal(proof);
	});

	it('degrades to metadata only when the stored proof names a different commit', async () => {
		// A local storage-integrity fault: a proof written under a key its own message contradicts.
		// `servableProof`'s `proofClaimsCommit` guard catches it, so the push goes out uncertified
		// (and is refused by a strict receiver) instead of carrying an artifact that cannot verify.
		const repo = makeRepo();
		const block = makeBlock();
		const source = { rev: 5, actionId: 'a5' as ActionId };
		// The proof is for the same rev under a DIFFERENT action — stored against rev 5 regardless.
		await repo.saveReplicatedBlock(BLOCK, block, source, await certify(block, 5, 'someone-else'));

		expect(await repo.getBlockProof(BLOCK, 5), 'precondition: the mis-paired proof IS stored')
			.to.not.equal(undefined);

		const certification = await sourceBlockCertification(repo, BLOCK, await readFor(repo));

		expect(certification.blockMeta, 'the claim is still honest').to.deep.equal({ [BLOCK]: source });
		expect(certification.blockProofs, 'a mis-paired artifact is never pushed').to.equal(undefined);
	});

	it('degrades to metadata only for a serving repo with no proof accessor at all', async () => {
		// A plain `IRepo` — an un-upgraded embedder or a test double. Absence of the accessor must
		// read as "no proof", not as a fault.
		const source = { rev: 3, actionId: 'a3' as ActionId };
		const plain = {
			get: async () => ({ [BLOCK]: { block: makeBlock(), state: { latest: source } } })
		} as unknown as ArchiveServingRepo;

		const read = (await plain.get({ blockIds: [BLOCK] }))[BLOCK];
		const certification = await sourceBlockCertification(plain, BLOCK, read);

		expect(certification.blockMeta).to.deep.equal({ [BLOCK]: source });
		expect(certification.blockProofs).to.equal(undefined);
	});

	it('degrades to metadata only when the proof lookup throws', async () => {
		// A storage fault must not turn a servable claim into "I hold nothing" — that is the
		// phantom-non-holder failure the archive shape exists to prevent.
		const source = { rev: 3, actionId: 'a3' as ActionId };
		const faulty = {
			get: async () => ({ [BLOCK]: { block: makeBlock(), state: { latest: source } } }),
			getBlockProof: async () => { throw new Error('disk read failed'); }
		} as unknown as ArchiveServingRepo;

		const read = (await faulty.get({ blockIds: [BLOCK] }))[BLOCK];
		const certification = await sourceBlockCertification(faulty, BLOCK, read);

		expect(certification.blockMeta, 'the claim survives a proof-lookup fault')
			.to.deep.equal({ [BLOCK]: source });
		expect(certification.blockProofs).to.equal(undefined);
	});
});
