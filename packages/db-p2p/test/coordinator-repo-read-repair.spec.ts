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
import { resolveClusterPolicy } from '../src/cluster/cluster-policy.js';
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

		/**
		 * Ticket: corroboration-floor-defaults-to-two-for-large-meshes.
		 *
		 * The case above builds its config by hand; this one builds it from `resolveClusterPolicy`,
		 * the function `createLibp2pNodeBase` actually calls — the layer where the regression lived.
		 * An unconfigured node used to resolve `assumedClusterSize: 2` and hand it to the repair
		 * floor, so a peer view shrunk to one peer bought that peer full trust.
		 */
		it('does not relax the floor for an UNCONFIGURED node (the real composition-root default)', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			const resolved = resolveClusterPolicy({});
			const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, localRev, localActionId);
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				storageRepo,
				{ ...resolved, readRepairMode: 'paranoid' },
				undefined,
				localPeer,
				undefined,
				makeSelfAnsweringCallback(localPeer, { actionId: 'remote-action', rev: 2 })
			);

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			expect(calls.find(c => c.context !== undefined), 'a lone claim must not be adopted by an unconfigured node').to.equal(undefined);
			expect(hasTag(captured, 'cluster-fetch:no-quorum')).to.equal(true);

			// Ticket bug-cluster-size-resolution-single-source: the decline must name the knob that
			// caused it, not just the vote counts, or an operator reading the log cannot act on it.
			const payload = captured.find(args => typeof args[0] === 'string' && args[0].includes('cluster-fetch:no-quorum'))?.[1] as
				{ responders?: number, required?: number, repairCorroborationClusterSize?: number } | undefined;
			expect(payload?.repairCorroborationClusterSize).to.equal(resolved.repairCorroborationClusterSize);
			expect(payload?.required).to.equal(2);
			expect(payload?.responders).to.equal(1);
		});

		it('heals unconfigured-but-declared: resolveClusterPolicy with assumedClusterSize 2 repairs', async () => {
			// The counterpart trade — one explicit operator setting restores self-repair for a mesh
			// that really is two nodes, without lowering the replication factor.
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			const resolved = resolveClusterPolicy({ clusterPolicy: { assumedClusterSize: 2 } });
			const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
			const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, localRev, localActionId);
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				storageRepo,
				{ ...resolved, readRepairMode: 'paranoid' },
				undefined,
				localPeer,
				undefined,
				makeSelfAnsweringCallback(localPeer, remoteLatest)
			);

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			expect(calls.find(c => c.context?.rev === remoteLatest.rev), 'a declared two-node cohort still repairs').to.not.equal(undefined);
			expect(hasTagAtRev(captured, 'cluster-fetch:synced', remoteLatest.rev)).to.equal(true);
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

	/**
	 * Ticket: repair-deadlock-is-never-named.
	 *
	 * `cluster-fetch:no-quorum` fires on every declining pass and cannot say whether the decline was
	 * transient (a peer did not answer; it may next time) or permanent (every peer that exists
	 * answered, and there still were not enough of them). The field symptom was 1821 identical
	 * no-quorum lines, no error of any kind, and twelve days spent re-deriving from those logs a fact
	 * the node knew at the moment of each decline. `cluster-fetch:repair-deadlock` says it once, in
	 * words, and only when it is provable.
	 */
	describe('naming a repair that can never converge', () => {
		const DEADLOCK = 'cluster-fetch:repair-deadlock';
		const localRev = 1;
		const localActionId = 'local-action';
		const deadlockLines = (captured: unknown[][]) =>
			captured.filter(args => typeof args[0] === 'string' && args[0].includes(DEADLOCK));

		it('says it once for a shortfall where every cohort peer answered', async () => {
			// Three machines: the reader plus two peers. One peer claims a newer rev, the other answers
			// honestly that it holds nothing — still an ANSWER. Nobody is silent, so the two agreeing
			// voters this cohort needs do not exist and never will at this size.
			const localPeer = await makePeerId();
			const claimant = await makePeerId();
			const emptyPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, claimant, emptyPeer]);

			const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(localPeer)) return { actionId: localActionId, rev: localRev };
				if (peerId.equals(claimant)) return { actionId: 'remote-action', rev: 2 };
				return undefined; // answered: holds nothing
			};

			const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, localRev, localActionId);
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

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			expect(calls.find(c => c.context !== undefined), 'a lone claim must still not be adopted').to.equal(undefined);
			expect(hasTag(captured, 'cluster-fetch:no-quorum'), 'the per-pass decline line still fires').to.equal(true);
			expect(deadlockLines(captured), 'expected exactly one deadlock line').to.have.lengthOf(1);

			const payload = deadlockLines(captured)[0]![1] as {
				cohortPeers?: number, answered?: number, claimants?: number, required?: number,
				repairCorroborationClusterSize?: number, message?: string
			};
			expect(payload.cohortPeers, 'two cohort peers besides the reader').to.equal(2);
			expect(payload.answered, 'and both of them answered').to.equal(2);
			expect(payload.claimants, 'only one of the two actually holds the block').to.equal(1);
			expect(payload.required).to.equal(2);
			expect(payload.repairCorroborationClusterSize).to.equal(3);
			// It must say the word, and it must name the remedy — that is the whole point.
			expect(payload.message).to.contain('PERMANENT');
			expect(payload.message).to.contain('clusterPolicy.assumedClusterSize');
		});

		it('stays quiet when a peer was SILENT — that shortfall may fix itself', async () => {
			// Same shortfall, different cause: the second peer could not be asked at all. A reader
			// cannot tell an unreachable peer from a withholding one, so nothing here is provable and
			// the plain no-quorum line is the honest answer.
			const localPeer = await makePeerId();
			const claimant = await makePeerId();
			const unreachable = await makePeerId();
			const cluster = makeClusterPeers([localPeer, claimant, unreachable]);

			const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(localPeer)) return { actionId: localActionId, rev: localRev };
				if (peerId.equals(claimant)) return { actionId: 'remote-action', rev: 2 };
				throw new Error('dial failed');
			};

			const { repo: storageRepo } = makePresentStorageRepo(blockId, localRev, localActionId);
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

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			expect(hasTag(captured, 'cluster-fetch:peers-silent')).to.equal(true);
			expect(hasTag(captured, 'cluster-fetch:no-quorum')).to.equal(true);
			expect(deadlockLines(captured), 'silence proves nothing permanent').to.have.lengthOf(0);
		});

		it('stays quiet when the decline was a genuine disagreement between claims', async () => {
			// Four machines, three peers: two of them claim DIFFERENT (rev, actionId) pairs and the
			// third holds nothing. Enough voters showed up for the quorum of two; they simply do not
			// agree. That is a live cohort split — a later pass can settle it — not a deadlock.
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const peerB = await makePeerId();
			const peerC = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA, peerB, peerC]);

			const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(localPeer)) return { actionId: localActionId, rev: localRev };
				if (peerId.equals(peerA)) return { actionId: 'action-x', rev: 2 };
				if (peerId.equals(peerB)) return { actionId: 'action-y', rev: 3 };
				return undefined;
			};

			const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, localRev, localActionId);
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

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			expect(calls.find(c => c.context !== undefined), 'a split cohort adopts nothing').to.equal(undefined);
			expect(hasTag(captured, 'cluster-fetch:no-quorum')).to.equal(true);
			expect(deadlockLines(captured), 'disagreement is not want of voters').to.have.lengthOf(0);
		});

		it('stays quiet when the whole cohort answers that it holds nothing', async () => {
			// Nobody claims anything: the cohort agrees the block is absent. That is an answer, not a
			// repair that failed — there is nothing to be deadlocked about.
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const peerB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA, peerB]);

			const clusterLatestCallback: ClusterLatestCallback = async (peerId) =>
				peerId.equals(localPeer) ? { actionId: localActionId, rev: localRev } : undefined;

			const { repo: storageRepo } = makePresentStorageRepo(blockId, localRev, localActionId);
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

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			expect(deadlockLines(captured), 'an agreed absence is not a deadlock').to.have.lengthOf(0);
		});

		it('does not repeat across passes for the same block', async () => {
			// The condition holds identically on every later pass; saying it 1821 times is the defect.
			const localPeer = await makePeerId();
			const claimant = await makePeerId();
			const emptyPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, claimant, emptyPeer]);

			const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(localPeer)) return { actionId: localActionId, rev: localRev };
				if (peerId.equals(claimant)) return { actionId: 'remote-action', rev: 2 };
				return undefined;
			};

			const { repo: storageRepo } = makePresentStorageRepo(blockId, localRev, localActionId);
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

			const captured = await captureCoordinatorLog(async () => {
				await repo.get({ blockIds: [blockId] });
				await repo.get({ blockIds: [blockId] });
				await repo.get({ blockIds: [blockId] });
			});

			expect(deadlockLines(captured), 'said once, not once per pass').to.have.lengthOf(1);
			// ...while the per-pass decline line keeps firing, so nothing is hidden.
			expect(
				captured.filter(args => typeof args[0] === 'string' && args[0].includes('cluster-fetch:no-quorum')).length,
				'the per-pass line is untouched'
			).to.equal(3);
		});

		it('does not repeat when the cohort claims nothing AHEAD of what the reader holds', async () => {
			// The suppression bit is hung off the per-block freshness entry, which a consult finding no
			// ahead-claim otherwise CLEARS. If clearing it dropped the bit too, this block would
			// re-announce the same permanent condition on every read.
			const localPeer = await makePeerId();
			const claimant = await makePeerId();
			const emptyPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, claimant, emptyPeer]);

			const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(localPeer)) return { actionId: localActionId, rev: localRev };
				// The same revision the reader already holds: a claim, but nothing to converge onto.
				if (peerId.equals(claimant)) return { actionId: localActionId, rev: localRev };
				return undefined;
			};

			const { repo: storageRepo } = makePresentStorageRepo(blockId, localRev, localActionId);
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

			const captured = await captureCoordinatorLog(async () => {
				await repo.get({ blockIds: [blockId] });
				await repo.get({ blockIds: [blockId] });
			});

			expect(deadlockLines(captured)).to.have.lengthOf(1);
		});

		it('does not repeat for a block that is MISSING locally', async () => {
			// A missing block never consults the read-repair window and never records an ahead-claim,
			// so this is the case the field logs were dominated by. The bit still has to hold.
			const missingId: BlockId = 'block-not-here';
			const localPeer = await makePeerId();
			const claimant = await makePeerId();
			const emptyPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, claimant, emptyPeer]);

			const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(claimant)) return { actionId: 'remote-action', rev: 4 };
				return undefined;
			};

			// The stub reports `{ state: {} }` for every id other than `blockId` — a plain local miss.
			const { repo: storageRepo } = makePresentStorageRepo(blockId, localRev, localActionId);
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

			const captured = await captureCoordinatorLog(async () => {
				await repo.get({ blockIds: [missingId] });
				await repo.get({ blockIds: [missingId] });
			});

			expect(deadlockLines(captured)).to.have.lengthOf(1);
		});
	});
});
