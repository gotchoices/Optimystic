/**
 * Ticket: commit-result-carries-durability-class (GitHub #19).
 *
 * Before this ticket, four different situations answered a writer with the same `{ success: true }`:
 * a quorum commit, a genuine one-machine commit, a commit whose cohort lookup THREW (so the write
 * landed on this node alone with the network never consulted — the four-phone deployment in #19,
 * where two phones each wrote a row, were each told it succeeded, and each kept only its own), and
 * a torn multi-block commit. This spec pins the first three apart at `CoordinatorRepo`; the torn
 * case is the transactor's and lives in `torn-commit-cancels-abandoned-blocks.spec.ts`.
 *
 * Policy is deliberately unchanged throughout: every write accepted before is accepted here, and
 * the durability gate refuses exactly what it refused. Only the ANSWER changes.
 */

import { expect } from 'chai';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult,
	ActionBlocks, MessageOptions, BlockId, ClusterRecord, RepoMessage, StaleFailure, FindCoordinatorOptions, WriteDurability
} from '@optimystic/db-core';
import { isFullyDurable, localDurability } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { coordinatorRepo, type CoordinatorRepo, type ICoordinatorClusterSeam } from '../src/repo/coordinator-repo.js';
import type { CohortResolution } from '../src/repo/cluster-coordinator.js';
import type { ClusterClient } from '../src/cluster/client.js';
import type { IUnderReplicationLedger, UnderReplicatedEntry } from '../src/repo/i-under-replication-ledger.js';
import { KvUnderReplicationLedger } from '../src/repo/kv-under-replication-ledger.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { captureLog, hasTag } from './support/capture-log.js';

const BLOCK = 'block-write-durability' as BlockId;
const COMMIT: CommitRequest = { actionId: 'a-write', blockIds: [BLOCK], tailId: BLOCK, rev: 2 };
const PEND: PendRequest = { actionId: 'a-write', rev: 2, transforms: { inserts: {}, updates: { [BLOCK]: [] }, deletes: [] }, policy: 'c' };

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

/** A record over `peerIds` where every member promised and every member's commit vote approves. */
const makeRecord = (peerIds: readonly string[], approvingPromises: readonly string[] = peerIds): ClusterRecord => {
	const peers: ClusterPeers = {};
	const promises: ClusterRecord['promises'] = {};
	const commits: ClusterRecord['commits'] = {};
	for (const id of peerIds) {
		peers[id] = { multiaddrs: [], publicKey: '' };
		commits[id] = { type: 'approve', signature: '' };
		if (approvingPromises.includes(id)) promises[id] = { type: 'approve', signature: '' };
	}
	return { messageHash: 'mh', peers, message: {} as RepoMessage, promises, commits };
};

/** The other members' post-apply reports: `holders` succeed, everyone else in `peerIds` refuses. */
const reportsFrom = (peerIds: readonly string[], holders: readonly string[]): { [peerId: string]: CommitResult } =>
	Object.fromEntries(peerIds.map(id => [id, holders.includes(id)
		? { success: true, durability: localDurability() }
		: { success: false, reason: 'missing-base-revision: cannot materialize' }]));

const storageRepo = (commit: () => Promise<CommitResult> = async () => ({ success: true, durability: localDurability() })): IRepo => ({
	async get(gets: BlockGets, _o?: MessageOptions): Promise<GetBlockResults> {
		return Object.fromEntries(gets.blockIds.map(id => [id, { state: {} }]));
	},
	async pend(_r: PendRequest, _o?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [BLOCK], durability: localDurability() };
	},
	async cancel(_r: ActionBlocks, _o?: MessageOptions): Promise<void> { },
	async commit(): Promise<CommitResult> { return commit(); }
});

interface SeamOptions {
	cohort: CohortResolution;
	consensus?: Partial<Awaited<ReturnType<ICoordinatorClusterSeam['executeClusterTransaction']>>>;
	/** Handed to the repo through its components object, as the node wiring does. */
	ledger?: IUnderReplicationLedger;
}

/**
 * A `CoordinatorRepo` over a consensus double. `cohort` is what the coordinator's cohort lookup
 * establishes; `consensus` is what a cluster transaction (when one runs) hands back. The key network
 * the responsibility check reads mirrors the cohort when this node is in it. When the cohort did not
 * resolve, or resolved without this node, it still answers with a view that INCLUDES this node: the
 * responsibility check fails closed on a thrown lookup and refuses a cohort that excludes this node,
 * so the only way such a write reaches the solo branch now is the responsibility cache's staleness
 * window — the check answered from a view taken before routing broke (the shape #19 reported) or
 * before the cohort moved, and the coordinator's later lookup failed or answered with somebody else.
 * The pin here is that the answer stays honest in that window.
 */
const makeRepo = (storage: IRepo, self: PeerId | undefined, seam: SeamOptions): CoordinatorRepo => {
	const peerIds: readonly string[] = seam.cohort.resolved ? seam.cohort.peerIds : [];
	const selfInCohort = self === undefined || peerIds.includes(self.toString());
	const responsibilityView = selfInCohort ? peerIds : [self.toString()];
	const keyNetwork: IKeyNetwork = {
		async findCoordinator(_key: Uint8Array, _o?: Partial<FindCoordinatorOptions>): Promise<PeerId> { throw new Error('not implemented'); },
		async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
			return Object.fromEntries(responsibilityView.map(id => [id, { multiaddrs: [], publicKey: '' }]));
		}
	};
	const repo = coordinatorRepo(keyNetwork, (_p: PeerId) => ({} as unknown as ClusterClient), { clusterSize: 3 })({
		storageRepo: storage,
		localPeerId: self,
		underReplicationLedger: seam.ledger
	});
	(repo as unknown as { coordinator: ICoordinatorClusterSeam }).coordinator = {
		async getClusterSize(): Promise<number> { return peerIds.length; },
		async resolveCohort(): Promise<CohortResolution> { return seam.cohort; },
		async recoverTransactions(): Promise<void> { },
		async executeClusterTransaction() {
			if (seam.consensus === undefined) throw new Error('consensus must not run on the solo path');
			return { record: makeRecord(peerIds), localExecuted: false, ...seam.consensus };
		}
	};
	return repo;
};

const successOf = (result: CommitResult | PendResult) => {
	expect(result.success, `expected success, got ${JSON.stringify(result)}`).to.equal(true);
	if (!result.success) throw new Error('unreachable');
	return result;
};

describe('CoordinatorRepo — a successful write says who holds it', () => {
	let self: PeerId;
	let selfId: string;
	beforeEach(async () => {
		self = await makePeerId();
		selfId = self.toString();
	});

	describe('the solo short-circuit (GitHub #19)', () => {
		it('a commit that reached no resolved cohort is still acknowledged, and reads unrouted with a cohort of zero', async () => {
			// The coordinator's cohort lookup throws — the routing failure the four-machine deployment hit — after
			// the responsibility check confirmed this node from a view taken before routing broke.
			const repo = makeRepo(storageRepo(), self, { cohort: { resolved: false, reason: 'findCluster threw: no route' } });

			const result = successOf(await repo.commit(COMMIT));

			expect(result.durability.quorum, 'a write the network was never consulted about').to.equal('unrouted');
			expect(result.durability.cohort).to.equal(0);
			expect(result.durability.confirmed, 'this node holds it').to.equal(1);
			expect(isFullyDurable(result.durability)).to.equal(false);
		});

		it('a commit that reached no resolved cohort must not be indistinguishable from a healthy commit', async () => {
			const unrouted = successOf(await makeRepo(storageRepo(), self, { cohort: { resolved: false, reason: 'findCluster threw' } }).commit(COMMIT));
			// The complementary case: a two-member cohort, both of which confirm.
			const peer = (await makePeerId()).toString();
			const healthy = successOf(await makeRepo(storageRepo(), self, {
				cohort: { resolved: true, peerIds: [selfId, peer] },
				consensus: { localExecuted: true, localCommitResult: { success: true, durability: localDurability() }, cohortCommitOutcomes: reportsFrom([peer], [peer]) }
			}).commit(COMMIT));

			expect(healthy.durability.quorum).to.equal('full');
			expect(isFullyDurable(healthy.durability)).to.equal(true);
			// The assertion this spec exists for. If the class ever collapses to one value, this fails.
			expect(unrouted.durability.quorum, 'a commit that reached no resolved cohort must not be indistinguishable from a healthy commit')
				.to.not.equal(healthy.durability.quorum);
		});

		it('a cohort that resolved to exactly this node is a correct, complete one-machine write: local', async () => {
			const repo = makeRepo(storageRepo(), self, { cohort: { resolved: true, peerIds: [selfId] } });

			const result = successOf(await repo.commit(COMMIT));

			expect(result.durability).to.deep.equal({ quorum: 'local', confirmed: 1, cohort: 1, unconfirmed: [], cohortPeerIds: [selfId] });
		});

		it('a cohort that resolved to exactly one peer that is NOT this node is unrouted, not local', async () => {
			const other = (await makePeerId()).toString();
			const repo = makeRepo(storageRepo(), self, { cohort: { resolved: true, peerIds: [other] } });

			const result = successOf(await repo.commit(COMMIT));

			expect(result.durability.quorum, 'this node wrote somewhere the cohort does not look').to.equal('unrouted');
			expect(result.durability.cohort).to.equal(0);
		});

		it('a solo pend classifies the same four ways as a solo commit', async () => {
			const other = (await makePeerId()).toString();
			const cases: [CohortResolution, string][] = [
				[{ resolved: false, reason: 'findCluster threw' }, 'unrouted'],
				[{ resolved: true, peerIds: [selfId] }, 'local'],
				[{ resolved: true, peerIds: [other] }, 'unrouted']
			];
			for (const [cohort, quorum] of cases) {
				const result = successOf(await makeRepo(storageRepo(), self, { cohort }).pend(PEND));
				expect(result.durability.quorum, JSON.stringify(cohort)).to.equal(quorum);
			}
		});

		it('a refused solo commit carries no durability at all', async () => {
			const refusing = storageRepo(async () => ({ success: false, reason: 'stale revision' }));
			const result = await makeRepo(refusing, self, { cohort: { resolved: false, reason: 'findCluster threw' } }).commit(COMMIT);

			expect(result.success).to.equal(false);
			expect(result).to.not.have.property('durability');
		});
	});

	describe('the cluster path', () => {
		let others: string[];
		let cohort: string[];
		beforeEach(async () => {
			others = [await makePeerId(), await makePeerId(), await makePeerId()].map(p => p.toString());
			cohort = [selfId, ...others];
		});

		it('four members, three confirm: majority, confirmed 3 of 4, naming the fourth', async () => {
			const [holderA, holderB, refuser] = others as [string, string, string];
			const repo = makeRepo(storageRepo(), self, {
				cohort: { resolved: true, peerIds: cohort },
				consensus: { localExecuted: true, localCommitResult: { success: true, durability: localDurability() }, cohortCommitOutcomes: reportsFrom(others, [holderA, holderB]) }
			});

			const result = successOf(await repo.commit(COMMIT));

			expect(result.durability.quorum).to.equal('majority');
			expect(result.durability.confirmed).to.equal(3);
			expect(result.durability.cohort).to.equal(4);
			expect(result.durability.unconfirmed).to.deep.equal([refuser]);
			expect(result.durability.cohortPeerIds).to.deep.equal(cohort);
			expect(isFullyDurable(result.durability)).to.equal(false);
		});

		it('four members, all four confirm: full, with unconfirmed present and empty', async () => {
			const repo = makeRepo(storageRepo(), self, {
				cohort: { resolved: true, peerIds: cohort },
				consensus: { localExecuted: true, localCommitResult: { success: true, durability: localDurability() }, cohortCommitOutcomes: reportsFrom(others, others) }
			});

			const result = successOf(await repo.commit(COMMIT));

			expect(result.durability.quorum).to.equal('full');
			expect(result.durability.confirmed).to.equal(4);
			expect(result.durability.unconfirmed, 'present, and empty — "named the cohort, nobody is missing"').to.deep.equal([]);
			expect(isFullyDurable(result.durability)).to.equal(true);
		});

		it('a tolerated local divergence on a confirming remote majority is majority, with this node unconfirmed', async () => {
			// This node's member did not execute, and its fallback commit meets a missing pend: the
			// divergence is tolerated because the other three hold it. This node holds nothing.
			const diverging = storageRepo(async () => { throw new Error(`Pending action ${COMMIT.actionId} not found for block(s): ${BLOCK}`); });
			const repo = makeRepo(diverging, self, {
				cohort: { resolved: true, peerIds: cohort },
				consensus: { localExecuted: false, cohortCommitOutcomes: reportsFrom(others, others) }
			});

			const result = successOf(await repo.commit(COMMIT));

			expect(result.durability.quorum).to.equal('majority');
			expect(result.durability.confirmed, 'this node is absent from the count').to.equal(3);
			expect(result.durability.unconfirmed).to.deep.equal([selfId]);
		});

		it('the fallback commit, when it lands, counts this node exactly as the gate did', async () => {
			const repo = makeRepo(storageRepo(), self, {
				cohort: { resolved: true, peerIds: cohort },
				consensus: { localExecuted: false, cohortCommitOutcomes: reportsFrom(others, others) }
			});

			const result = successOf(await repo.commit(COMMIT));

			expect(result.durability.quorum).to.equal('full');
			expect(result.durability.confirmed).to.equal(4);
		});

		it('an absent local verdict is not counted, so the class reads lower than reality — the safe direction', async () => {
			const repo = makeRepo(storageRepo(), self, {
				cohort: { resolved: true, peerIds: cohort },
				consensus: { localExecuted: true, cohortCommitOutcomes: reportsFrom(others, others) }
			});

			const result = successOf(await repo.commit(COMMIT));

			expect(result.durability.quorum).to.equal('majority');
			expect(result.durability.unconfirmed).to.deep.equal([selfId]);
		});

		it('a commit refused by the durability gate is a StaleFailure with no durability field — the gate is untouched', async () => {
			const [holder] = others as [string, string, string];
			const repo = makeRepo(storageRepo(), self, {
				cohort: { resolved: true, peerIds: cohort },
				consensus: { localExecuted: true, localCommitResult: { success: true, durability: localDurability() }, cohortCommitOutcomes: reportsFrom(others, [holder]) }
			});

			const result = await repo.commit(COMMIT);

			expect(result.success, '2 of 4 is not a strict majority').to.equal(false);
			expect((result as StaleFailure).conflict).to.equal(true);
			expect(result).to.not.have.property('durability');
		});

		it('a pend that every member promised, applied here too, is full; a missing promise names the member', async () => {
			const [quiet] = others as [string, string, string];
			const applied: PendResult = { success: true, pending: [], blockIds: [BLOCK], durability: localDurability() };
			const full = successOf(await makeRepo(storageRepo(), self, {
				cohort: { resolved: true, peerIds: cohort },
				consensus: { record: makeRecord(cohort), localExecuted: true, localPendResult: applied }
			}).pend(PEND));
			expect(full.durability.quorum).to.equal('full');
			expect(full.durability.confirmed).to.equal(4);
			expect(full.durability.unconfirmed).to.deep.equal([]);

			const partial = successOf(await makeRepo(storageRepo(), self, {
				cohort: { resolved: true, peerIds: cohort },
				consensus: { record: makeRecord(cohort, cohort.filter(id => id !== quiet)), localExecuted: true, localPendResult: applied }
			}).pend(PEND));
			expect(partial.durability.quorum).to.equal('majority');
			expect(partial.durability.confirmed).to.equal(3);
			expect(partial.durability.unconfirmed).to.deep.equal([quiet]);
		});

		it('a coordinator outside the cohort whose fallback pend landed is not counted — confirmed never exceeds cohort', async () => {
			// This node coordinates for a cohort it is not a member of, and its own storage accepted the
			// pending record on the fallback arm. That copy is on nobody's reconcile path, so it is not a
			// confirmer: the answer is the cohort's three of three, not four of three. Reachable only inside
			// the responsibility cache's staleness window, and against this consensus double: the real
			// `ClusterCoordinator` refuses a cohort that excludes its local member before any vote.
			const repo = makeRepo(storageRepo(), self, {
				cohort: { resolved: true, peerIds: others },
				consensus: { record: makeRecord(others), localExecuted: false }
			});

			const result = successOf(await repo.pend(PEND));

			expect(result.durability.quorum).to.equal('full');
			expect(result.durability.confirmed).to.equal(3);
			expect(result.durability.cohort).to.equal(3);
			expect(result.durability.unconfirmed).to.deep.equal([]);
			expect(result.durability.cohortPeerIds).to.not.include(selfId);
		});
	});
});

/**
 * Ticket: under-replication-ledger-records-missing-holders.
 *
 * The answer above is the only moment the coordinator knows who is missing a block; these pin that
 * it writes that down before answering, and that nothing about the answer depends on the write.
 */
describe('CoordinatorRepo — an acknowledged commit below full replication records who is missing it', () => {
	const BLOCK_2 = 'block-write-durability-2' as BlockId;
	const TWO_BLOCKS: CommitRequest = { ...COMMIT, blockIds: [BLOCK, BLOCK_2] };
	const NOW = 42_000;

	let self: PeerId;
	let selfId: string;
	let others: string[];
	let cohort: string[];
	let ledger: KvUnderReplicationLedger;
	beforeEach(async () => {
		self = await makePeerId();
		selfId = self.toString();
		others = [await makePeerId(), await makePeerId(), await makePeerId()].map(p => p.toString());
		cohort = [selfId, ...others];
		ledger = new KvUnderReplicationLedger(new MemoryKVStore());
	});

	const withClock = (repo: CoordinatorRepo): CoordinatorRepo => {
		repo.now = () => NOW;
		return repo;
	};

	const expected = (blockId: BlockId, overrides: Partial<UnderReplicatedEntry>): UnderReplicatedEntry => ({
		blockId,
		rev: COMMIT.rev,
		actionId: COMMIT.actionId,
		quorum: 'majority',
		missingPeerIds: [],
		recordedAt: NOW,
		attempts: 0,
		...overrides
	});

	it('a majority commit with one absent member records one entry per block, naming that member', async () => {
		const [holderA, holderB, absent] = others as [string, string, string];
		const repo = withClock(makeRepo(storageRepo(), self, {
			cohort: { resolved: true, peerIds: cohort },
			consensus: { localExecuted: true, localCommitResult: { success: true, durability: localDurability() }, cohortCommitOutcomes: reportsFrom(others, [holderA, holderB]) },
			ledger
		}));

		const result = successOf(await repo.commit(TWO_BLOCKS));

		expect(result.durability.quorum).to.equal('majority');
		expect(await ledger.list()).to.have.deep.members([
			expected(BLOCK, { missingPeerIds: [absent] }),
			expected(BLOCK_2, { missingPeerIds: [absent] })
		]);
	});

	it('a solo commit records an empty missing set — unknown, not nobody — at local and at unrouted', async () => {
		const local = withClock(makeRepo(storageRepo(), self, { cohort: { resolved: true, peerIds: [selfId] }, ledger }));
		successOf(await local.commit(COMMIT));
		expect(await ledger.get(BLOCK)).to.deep.equal(expected(BLOCK, { quorum: 'local' }));

		const unroutedLedger = new KvUnderReplicationLedger(new MemoryKVStore());
		const unrouted = withClock(makeRepo(storageRepo(), self, { cohort: { resolved: false, reason: 'findCluster threw' }, ledger: unroutedLedger }));
		successOf(await unrouted.commit(COMMIT));
		expect(await unroutedLedger.get(BLOCK)).to.deep.equal(expected(BLOCK, { quorum: 'unrouted' }));
	});

	it('a full commit records nothing and settles an older entry for the same blocks', async () => {
		await ledger.record(expected(BLOCK, { rev: COMMIT.rev - 1, actionId: 'a-earlier', missingPeerIds: [others[0]!] }));
		await ledger.record(expected(BLOCK_2, { rev: COMMIT.rev - 1, actionId: 'a-earlier', quorum: 'local' }));
		const repo = withClock(makeRepo(storageRepo(), self, {
			cohort: { resolved: true, peerIds: cohort },
			consensus: { localExecuted: true, localCommitResult: { success: true, durability: localDurability() }, cohortCommitOutcomes: reportsFrom(others, others) },
			ledger
		}));

		const result = successOf(await repo.commit(TWO_BLOCKS));

		expect(result.durability.quorum).to.equal('full');
		expect(await ledger.list()).to.deep.equal([]);
	});

	it('a full commit through the local fallback settles too', async () => {
		await ledger.record(expected(BLOCK, { rev: COMMIT.rev - 1, missingPeerIds: [others[0]!] }));
		const repo = withClock(makeRepo(storageRepo(), self, {
			cohort: { resolved: true, peerIds: cohort },
			consensus: { localExecuted: false, cohortCommitOutcomes: reportsFrom(others, others) },
			ledger
		}));

		expect(successOf(await repo.commit(COMMIT)).durability.quorum).to.equal('full');
		expect(await ledger.get(BLOCK)).to.equal(undefined);
	});

	it('a tolerated divergence records nothing — this node holds no bytes to push', async () => {
		const diverging = storageRepo(async () => { throw new Error(`Pending action ${COMMIT.actionId} not found for block(s): ${BLOCK}`); });
		const repo = withClock(makeRepo(diverging, self, {
			cohort: { resolved: true, peerIds: cohort },
			consensus: { localExecuted: false, cohortCommitOutcomes: reportsFrom(others, others) },
			ledger
		}));

		const result = successOf(await repo.commit(COMMIT));

		expect(result.durability.quorum, 'this node is the unconfirmed member').to.equal('majority');
		expect(await ledger.list()).to.deep.equal([]);
	});

	it('a local-executed commit whose own verdict is absent records nothing — not a confirmed holder', async () => {
		const repo = withClock(makeRepo(storageRepo(), self, {
			cohort: { resolved: true, peerIds: cohort },
			consensus: { localExecuted: true, cohortCommitOutcomes: reportsFrom(others, others) },
			ledger
		}));

		expect(successOf(await repo.commit(COMMIT)).durability.quorum).to.equal('majority');
		expect(await ledger.list()).to.deep.equal([]);
	});

	it('a commit refused by the durability gate never reaches the ledger', async () => {
		const [holder] = others as [string, string, string];
		const repo = withClock(makeRepo(storageRepo(), self, {
			cohort: { resolved: true, peerIds: cohort },
			consensus: { localExecuted: true, localCommitResult: { success: true, durability: localDurability() }, cohortCommitOutcomes: reportsFrom(others, [holder]) },
			ledger
		}));

		expect((await repo.commit(COMMIT)).success).to.equal(false);
		expect(await ledger.list()).to.deep.equal([]);
	});

	it('blocks a torn commit abandoned are not recorded', async () => {
		// No coordinator-tier answer carries `torn` today — the writer's transactor names abandoned
		// blocks after every coordinator has answered — so the guard is exercised on the recording
		// step directly, with the answer a future producer would hand it.
		const repo = withClock(makeRepo(storageRepo(), self, { cohort: { resolved: true, peerIds: cohort }, ledger }));
		const tornAnswer: WriteDurability = { quorum: 'majority', confirmed: 4, cohort: 4, unconfirmed: [], cohortPeerIds: cohort, torn: [BLOCK_2] };
		const recording = repo as unknown as { noteReplicationShortfall(r: CommitRequest, d: WriteDurability, localHolds: boolean): Promise<void> };

		await recording.noteReplicationShortfall(TWO_BLOCKS, tornAnswer, true);

		expect((await ledger.list()).map(e => e.blockId)).to.deep.equal([BLOCK]);
	});

	it('a ledger that throws does not fail the commit, and the failure is logged', async () => {
		const [holderA, holderB] = others as [string, string, string];
		const throwing: IUnderReplicationLedger = {
			record: async () => { throw new Error('ledger disk full'); },
			settle: async () => { throw new Error('ledger disk full'); },
			get: async () => undefined,
			list: async () => [],
			size: async () => 0,
			satisfy: async () => undefined,
			name: async () => undefined,
			noteAttempt: async () => { },
			delete: async () => { }
		};
		const repo = withClock(makeRepo(storageRepo(), self, {
			cohort: { resolved: true, peerIds: cohort },
			consensus: { localExecuted: true, localCommitResult: { success: true, durability: localDurability() }, cohortCommitOutcomes: reportsFrom(others, [holderA, holderB]) },
			ledger: throwing
		}));

		let result: CommitResult | undefined;
		const captured = await captureLog('coordinator-repo', async () => {
			result = await repo.commit(COMMIT);
		});

		expect(successOf(result!).durability.quorum, 'the acknowledged write is still acknowledged').to.equal('majority');
		expect(hasTag(captured, 'under-replication-record-failed')).to.equal(true);
	});
});
