/**
 * Tickets: p2p-read-repair-verify-peer-claims (fix of p2p-read-repair-unverified-peer-claims),
 * certified-claims-read-repair (from accept-certified-claims-in-repair).
 *
 * `queryClusterForLatest` used to take the MAX ActionRev any single peer reported,
 * with no quorum check — so a lone lying peer over-reporting its revision steered
 * restoration. It now accepts the highest `(rev, actionId)` corroborated by a
 * quorum of distinct peers, OR a claim whose attached cohort commit proof verifies
 * (`certifyClaim` in `cluster/certified-claims.ts`): a certified claim needs no
 * second voter, because the cohort's signature set is its corroboration. These
 * specs pin both selection rules and the penalty discipline around them:
 *   - a single lying peer is outvoted (no restore against the lie) but NOT
 *     penalized — an uncorroborated higher rev can be honest leadership, so the
 *     affirmative penalty needs proof-level evidence (see the CERTIFIED suite);
 *   - independent minority liars are outvoted,
 *   - an honest quorum-backed higher rev still drives restoration,
 *   - a lone honest (lagging) responder still restores when the cohort is small enough
 *     that it is the only peer that could corroborate (see
 *     `bug-read-repair-unrepairable-small-cluster`; the old unconditional
 *     "few responders all agree" fallback it used to ride is gone),
 *   - a lone holder with a VALID proof restores in any cohort size; proof failures
 *     are penalized only when attributable to the serving peer.
 *
 * NOTE: the quorum is corroboration-of-a-claim, NOT Sybil-resistant cohort
 * membership — colluding peers minting fresh keypairs onto the SAME fabricated
 * pair can still reach quorum, and a passing proof does not prove its signers are
 * the block's responsible cohort (anchoring the signer set to topology is the
 * observational-only ProofAnchoring layer, unwired in production — see backlog
 * `feat-cluster-membership-threshold-cert-anchoring`).
 */

import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev
} from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback, type CertifiedActionRev } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import type { IPeerReputation, PenaltyReason } from '../src/reputation/types.js';
import { toString as u8ToString } from 'uint8arrays';
import { makeSignedProof } from './support/commit-proof-fixtures.js';
import { captureLog, hasTag } from './support/capture-log.js';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

const makeClusterPeers = (peerIds: PeerId[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const peerId of peerIds) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: u8ToString(peerId.publicKey?.raw ?? new Uint8Array(), 'base64url')
		};
	}
	return peers;
};

const makeKeyNetwork = (cluster: ClusterPeers): IKeyNetwork => ({
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return { ...cluster };
	}
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

const makePresentStorageRepo = (blockId: BlockId, rev: number, actionId = 'local-action') => {
	const calls: BlockGets[] = [];
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			calls.push(blockGets);
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				result[id] = id === blockId ? { state: { latest: { actionId, rev } } } : { state: {} };
			}
			return result;
		},
		async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
			return { success: true, pending: [], blockIds: [] };
		},
		async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
		async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
			return { success: true };
		}
	};
	return { repo, calls };
};

/** Minimal reputation stub recording reportPeer calls. */
const makeReputationStub = () => {
	const reports: { peerId: string; reason: PenaltyReason }[] = [];
	const rep: IPeerReputation = {
		reportPeer(peerId, reason) { reports.push({ peerId, reason }); },
		recordSuccess() { },
		getScore() { return 0; },
		isBanned() { return false; },
		isDeprioritized() { return false; },
		getReputation() { return {} as any; },
		getAllReputations() { return new Map(); },
		resetPeer() { }
	};
	return { rep, reports };
};

/** The commit op a proof must cover to certify a `(blockId, rev, actionId)` claim. */
const makeCommit = (blockId: BlockId, rev: number, actionId: string): CommitRequest => ({
	actionId, blockIds: [blockId], tailId: blockId, rev
});

/**
 * A consult answer carrying a REAL cohort commit proof covering exactly this claim — signed by a
 * fresh 3-peer cohort, which suffices because verification checks the proof's internal consistency,
 * never that its signers are the block's cohort (that anchoring layer is observational-only).
 */
const certifiedAnswer = async (blockId: BlockId, rev: number, actionId: string): Promise<CertifiedActionRev> => {
	const { proof } = await makeSignedProof(3, makeCommit(blockId, rev, actionId));
	return { actionId, rev, proof };
};

describe('CoordinatorRepo read-repair TRUST (quorum-corroborated)', () => {
	const blockId: BlockId = 'block-trust';

	it('a single lying peer over-reporting rev is OUTVOTED — no restore against the lie, and no penalty either', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const liar = await makePeerId();
		const cluster = makeClusterPeers([localPeer, honestA, honestB, liar]);

		const honestLatest: ActionRev = { actionId: 'local-action', rev: 1 };
		const liarLatest: ActionRev = { actionId: 'bogus-action', rev: 99 };
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(liar) ? liarLatest : honestLatest;

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1, 'local-action');
		const { rep, reports } = makeReputationStub();

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 4, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback,
			rep
		);

		await repo.get({ blockIds: [blockId] });

		// The liar's inflated rev 99 must NOT have driven any restoration.
		const liarRestore = calls.find(c => c.context?.rev === 99);
		expect(liarRestore, 'liar must not steer restoration').to.equal(undefined);

		// Any restoration that did fire uses the honest quorum rev 1.
		const anyRestore = calls.find(c => c.context?.committed);
		if (anyRestore) {
			expect(anyRestore.context!.rev).to.equal(1);
			expect(anyRestore.context!.committed).to.deep.equal([honestLatest]);
		}

		// NOT penalized: a bare higher-rev claim is merely uncorroborated, not provably wrong — the
		// peer could honestly be ahead (in-flight commit, honest holders dropped by the consult
		// deadline). Outvoting it is the security property; the affirmative penalty needs proof-level
		// evidence (see the CERTIFIED suite).
		expect(reports, 'an uncorroborated higher rev alone must not be penalized').to.deep.equal([]);
	});

	it('independent minority liars (distinct fabricated pairs) are outvoted', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const liarX = await makePeerId();
		const liarY = await makePeerId();
		const cluster = makeClusterPeers([localPeer, honestA, honestB, liarX, liarY]);

		const honestLatest: ActionRev = { actionId: 'local-action', rev: 1 };
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			if (peerId.equals(liarX)) return { actionId: 'bogus-x', rev: 99 };
			if (peerId.equals(liarY)) return { actionId: 'bogus-y', rev: 98 };
			return honestLatest;
		};

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1, 'local-action');

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 5, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		await repo.get({ blockIds: [blockId] });

		expect(calls.find(c => c.context?.rev === 99), 'liarX must not steer restoration').to.equal(undefined);
		expect(calls.find(c => c.context?.rev === 98), 'liarY must not steer restoration').to.equal(undefined);
	});

	it('an honest quorum-backed HIGHER rev still drives restoration', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const lagging = await makePeerId();
		const cluster = makeClusterPeers([localPeer, honestA, honestB, lagging]);

		const newer: ActionRev = { actionId: 'action-5', rev: 5 };
		const stale: ActionRev = { actionId: 'local-action', rev: 1 };
		// honestA + honestB agree on rev 5; local + lagging are still on rev 1.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) =>
			(peerId.equals(honestA) || peerId.equals(honestB)) ? newer : stale;

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1, 'local-action');

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 4, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		await repo.get({ blockIds: [blockId] });

		const restore = calls.find(c => c.context?.rev === 5);
		expect(restore, 'quorum-backed rev 5 must drive restoration').to.not.equal(undefined);
		expect(restore!.context!.committed).to.deep.equal([newer]);
	});

	it('a lone honest (lagging) responder still restores when it is the only possible corroborator', async () => {
		const localPeer = await makePeerId();
		const otherPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, otherPeer]);

		const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
		// Only the other peer answers (local is missing/undefined here) — one honest responder,
		// and with clusterSize 2 it is the only peer that could ever corroborate.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(otherPeer) ? remoteLatest : undefined;

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1, 'local-action');

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 2, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		await repo.get({ blockIds: [blockId] });

		const restore = calls.find(c => c.context?.rev === 2);
		expect(restore, 'single honest responder must still restore').to.not.equal(undefined);
		expect(restore!.context!.committed).to.deep.equal([remoteLatest]);
	});
});

describe('CoordinatorRepo read-repair CERTIFIED claims (cohort commit proofs)', () => {
	const blockId: BlockId = 'block-certified';

	/** A CoordinatorRepo wired for these specs: paranoid repair, present local block at rev 1. */
	const makeRepo = (
		peers: PeerId[], localPeer: PeerId, clusterSize: number,
		callback: ClusterLatestCallback, rep?: IPeerReputation
	) => {
		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1, 'local-action');
		const repo = new CoordinatorRepo(
			makeKeyNetwork(makeClusterPeers(peers)),
			makeClusterClient,
			storageRepo,
			{ clusterSize, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			callback,
			rep
		);
		return { repo, calls };
	};

	it('ONE peer with a valid proof drives restoration while every other cohort peer holds nothing', async () => {
		// The reproduced defect this ticket chain exists to fix: a 10-cohort where a single peer
		// holds the block. Uncorroborated, its lone claim could never meet the floor of 2; the
		// verified cohort proof stands in for the missing second voter.
		const localPeer = await makePeerId();
		const holder = await makePeerId();
		const others = await Promise.all(Array.from({ length: 8 }, makePeerId));
		const answer = await certifiedAnswer(blockId, 7, 'action-7');
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(holder) ? answer : undefined;
		const { rep, reports } = makeReputationStub();
		const { repo, calls } = makeRepo([localPeer, holder, ...others], localPeer, 10, callback, rep);

		await repo.get({ blockIds: [blockId] });

		const restore = calls.find(c => c.context?.rev === 7);
		expect(restore, 'certified lone holder must drive restoration').to.not.equal(undefined);
		expect(restore!.context!.committed).to.deep.equal([{ actionId: 'action-7', rev: 7 }]);
		expect(reports, 'nobody misbehaved').to.deep.equal([]);
	});

	it('one holder with NO proof still declines exactly as before (and is not penalized)', async () => {
		const localPeer = await makePeerId();
		const holder = await makePeerId();
		const others = await Promise.all(Array.from({ length: 8 }, makePeerId));
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(holder) ? { actionId: 'action-7', rev: 7 } : undefined;
		const { rep, reports } = makeReputationStub();
		const { repo, calls } = makeRepo([localPeer, holder, ...others], localPeer, 10, callback, rep);

		await repo.get({ blockIds: [blockId] });

		expect(calls.find(c => c.context?.rev === 7), 'a bare lone claim must not restore').to.equal(undefined);
		expect(reports, 'a lone uncorroborated claim is not misbehavior').to.deep.equal([]);
	});

	it('a certified rev 5 beats a LONE uncorroborated rev 9 claim', async () => {
		const localPeer = await makePeerId();
		const certifiedHolder = await makePeerId();
		const loneClaimant = await makePeerId();
		const answer = await certifiedAnswer(blockId, 5, 'action-5');
		const callback: ClusterLatestCallback = async (peerId) => {
			if (peerId.equals(certifiedHolder)) return answer;
			if (peerId.equals(loneClaimant)) return { actionId: 'action-9', rev: 9 };
			return undefined;
		};
		const { rep, reports } = makeReputationStub();
		const { repo, calls } = makeRepo([localPeer, certifiedHolder, loneClaimant], localPeer, 3, callback, rep);

		await repo.get({ blockIds: [blockId] });

		const restore = calls.find(c => c.context?.rev === 5);
		expect(restore, 'the certified rev must drive restoration').to.not.equal(undefined);
		expect(restore!.context!.committed).to.deep.equal([{ actionId: 'action-5', rev: 5 }]);
		expect(calls.find(c => c.context?.rev === 9), 'the uncorroborated higher claim failed quorum and is no evidence').to.equal(undefined);
		expect(reports, 'neither the proof-carrier nor the lone claimant misbehaved provably').to.deep.equal([]);
	});

	it('a CORROBORATED higher rev still beats a certified lower rev — the uncertified tail stays readable', async () => {
		const localPeer = await makePeerId();
		const certifiedHolder = await makePeerId();
		const voterA = await makePeerId();
		const voterB = await makePeerId();
		const answer = await certifiedAnswer(blockId, 5, 'action-5');
		const newer: ActionRev = { actionId: 'action-9', rev: 9 };
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(certifiedHolder) ? answer
				: (peerId.equals(voterA) || peerId.equals(voterB)) ? newer : undefined;
		const { rep, reports } = makeReputationStub();
		const { repo, calls } = makeRepo([localPeer, certifiedHolder, voterA, voterB], localPeer, 4, callback, rep);

		await repo.get({ blockIds: [blockId] });

		const restore = calls.find(c => c.context?.rev === 9);
		expect(restore, 'two distinct voters above the last proven rev must win').to.not.equal(undefined);
		expect(restore!.context!.committed).to.deep.equal([newer]);
		expect(calls.find(c => c.context?.rev === 5), 'the beaten certified rev must not restore').to.equal(undefined);
		expect(reports, 'the certified holder is merely lagging, never penalized').to.deep.equal([]);
	});

	it('mixed cohort: a certified claim short-circuits a lower corroborated pair', async () => {
		const localPeer = await makePeerId();
		const certifiedHolder = await makePeerId();
		const voterA = await makePeerId();
		const voterB = await makePeerId();
		const answer = await certifiedAnswer(blockId, 7, 'action-7');
		const older: ActionRev = { actionId: 'action-3', rev: 3 };
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(certifiedHolder) ? answer
				: (peerId.equals(voterA) || peerId.equals(voterB)) ? older : undefined;
		const { rep, reports } = makeReputationStub();
		const { repo, calls } = makeRepo([localPeer, certifiedHolder, voterA, voterB], localPeer, 4, callback, rep);

		await repo.get({ blockIds: [blockId] });

		const restore = calls.find(c => c.context?.rev === 7);
		expect(restore, 'the proof outweighs a corroborated pair at a lower rev').to.not.equal(undefined);
		expect(restore!.context!.committed).to.deep.equal([{ actionId: 'action-7', rev: 7 }]);
		expect(calls.find(c => c.context?.rev === 3), 'the outweighed corroborated rev must not restore').to.equal(undefined);
		expect(reports, 'lagging voters are never penalized').to.deep.equal([]);
	});

	it('two certified claims, same rev, different actions: no restoration, equivocation logged, nobody penalized', async () => {
		const localPeer = await makePeerId();
		const claimantA = await makePeerId();
		const claimantB = await makePeerId();
		const answerA = await certifiedAnswer(blockId, 5, 'action-a');
		const answerB = await certifiedAnswer(blockId, 5, 'action-b');
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(claimantA) ? answerA : peerId.equals(claimantB) ? answerB : undefined;
		const { rep, reports } = makeReputationStub();
		const { repo, calls } = makeRepo([localPeer, claimantA, claimantB], localPeer, 3, callback, rep);

		const captured = await captureLog('coordinator-repo', async () => {
			await repo.get({ blockIds: [blockId] });
		});

		expect(calls.find(c => c.context?.committed), 'provable equivocation must decline restoration').to.equal(undefined);
		expect(hasTag(captured, 'cluster-fetch:certified-equivocation'),
			'the decline must be named apart from a routine no-quorum').to.equal(true);
		expect(reports, 'both proofs verified — which side is wrong is unknowable here').to.deep.equal([]);
	});

	it('a REPLAYED proof (genuine, but for another rev) leaves the claim uncertified and penalizes the server', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const replayer = await makePeerId();
		// A proof genuinely covering rev 5 of this block, served attached to a rev-9 claim: the
		// claim step (`claim-not-in-message`) is the replay stop, and a mis-paired serve is the
		// peer's own artifact — attributable.
		const { proof } = await makeSignedProof(3, makeCommit(blockId, 5, 'action-9'));
		const honestLatest: ActionRev = { actionId: 'local-action', rev: 1 };
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(replayer) ? { actionId: 'action-9', rev: 9, proof }
				: (peerId.equals(honestA) || peerId.equals(honestB)) ? honestLatest : undefined;
		const { rep, reports } = makeReputationStub();
		const { repo, calls } = makeRepo([localPeer, honestA, honestB, replayer], localPeer, 4, callback, rep);

		await repo.get({ blockIds: [blockId] });

		expect(calls.find(c => c.context?.rev === 9), 'the replayed proof must not steer restoration').to.equal(undefined);
		expect(reports.map(r => r.peerId), 'serving a mis-paired proof is penalized once, at verification time')
			.to.deep.equal([replayer.toString()]);
		expect(reports[0]!.reason).to.equal('invalid-restoration');
	});

	it('an UNPARSEABLE proof leaves the claim uncertified but never penalizes the server', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const garbler = await makePeerId();
		const honestLatest: ActionRev = { actionId: 'local-action', rev: 1 };
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(garbler) ? { actionId: 'action-9', rev: 9, proof: { garbage: true } as any }
				: (peerId.equals(honestA) || peerId.equals(honestB)) ? honestLatest : undefined;
		const { rep, reports } = makeReputationStub();
		const { repo, calls } = makeRepo([localPeer, honestA, honestB, garbler], localPeer, 4, callback, rep);

		await repo.get({ blockIds: [blockId] });

		expect(calls.find(c => c.context?.rev === 9), 'a garbage proof certifies nothing').to.equal(undefined);
		// Structural garbage binds no identity — anyone in the chain could have authored it, so
		// penalizing would let an attacker frame the relaying peer.
		expect(reports, 'a malformed proof is never attributable').to.deep.equal([]);
	});

	it('a same-rev/different-actionId claim against the selection is STILL penalized (the kept branch)', async () => {
		const localPeer = await makePeerId();
		const honestA = await makePeerId();
		const honestB = await makePeerId();
		const conflicting = await makePeerId();
		const agreed: ActionRev = { actionId: 'action-5', rev: 5 };
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(conflicting) ? { actionId: 'action-x', rev: 5 }
				: (peerId.equals(honestA) || peerId.equals(honestB)) ? agreed : undefined;
		const { rep, reports } = makeReputationStub();
		const { repo, calls } = makeRepo([localPeer, honestA, honestB, conflicting], localPeer, 4, callback, rep);

		await repo.get({ blockIds: [blockId] });

		const restore = calls.find(c => c.context?.rev === 5);
		expect(restore, 'the corroborated pair still restores').to.not.equal(undefined);
		expect(restore!.context!.committed).to.deep.equal([agreed]);
		// Two actions cannot both be the commit at one revision — this contradiction is provable
		// without any proof machinery, so the penalty survives the higher-rev branch's removal.
		expect(reports.map(r => r.peerId)).to.deep.equal([conflicting.toString()]);
	});
});
