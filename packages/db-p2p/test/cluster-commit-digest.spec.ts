import { expect } from 'chai';
import { clusterMember, CONTENT_DIGEST_MISMATCH } from '../src/cluster/cluster-repo.js';
import { StorageRepo, type CommitDigestPreview } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { IRepo, ClusterRecord, RepoMessage, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, ClusterPeers, BlockId, ActionId, BlockContentDigests, IBlock } from '@optimystic/db-core';
import type { IPeerNetwork } from '@optimystic/db-core';
import { canonicalBlockHash, computeBlockContentDigests, Tracker } from '@optimystic/db-core';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { sha256 } from 'multiformats/hashes/sha2';
import { base58btc } from 'multiformats/bases/base58';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';

// ─── Harness (mirrors cluster-membership-admission.spec.ts: clusterMember factory + mock repo +
// v1 record driven through member.update, vote read from record.promises[self]) ───

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

interface KeyPair { peerId: PeerId; privateKey: PrivateKey; }

const makeKeyPair = async (): Promise<KeyPair> => {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
};

const computeMessageHash = async (message: RepoMessage): Promise<string> => {
	const hashBytes = await sha256.digest(new TextEncoder().encode(canonicalJson(message)));
	return base58btc.encode(hashBytes.digest);
};

const makeClusterPeers = (keyPairs: KeyPair[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const { peerId } of keyPairs) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: uint8ArrayToString(peerId.publicKey!.raw, 'base64url')
		};
	}
	return peers;
};

const BLOCK = 'block-1' as BlockId;
const ACTION = 'action-1' as ActionId;

/** A fresh v1 commit record (no promises/commits) for one commit operation. */
const makeCommitRecord = async (peers: ClusterPeers, commit: CommitRequest): Promise<ClusterRecord> => {
	const message: RepoMessage = {
		operations: [{ commit }],
		coordinatingBlockIds: [commit.blockIds[0] ?? BLOCK],
		expiration: Date.now() + 30000
	};
	const messageHash = await computeMessageHash(message);
	return {
		messageHash,
		message,
		peers,
		promises: {},
		commits: {}
	};
};

const makeCommit = (blockDigests?: BlockContentDigests, over: Partial<CommitRequest> = {}): CommitRequest => ({
	actionId: ACTION,
	blockIds: [BLOCK],
	tailId: BLOCK,
	rev: 2,
	...(blockDigests ? { blockDigests } : {}),
	...over
});

class MockRepo implements IRepo {
	async get(_blockGets: BlockGets): Promise<GetBlockResults> { return {}; }
	async pend(_request: PendRequest): Promise<PendResult> { return { success: true, blockIds: [], pending: [] }; }
	async commit(_request: CommitRequest): Promise<CommitResult> { return { success: true }; }
	async cancel(_actionRef: ActionBlocks): Promise<void> { /* no-op */ }
}

/** MockRepo extended with the duck-typed preview capability the member probes for. */
class PreviewRepo extends MockRepo {
	constructor(private readonly previews: Record<string, CommitDigestPreview | undefined>) { super(); }
	async previewCommitDigest(blockId: BlockId, _actionId: ActionId, _rev: number): Promise<CommitDigestPreview | undefined> {
		return this.previews[blockId];
	}
}

class ThrowingPreviewRepo extends MockRepo {
	async previewCommitDigest(): Promise<CommitDigestPreview | undefined> {
		throw new Error('injected preview fault');
	}
}

class MockPeerNetwork implements IPeerNetwork {
	async connect(_peerId: PeerId, _protocol: string): Promise<any> { return {}; }
}

/**
 * Drive `record` through a fresh member backed by `repo` and return the member's own promise vote.
 * Two declared peers (superMajority 2) keep the record in the Promising phase after our single
 * vote, so consensus never executes and only the promise-round check is exercised. No
 * consensusConfig: the admission gate takes its legacy approve path (as many other specs rely on).
 */
const voteOnCommit = async (
	repo: IRepo,
	commit: CommitRequest
): Promise<{ type: string; rejectReason?: string }> => {
	const self = await makeKeyPair();
	const other = await makeKeyPair();
	const member = clusterMember({
		storageRepo: repo,
		peerNetwork: new MockPeerNetwork(),
		peerId: self.peerId,
		privateKey: self.privateKey
	});
	try {
		const record = await makeCommitRecord(makeClusterPeers([self, other]), commit);
		const result = await member.update(record);
		const sig = result.promises[self.peerId.toString()];
		return { type: sig?.type ?? 'none', rejectReason: sig?.type === 'reject' ? sig.rejectReason : undefined };
	} finally {
		member.dispose();
	}
};

describe('ClusterMember — commit content-digest check (promise round)', () => {
	describe('abstain paths (member approves exactly as before the check existed)', () => {
		it('a repo without previewCommitDigest abstains everywhere (back-compat, mock-repo harnesses)', async () => {
			const vote = await voteOnCommit(new MockRepo(), makeCommit({ [BLOCK]: { digest: 'declared-digest' } }));
			expect(vote.type).to.equal('approve');
		});

		it('a commit carrying no blockDigests validates nothing', async () => {
			// The preview would mismatch if consulted; with nothing declared, it never is.
			const repo = new PreviewRepo({ [BLOCK]: { digest: 'local-digest', baseIndependent: true } });
			const vote = await voteOnCommit(repo, makeCommit());
			expect(vote.type).to.equal('approve');
		});

		it('a member that never saw the pend abstains (preview undefined), never rejects', async () => {
			const repo = new PreviewRepo({ [BLOCK]: undefined });
			const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'declared-digest' } }));
			expect(vote.type).to.equal('approve');
		});

		it('a transform that materializes nothing (tombstone / no base / unmaterializable base) abstains', async () => {
			const repo = new PreviewRepo({ [BLOCK]: { digest: undefined, baseRev: 1, baseIndependent: false } });
			const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'declared-digest', baseRev: 1 } }));
			expect(vote.type).to.equal('approve');
		});

		it('a lagging member abstains on an update-only block whose base rev differs from the declared one', async () => {
			// The case that makes the scheme safe to turn on: this member holds rev 5 while the
			// declarer computed from rev 4 — the bytes legitimately differ, so no judgement is cast.
			const repo = new PreviewRepo({ [BLOCK]: { digest: 'local-digest', baseRev: 5, baseIndependent: false } });
			const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'declared-digest', baseRev: 4 } }));
			expect(vote.type).to.equal('approve');
		});

		it('an update-only declaration with no baseRev is not checkable (a dodge attempt only abstains)', async () => {
			const repo = new PreviewRepo({ [BLOCK]: { digest: 'local-digest', baseRev: 4, baseIndependent: false } });
			const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'declared-digest' } }));
			expect(vote.type).to.equal('approve');
		});

		it('a surplus digest for a block the commit does not cover is ignored, even when it mismatches', async () => {
			const surplus = 'block-not-committed' as BlockId;
			const repo = new PreviewRepo({
				[BLOCK]: { digest: 'same-digest', baseIndependent: true },
				[surplus]: { digest: 'local-digest', baseIndependent: true }
			});
			const vote = await voteOnCommit(repo, makeCommit({
				[BLOCK]: { digest: 'same-digest' },
				[surplus]: { digest: 'hostile-mismatch' }
			}));
			expect(vote.type).to.equal('approve');
		});

		it('a throwing preview is an abstain, never a rejection or an escape out of the vote path', async () => {
			const vote = await voteOnCommit(new ThrowingPreviewRepo(), makeCommit({ [BLOCK]: { digest: 'declared-digest' } }));
			expect(vote.type).to.equal('approve');
		});

		// `blockDigests` is untrusted wire data and nothing validates its shape on ingress, so a
		// checkable member must survive an entry that is not the shape the type promises. Reading
		// through one would throw out of the vote path — the member would then fail to vote at all,
		// which is worse than either verdict.
		for (const [label, entry] of [
			['null', null],
			['undefined', undefined],
			['a non-object', 'just-a-string'],
			['an object with no digest', {}],
			['an object with a non-string digest', { digest: 42 }]
		] as const) {
			it(`a malformed declaration (${label}) abstains instead of throwing out of the vote path`, async () => {
				const repo = new PreviewRepo({ [BLOCK]: { digest: 'local-digest', baseIndependent: true } });
				const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: entry } as unknown as BlockContentDigests));
				expect(vote.type).to.equal('approve');
			});
		}

		it('a non-numeric declared baseRev is not checkable on an update-only block', async () => {
			const repo = new PreviewRepo({ [BLOCK]: { digest: 'local-digest', baseRev: 4, baseIndependent: false } });
			const vote = await voteOnCommit(repo, makeCommit(
				{ [BLOCK]: { digest: 'declared-digest', baseRev: '4' } } as unknown as BlockContentDigests));
			expect(vote.type).to.equal('approve');
		});
	});

	describe('checkable paths', () => {
		it('approves an update-only block when base rev and digest both agree', async () => {
			const repo = new PreviewRepo({ [BLOCK]: { digest: 'same-digest', baseRev: 4, baseIndependent: false } });
			const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'same-digest', baseRev: 4 } }));
			expect(vote.type).to.equal('approve');
		});

		it('rejects an update-only block whose base rev agrees but digest does not', async () => {
			const repo = new PreviewRepo({ [BLOCK]: { digest: 'local-digest', baseRev: 4, baseIndependent: false } });
			const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'declared-digest', baseRev: 4 } }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(CONTENT_DIGEST_MISMATCH);
		});

		it('rejects a base-independent mismatch regardless of what baseRev the declarer wrote', async () => {
			// The member's OWN transform decides base-independence, so a hostile declarer can neither
			// dodge the check by omitting baseRev nor force an abstain by mis-declaring it.
			const repo = new PreviewRepo({ [BLOCK]: { digest: 'local-digest', baseIndependent: true } });

			const omitted = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'declared-digest' } }));
			expect(omitted.type, 'baseRev omitted').to.equal('reject');
			expect(omitted.rejectReason).to.equal(CONTENT_DIGEST_MISMATCH);

			const misDeclared = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'declared-digest', baseRev: 999 } }));
			expect(misDeclared.type, 'baseRev mis-declared').to.equal('reject');
			expect(misDeclared.rejectReason).to.equal(CONTENT_DIGEST_MISMATCH);
		});

		it('approves a base-independent match even with a bogus declared baseRev', async () => {
			const repo = new PreviewRepo({ [BLOCK]: { digest: 'same-digest', baseIndependent: true } });
			const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'same-digest', baseRev: 999 } }));
			expect(vote.type).to.equal('approve');
		});

		it('rejects the whole record when any one block of a multi-block commit mismatches', async () => {
			// The vote is per-record, not per-block: a mismatch anywhere past the first declared id
			// must still be reached and must still sink the record.
			const other = 'block-2' as BlockId;
			const repo = new PreviewRepo({
				[BLOCK]: { digest: 'same-digest', baseIndependent: true },
				[other]: { digest: 'local-digest', baseIndependent: true }
			});
			const vote = await voteOnCommit(repo, makeCommit(
				{ [BLOCK]: { digest: 'same-digest' }, [other]: { digest: 'declared-digest' } },
				{ blockIds: [BLOCK, other] }
			));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(CONTENT_DIGEST_MISMATCH);
		});

		it('approves a multi-block commit when every declared block matches', async () => {
			const other = 'block-2' as BlockId;
			const repo = new PreviewRepo({
				[BLOCK]: { digest: 'digest-a', baseIndependent: true },
				[other]: { digest: 'digest-b', baseIndependent: true }
			});
			const vote = await voteOnCommit(repo, makeCommit(
				{ [BLOCK]: { digest: 'digest-a' }, [other]: { digest: 'digest-b' } },
				{ blockIds: [BLOCK, other] }
			));
			expect(vote.type).to.equal('approve');
		});
	});

	describe('against a real StorageRepo seeded via pend', () => {
		const insertBlock = (): IBlock => ({
			header: { id: BLOCK, type: 'test', collectionId: 'collection-1' as BlockId },
			items: ['x']
		} as unknown as IBlock);

		const seededRepo = async (): Promise<StorageRepo> => {
			const rawStorage = new MemoryRawStorage();
			const repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
			const pended = await repo.pend({
				actionId: ACTION,
				transforms: { inserts: { [BLOCK]: insertBlock() }, updates: {}, deletes: [] },
				policy: 'c'
			});
			expect(pended.success, 'seed pend must land').to.equal(true);
			return repo;
		};

		it('approves when the declared digest matches what the pended insert materializes', async () => {
			const repo = await seededRepo();
			const digest = await canonicalBlockHash(insertBlock());
			const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest } }, { rev: 1 }));
			expect(vote.type).to.equal('approve');
		});

		it('rejects a tampered declaration with the signed CONTENT_DIGEST_MISMATCH reason', async () => {
			const repo = await seededRepo();
			const vote = await voteOnCommit(repo, makeCommit({ [BLOCK]: { digest: 'tampered-declaration' } }, { rev: 1 }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(CONTENT_DIGEST_MISMATCH);
		});

		/**
		 * The update-only path end to end: the declaration is produced by the REAL client-side helper
		 * (`computeBlockContentDigests` over a `Tracker`, exactly as `Collection.sync` and the
		 * coordinator's commit phase call it) and checked by the REAL member-side preview. This is the
		 * pairing a false reject would come from — the two sides materialize the same block through
		 * different code (a cached base + staged ops on the client, stored base + pended transform on
		 * the member), and only a test that runs both catches them drifting apart.
		 */
		const declareLikeAClient = async (base: IBlock, baseRev: number, updates: unknown[]) => {
			const source = {
				peek: (id: BlockId) => id === BLOCK ? structuredClone(base) : undefined,
				getCachedRevision: (id: BlockId) => id === BLOCK ? baseRev : undefined
			};
			const tracker = new Tracker(source as never, { inserts: {}, updates: { [BLOCK]: updates as never }, deletes: [] });
			return await computeBlockContentDigests(tracker, [BLOCK]);
		};

		/** Repo holding BLOCK committed at rev 1, with an update to it pended under `update-action`. */
		const seededWithCommittedBase = async (updates: unknown[]) => {
			const repo = await seededRepo();
			expect((await repo.commit({ actionId: ACTION, blockIds: [BLOCK], tailId: BLOCK, rev: 1 })).success).to.equal(true);
			const pended = await repo.pend({
				actionId: 'update-action' as ActionId,
				transforms: { inserts: {}, updates: { [BLOCK]: updates as never }, deletes: [] },
				rev: 2,
				policy: 'c'
			});
			expect(pended.success, 'update pend must land').to.equal(true);
			const committedBase = (await repo.get({ blockIds: [BLOCK] }))[BLOCK]?.block;
			expect(committedBase, 'the committed base must be readable').to.not.equal(undefined);
			return { repo, committedBase: committedBase! };
		};

		it('approves an update declared by the real client helper against the same base revision', async () => {
			const updates = [['items', 1, 0, ['y']]];
			const { repo, committedBase } = await seededWithCommittedBase(updates);
			const blockDigests = await declareLikeAClient(committedBase, 1, updates);
			expect(blockDigests[BLOCK]?.baseRev, 'the client declares the base it computed from').to.equal(1);

			const vote = await voteOnCommit(repo, makeCommit(blockDigests, { actionId: 'update-action' as ActionId, rev: 2 }));
			expect(vote.type, 'client and member must materialize identically').to.equal('approve');
		});

		it('rejects when the client declares a base revision it agrees on but content it does not', async () => {
			const { repo, committedBase } = await seededWithCommittedBase([['items', 1, 0, ['y']]]);
			// Same declared baseRev (so the member considers itself checkable) but a digest computed
			// from DIFFERENT staged ops than the ones actually pended.
			const blockDigests = await declareLikeAClient(committedBase, 1, [['items', 1, 0, ['z']]]);

			const vote = await voteOnCommit(repo, makeCommit(blockDigests, { actionId: 'update-action' as ActionId, rev: 2 }));
			expect(vote.type).to.equal('reject');
			expect(vote.rejectReason).to.equal(CONTENT_DIGEST_MISMATCH);
		});

		it('abstains when the client declares a base revision this member does not hold', async () => {
			const updates = [['items', 1, 0, ['y']]];
			const { repo, committedBase } = await seededWithCommittedBase(updates);
			// A digest computed from a base the client believes is rev 7 while this member holds rev 1:
			// legitimately different bytes, so the member must cast no content judgement at all.
			const blockDigests = await declareLikeAClient(committedBase, 7, updates);

			const vote = await voteOnCommit(repo, makeCommit(blockDigests, { actionId: 'update-action' as ActionId, rev: 2 }));
			expect(vote.type).to.equal('approve');
		});
	});
});
