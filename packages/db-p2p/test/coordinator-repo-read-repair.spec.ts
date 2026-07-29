/**
 * Ticket: optimystic-coordinator-read-repair
 *
 * `CoordinatorRepo.get` now consults cluster peers not only when a block is
 * entirely missing locally, but also when the local copy might be stale —
 * gated by the `readRepairMode` policy on `ClusterConsensusConfig`. These
 * specs pin the three modes (off / lazy / paranoid) and the window+sample
 * behavior for the lazy mode, so a peer that missed the post-majority commit
 * broadcast catches up on the next read instead of serving indefinitely-stale
 * data.
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
import { CoordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { toString as u8ToString } from 'uint8arrays';
import { captureLog, hasTag, hasTagAtRev } from './support/capture-log.js';

const captureCoordinatorLog = (fn: () => Promise<void>): Promise<unknown[][]> =>
	captureLog('coordinator-repo', fn);

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

/**
 * Storage repo that reports a single block at a fixed rev. Records every
 * `get` call so specs can assert restoration paths fired with the right
 * context.
 */
const makePresentStorageRepo = (blockId: BlockId, rev: number, actionId = 'local-action') => {
	const calls: BlockGets[] = [];
	// Held revision, mutable: a restoration context naming a newer committed revision advances it,
	// modelling a storage repo whose restore actually lands. `CoordinatorRepo` now reports
	// `cluster-fetch:synced` vs `cluster-fetch:not-restored` from the revision it reads back, so a
	// stub frozen at its initial rev would report every restoration as a failure.
	let held: ActionRev = { actionId, rev };
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			calls.push(blockGets);
			const restoring = blockGets.context?.committed?.find(c => c.rev > held.rev);
			if (restoring && blockGets.blockIds.includes(blockId)) {
				held = restoring;
			}
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				if (id === blockId) {
					result[id] = { state: { latest: held } };
				} else {
					result[id] = { state: {} };
				}
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

describe('CoordinatorRepo read-repair', () => {
	const blockId: BlockId = 'block-read-repair';

	it('paranoid mode invokes clusterLatestCallback for a present (stale) block', async () => {
		const localPeer = await makePeerId();
		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const cluster = makeClusterPeers([localPeer, peerA, peerB]);

		const callbackInvocations: string[] = [];
		const localLatest: ActionRev = { actionId: 'local-action', rev: 1 };
		const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
		// Self answers from local storage exactly as `libp2p-node-base`'s callback does;
		// the two remote peers corroborate each other on the newer rev.
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			callbackInvocations.push(peerId.toString());
			return peerId.equals(localPeer) ? localLatest : remoteLatest;
		};

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 1);

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 3, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		await repo.get({ blockIds: [blockId] });

		// Callback consulted every cohort peer, self included (the real callback answers
		// self from local storage rather than dialling itself).
		expect(callbackInvocations).to.include.members([localPeer.toString(), peerA.toString(), peerB.toString()]);

		// Restoration call must have fired with the corroborated remote latest context.
		const restorationCall = calls.find(c => c.context?.rev === remoteLatest.rev);
		expect(restorationCall, 'expected restoration call with remote latest context').to.not.equal(undefined);
		expect(restorationCall!.context!.committed).to.deep.equal([remoteLatest]);
	});

	it('paranoid mode is a noop when cluster reports the same rev as local', async () => {
		const localPeer = await makePeerId();
		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const cluster = makeClusterPeers([localPeer, peerA, peerB]);

		const callbackInvocations: string[] = [];
		const sameLatest: ActionRev = { actionId: 'local-action', rev: 5 };
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			callbackInvocations.push(peerId.toString());
			return sameLatest;
		};

		const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, 5, 'local-action');

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 3, readRepairMode: 'paranoid' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		const result = await repo.get({ blockIds: [blockId] });

		// Callback was consulted.
		expect(callbackInvocations.length).to.be.greaterThan(0);
		// The cohort corroborates the rev this node already holds, so no restoration is
		// attempted at all — only the plain local read.
		expect(calls.every(c => c.context === undefined), 'no restoration context expected').to.equal(true);
		expect(result[blockId]?.state?.latest?.rev).to.equal(5);
		// Sanity: at least one local lookup happened.
		expect(calls.length).to.be.greaterThan(0);
	});

	it('off mode skips read-repair for present blocks', async () => {
		const localPeer = await makePeerId();
		const otherPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, otherPeer]);

		const callbackInvocations: string[] = [];
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			callbackInvocations.push(peerId.toString());
			return { actionId: 'remote', rev: 99 };
		};

		const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 3, readRepairMode: 'off' },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		await repo.get({ blockIds: [blockId] });

		// 'off' restores legacy behavior: present-but-stale blocks are NOT verified.
		expect(callbackInvocations).to.deep.equal([]);
	});

	it('lazy mode honors readRepairWindowMs: skips within window, triggers after', async () => {
		const localPeer = await makePeerId();
		const otherPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, otherPeer]);

		const callbackInvocations: string[] = [];
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			callbackInvocations.push(peerId.toString());
			return undefined;
		};

		const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: 60_000 },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		// Stub the clock so the spec is deterministic.
		const baseTime = 1_000_000;
		repo.now = () => baseTime;

		// Mark the block seen "now" (simulates a successful local commit).
		repo.setLastSeenForTest(blockId, baseTime);

		// Within the window: callback must NOT fire.
		await repo.get({ blockIds: [blockId] });
		expect(callbackInvocations, 'lazy mode must not invoke the callback within window').to.deep.equal([]);

		// Advance past the window.
		repo.now = () => baseTime + 60_001;
		await repo.get({ blockIds: [blockId] });

		// Now the callback must have fired for both peers.
		expect(callbackInvocations).to.include.members([localPeer.toString(), otherPeer.toString()]);
	});

	it('lazy mode triggers for blocks that have never been marked seen', async () => {
		const localPeer = await makePeerId();
		const otherPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, otherPeer]);

		const callbackInvocations: string[] = [];
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			callbackInvocations.push(peerId.toString());
			return undefined;
		};

		const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: 60_000 },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		// No setLastSeenForTest call — block has never been marked seen, so lazy
		// must treat it as stale and trigger.
		await repo.get({ blockIds: [blockId] });

		expect(callbackInvocations).to.include.members([localPeer.toString(), otherPeer.toString()]);
	});

	it('lazy mode honors readRepairSampleRate inside the freshness window', async () => {
		const localPeer = await makePeerId();
		const otherPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, otherPeer]);

		const callbackInvocations: string[] = [];
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			callbackInvocations.push(peerId.toString());
			return undefined;
		};

		const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);

		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: 60_000, readRepairSampleRate: 0.5 },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		const baseTime = 3_000_000;
		repo.now = () => baseTime;
		repo.setLastSeenForTest(blockId, baseTime);

		// Within window, rand below threshold → triggers.
		repo.rand = () => 0.3;
		await repo.get({ blockIds: [blockId] });
		expect(callbackInvocations, 'rand=0.3 < sampleRate=0.5 within window should trigger').to.not.deep.equal([]);

		// Reset for second probe and bump lastSeen so the window-branch doesn't fire.
		callbackInvocations.length = 0;
		repo.setLastSeenForTest(blockId, baseTime);
		repo.rand = () => 0.7;
		await repo.get({ blockIds: [blockId] });
		expect(callbackInvocations, 'rand=0.7 >= sampleRate=0.5 within window should NOT trigger').to.deep.equal([]);
	});

	it('lazy mode default (no window override) treats fresh local block as fresh for 10 s', async () => {
		const localPeer = await makePeerId();
		const otherPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, otherPeer]);

		const callbackInvocations: string[] = [];
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			callbackInvocations.push(peerId.toString());
			return undefined;
		};

		const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);

		// No readRepairMode / readRepairWindowMs passed: should default to
		// 'lazy' / 10_000.
		const repo = new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			storageRepo,
			{ clusterSize: 3 },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);

		const baseTime = 2_000_000;
		repo.now = () => baseTime;
		repo.setLastSeenForTest(blockId, baseTime);

		// Default window is 10_000 ms.
		repo.now = () => baseTime + 5_000;
		await repo.get({ blockIds: [blockId] });
		expect(callbackInvocations, 'within default 10s window should not trigger').to.deep.equal([]);

		repo.now = () => baseTime + 10_001;
		await repo.get({ blockIds: [blockId] });
		expect(callbackInvocations).to.include.members([localPeer.toString(), otherPeer.toString()]);
	});

	/**
	 * Ticket: bug-read-repair-unrepairable-small-cluster.
	 *
	 * The specs above the fix originally mocked `clusterLatestCallback` as returning
	 * `undefined` for SELF, which the real callback never does — `libp2p-node-base`
	 * short-circuits self to the local storage repo, so the reader's own (possibly stale)
	 * rev is always one of the answers. `makeSelfAnsweringCallback` models the real
	 * behavior; these specs pin that the reader's own answer is now the baseline being
	 * repaired rather than a corroborating vote, and that a cohort with exactly one other
	 * peer can converge instead of deadlocking.
	 *
	 * The first two were committed in `ff2cbbf` asserting the broken behavior and are
	 * inverted here.
	 */
	describe('2-node cluster read-repair', () => {
		const localRev = 1;
		const localActionId = 'local-action';

		/** Mirrors the real callback: self answers from local storage, remote answers per `remoteLatest`. */
		const makeSelfAnsweringCallback = (
			localPeer: PeerId,
			remoteLatest: ActionRev | undefined,
			selfLatest: ActionRev = { actionId: localActionId, rev: localRev }
		): ClusterLatestCallback => async (peerId) =>
			peerId.equals(localPeer) ? selfLatest : remoteLatest;

		const makeRepo = (
			localPeer: PeerId,
			cluster: ClusterPeers,
			clusterLatestCallback: ClusterLatestCallback,
			cfg?: { clusterSize?: number; assumedClusterSize?: number; rev?: number }
		) => {
			const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, cfg?.rev ?? localRev, localActionId);
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				storageRepo,
				{
					clusterSize: cfg?.clusterSize ?? 2,
					assumedClusterSize: cfg?.assumedClusterSize,
					readRepairMode: 'paranoid'
				},
				undefined,
				localPeer,
				undefined,
				clusterLatestCallback
			);
			return { repo, calls };
		};

		it('does not treat its own stale rev as corroboration when the remote peer drops out', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			// Remote unreachable / past the 1 s per-peer timeout → contributes no claim.
			const { repo, calls } = makeRepo(localPeer, cluster, makeSelfAnsweringCallback(localPeer, undefined));

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			// No claim survives self-exclusion, so nothing is restored and — critically —
			// nothing is reported as synced at the revision we were trying to repair.
			expect(calls.find(c => c.context !== undefined), 'no restoration must fire').to.equal(undefined);
			expect(
				hasTagAtRev(captured, 'cluster-fetch:synced', localRev),
				`must NOT log a sync at the stale rev; captured: ${JSON.stringify(captured)}`
			).to.equal(false);
			expect(hasTag(captured, 'cluster-fetch:no-quorum'), 'expected cluster-fetch:no-quorum').to.equal(true);
		});

		it('adopts the newer rev the only other peer reports', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			// Node A answers with the rev 2 it committed.
			const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
			const { repo, calls } = makeRepo(localPeer, cluster, makeSelfAnsweringCallback(localPeer, remoteLatest));

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			const restore = calls.find(c => c.context?.rev === remoteLatest.rev);
			expect(restore, 'rev 2 must now drive restoration').to.not.equal(undefined);
			expect(restore!.context!.committed).to.deep.equal([remoteLatest]);
			expect(hasTagAtRev(captured, 'cluster-fetch:synced', remoteLatest.rev)).to.equal(true);
		});

		it('never restores backwards when the reader is ahead of every peer', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			// Reader is at rev 7; the lone peer is lagging at rev 3.
			const selfLatest: ActionRev = { actionId: 'local-action', rev: 7 };
			const laggingRemote: ActionRev = { actionId: 'old-action', rev: 3 };
			const { repo, calls } = makeRepo(
				localPeer,
				cluster,
				makeSelfAnsweringCallback(localPeer, laggingRemote, selfLatest),
				{ rev: 7 }
			);

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			// The peer's rev 3 IS corroborated (it is the only possible corroborator), which is
			// exactly the condition self-exclusion could have turned into a regression.
			expect(calls.find(c => c.context !== undefined), 'must not restore to an older rev').to.equal(undefined);
			expect(hasTagAtRev(captured, 'cluster-fetch:synced', laggingRemote.rev)).to.equal(false);
			expect(hasTag(captured, 'cluster-fetch:local-current'), 'expected cluster-fetch:local-current').to.equal(true);
		});

		/**
		 * The monotonic guard reads the reader's own revision out of the SELF answer to
		 * `clusterLatestCallback`, which only exists when `findCluster` returned this node. A
		 * node serving a read for a block it is no longer responsible for (the documented
		 * `proximity:get-warning` soft serve) is absent from its own cohort view, so the guard
		 * has to fall back to the revision the read already loaded — otherwise a pass that
		 * moved nothing reports `cluster-fetch:synced` at the revision it started from.
		 */
		it('uses the revision it already read as the baseline when self is not in the cohort view', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			// Self deliberately absent: this node holds the block but is no longer responsible.
			const cluster = makeClusterPeers([otherPeer]);

			const laggingRemote: ActionRev = { actionId: 'old-action', rev: 3 };
			const { repo, calls } = makeRepo(
				localPeer,
				cluster,
				async () => laggingRemote,
				{ rev: 7 }
			);

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			expect(calls.find(c => c.context !== undefined), 'must not attempt an older rev').to.equal(undefined);
			expect(
				hasTag(captured, 'cluster-fetch:synced'),
				`nothing moved, so nothing may claim a sync; captured: ${JSON.stringify(captured)}`
			).to.equal(false);
			expect(hasTag(captured, 'cluster-fetch:local-current'), 'expected cluster-fetch:local-current').to.equal(true);
		});

		it('declines when no peer responds at all', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			// Neither self nor the remote answers (local read failed AND the peer is silent).
			const silent: ClusterLatestCallback = async () => undefined;
			const { repo, calls } = makeRepo(localPeer, cluster, silent);

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			expect(calls.find(c => c.context !== undefined), 'nothing to adopt').to.equal(undefined);
			expect(hasTag(captured, 'cluster-fetch:synced')).to.equal(false);
			expect(hasTag(captured, 'cluster-fetch:no-quorum')).to.equal(true);
		});

		it('does not relax the floor when a LARGER configured cluster merely looks small', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			// findCluster is unauthenticated: a partition (or a routing-level attacker) can
			// shrink this node's view to itself plus one peer. `assumedClusterSize` is omitted, so
			// this also pins the fallback: the floor is measured against `clusterSize`, reproducing
			// today's behavior exactly for a caller that has not adopted the new field.
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
			const { repo, calls } = makeRepo(
				localPeer,
				cluster,
				makeSelfAnsweringCallback(localPeer, remoteLatest),
				{ clusterSize: 10 }
			);

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			expect(calls.find(c => c.context !== undefined), 'a lone claim must not be adopted here').to.equal(undefined);
			expect(hasTag(captured, 'cluster-fetch:no-quorum')).to.equal(true);
		});

		it('heals via assumedClusterSize even when clusterSize (replication factor) stays large', async () => {
			// The healing case this ticket exists for: a genuine two-node deployment that declares
			// assumedClusterSize: 2 can repair itself WITHOUT also lowering its replication factor —
			// unlike the old advice of configuring clusterSize: 2 to get the same effect.
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
			const { repo, calls } = makeRepo(
				localPeer,
				cluster,
				makeSelfAnsweringCallback(localPeer, remoteLatest),
				{ clusterSize: 10, assumedClusterSize: 2 }
			);

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			const restore = calls.find(c => c.context?.rev === remoteLatest.rev);
			expect(restore, 'the sole peer\'s claim must corroborate under the asserted size').to.not.equal(undefined);
			expect(hasTagAtRev(captured, 'cluster-fetch:synced', remoteLatest.rev)).to.equal(true);
		});

		it('a declined repair does not suppress the next attempt', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			const invocations: string[] = [];
			const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
				invocations.push(peerId.toString());
				return peerId.equals(localPeer) ? { actionId: localActionId, rev: localRev } : undefined;
			};

			const { repo: storageRepo } = makePresentStorageRepo(blockId, localRev, localActionId);
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				storageRepo,
				{ clusterSize: 2, readRepairMode: 'lazy', readRepairWindowMs: 60_000 },
				undefined,
				localPeer,
				undefined,
				clusterLatestCallback
			);
			repo.now = () => 1_000_000;

			await repo.get({ blockIds: [blockId] });
			const afterFirst = invocations.length;
			expect(afterFirst, 'first read consults the cohort').to.be.greaterThan(0);

			// The first pass corroborated nothing, so the block must NOT have been marked
			// freshly seen — otherwise the lazy window would hide the divergence for 60 s.
			await repo.get({ blockIds: [blockId] });
			expect(invocations.length, 'second read must retry rather than be suppressed').to.be.greaterThan(afterFirst);
		});
	});
});
