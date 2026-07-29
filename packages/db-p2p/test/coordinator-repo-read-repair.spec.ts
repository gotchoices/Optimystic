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
import debug from 'debug';

/**
 * Capture what `createLogger('coordinator-repo')` emits while `fn` runs.
 * Returns the raw `debug` argument lists so specs can assert on both the event
 * tag (args[0]) and the structured payload (args[1]).
 */
const captureCoordinatorLog = async (fn: () => Promise<void>): Promise<unknown[][]> => {
	const captured: unknown[][] = [];
	const previousNamespaces = debug.disable();
	const previousLog = debug.log;
	debug.enable('optimystic:db-p2p:coordinator-repo');
	debug.log = (...args: unknown[]): void => { captured.push(args); };
	try {
		await fn();
	} finally {
		debug.log = previousLog;
		debug.disable();
		if (previousNamespaces) debug.enable(previousNamespaces);
	}
	return captured;
};

/** True when the captured log contains `tag` carrying a payload with `rev`. */
const loggedRev = (captured: unknown[][], tag: string, rev: number): boolean =>
	captured.some(args =>
		typeof args[0] === 'string' && args[0].includes(tag)
		&& (args[1] as { rev?: number } | undefined)?.rev === rev
	);

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
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			calls.push(blockGets);
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				if (id === blockId) {
					result[id] = { state: { latest: { actionId, rev } } };
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
		const otherPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, otherPeer]);

		const callbackInvocations: string[] = [];
		const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			callbackInvocations.push(peerId.toString());
			return peerId.equals(otherPeer) ? remoteLatest : undefined;
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

		// Callback consulted both peers (self short-circuits inside the real callback,
		// but here we count every invocation including self because we mock the
		// callback directly).
		expect(callbackInvocations).to.include.members([localPeer.toString(), otherPeer.toString()]);

		// Restoration call must have fired with the remote latest context.
		const restorationCall = calls.find(c => c.context?.rev === remoteLatest.rev);
		expect(restorationCall, 'expected restoration call with remote latest context').to.not.equal(undefined);
		expect(restorationCall!.context!.committed).to.deep.equal([remoteLatest]);
	});

	it('paranoid mode is a noop when cluster reports the same rev as local', async () => {
		const localPeer = await makePeerId();
		const otherPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, otherPeer]);

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
		// Restoration call did fire (the simple-path always re-fetches after
		// queryClusterForLatest finds a max), but the rev is unchanged.
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
	 * Defect repro: 2-node cluster, node A commits rev 2, node B never observes it.
	 *
	 * The specs above mock `clusterLatestCallback` as returning `undefined` for
	 * SELF, which the real callback never does — `libp2p-node-base` short-circuits
	 * self to the local storage repo, so the reader's own (possibly stale) rev is
	 * always one of the claims. `makeSelfAnsweringCallback` models the real
	 * behavior, which exposes both failure modes below.
	 */
	describe('DEFECT: 2-node cluster cannot read-repair', () => {
		const localRev = 1;
		const localActionId = 'local-action';

		/** Mirrors the real callback: self answers from local storage, remote answers per `remoteLatest`. */
		const makeSelfAnsweringCallback = (
			localPeer: PeerId,
			remoteLatest: ActionRev | undefined
		): ClusterLatestCallback => async (peerId) =>
			peerId.equals(localPeer) ? { actionId: localActionId, rev: localRev } : remoteLatest;

		const makeRepo = (
			localPeer: PeerId,
			cluster: ClusterPeers,
			clusterLatestCallback: ClusterLatestCallback
		) => {
			const { repo: storageRepo, calls } = makePresentStorageRepo(blockId, localRev, localActionId);
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
			return { repo, calls };
		};

		it('logs cluster-fetch:synced at the STALE rev when the remote peer drops out', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			// Remote unreachable / past the 1 s per-peer timeout → contributes no claim.
			const { repo, calls } = makeRepo(localPeer, cluster, makeSelfAnsweringCallback(localPeer, undefined));

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			// The lone self-claim passes the small-cluster fallback and is treated as
			// a corroborated cluster latest, so the node "syncs" to the rev it had.
			const restorationCall = calls.find(c => c.context?.rev === localRev);
			expect(restorationCall, 'restoration fired using the node\'s own stale rev').to.not.equal(undefined);
			expect(restorationCall!.context!.committed).to.deep.equal([{ actionId: localActionId, rev: localRev }]);
			expect(
				loggedRev(captured, 'cluster-fetch:synced', localRev),
				`expected cluster-fetch:synced at stale rev ${localRev}; captured: ${JSON.stringify(captured)}`
			).to.equal(true);
		});

		it('declines with no-quorum when the remote peer DOES report the newer rev', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const cluster = makeClusterPeers([localPeer, otherPeer]);

			// Node A answers with the rev 2 it committed.
			const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
			const { repo, calls } = makeRepo(localPeer, cluster, makeSelfAnsweringCallback(localPeer, remoteLatest));

			const captured = await captureCoordinatorLog(async () => { await repo.get({ blockIds: [blockId] }); });

			// 2 responders, quorum 2, two singleton groups → nothing corroborated, so
			// rev 2 is never restored however often the read is retried.
			expect(calls.find(c => c.context?.rev === remoteLatest.rev), 'must NOT have restored rev 2').to.equal(undefined);
			expect(
				captured.some(args => typeof args[0] === 'string' && args[0].includes('cluster-fetch:no-quorum')),
				`expected cluster-fetch:no-quorum; captured: ${JSON.stringify(captured)}`
			).to.equal(true);
		});
	});
});
