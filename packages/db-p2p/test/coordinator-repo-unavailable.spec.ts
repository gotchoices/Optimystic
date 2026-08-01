/**
 * Ticket: repo-reports-unavailable-vs-absent
 *
 * `CoordinatorRepo.get` answers "absent" authoritatively only because it consults the
 * cohort for any block that is missing locally. When that consult THROWS, the local
 * "absent" is an answer the coordinator just failed to confirm — these specs pin that
 * such an entry is flagged `unavailable: 'peers-unreachable'` instead of posing as an
 * authoritative absent (which NetworkTransactor deliberately never retries).
 *
 * Equally important are the answers that must STAY authoritative: a consult that runs
 * and simply corroborates nothing (the common new-collection probe), a merely-stale
 * block whose consult fails (it has a real local answer), and a cluster-internal sync
 * read (`skipClusterFetch`).
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

/** Key network whose cohort lookup fails outright — the consult cannot even start. */
const makeThrowingKeyNetwork = (): IKeyNetwork => ({
	async findCoordinator(): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(): Promise<ClusterPeers> {
		throw new Error('cohort lookup failed');
	}
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

const writeStubs = {
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [] };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true };
	}
};

/** Storage repo holding nothing at all: every block answers an authoritative absent. */
const makeAbsentStorageRepo = (): { repo: IRepo, calls: BlockGets[] } => {
	const calls: BlockGets[] = [];
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			calls.push(blockGets);
			return Object.fromEntries(blockGets.blockIds.map(id => [id, { state: {} }]));
		},
		...writeStubs
	};
	return { repo, calls };
};

/** Storage repo that starts absent and adopts any newer committed revision a restoration
 *  context proves — modelling a local store the read-repair acquisition actually lands in. */
const makeAbsentThenAdoptingStorageRepo = (blockId: BlockId): { repo: IRepo, calls: BlockGets[] } => {
	const calls: BlockGets[] = [];
	let held: ActionRev | undefined;
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			calls.push(blockGets);
			const adopting = blockGets.context?.committed?.find(c => held === undefined || c.rev > held.rev);
			if (adopting && blockGets.blockIds.includes(blockId)) {
				held = adopting;
			}
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				result[id] = id === blockId && held
					? { block: { header: { id: blockId, type: 'T', collectionId: 'c' as BlockId } }, state: { latest: held } }
					: { state: {} };
			}
			return result;
		},
		...writeStubs
	};
	return { repo, calls };
};

/** Storage repo reporting a single present block at a fixed revision. */
const makePresentStorageRepo = (blockId: BlockId, rev: number): { repo: IRepo } => {
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				result[id] = id === blockId
					? { block: { header: { id: blockId, type: 'T', collectionId: 'c' as BlockId } }, state: { latest: { actionId: 'local-action', rev } } }
					: { state: {} };
			}
			return result;
		},
		...writeStubs
	};
	return { repo };
};

/** Storage repo that already flags the block `unmaterializable` (records held, no base). */
const makeUnmaterializableStorageRepo = (blockId: BlockId): { repo: IRepo } => {
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			return Object.fromEntries(blockGets.blockIds.map(id => [id,
				id === blockId ? { state: {}, unavailable: 'unmaterializable' as const } : { state: {} }]));
		},
		...writeStubs
	};
	return { repo };
};

describe('CoordinatorRepo unavailable vs absent', () => {
	const blockId: BlockId = 'block-unavailable';

	const buildRepo = (
		keyNetwork: IKeyNetwork,
		storageRepo: IRepo,
		localPeer: PeerId,
		clusterLatestCallback: ClusterLatestCallback,
		cfg?: { readRepairMode?: 'off' | 'lazy' | 'paranoid' }
	): CoordinatorRepo => new CoordinatorRepo(
		keyNetwork,
		makeClusterClient,
		storageRepo,
		{ clusterSize: 3, ...(cfg ?? {}) },
		undefined,
		localPeer,
		undefined,
		clusterLatestCallback
	);

	it('flags a locally-missing block peers-unreachable when the cohort consult throws', async () => {
		const localPeer = await makePeerId();
		const { repo: storageRepo } = makeAbsentStorageRepo();

		// findCluster throws, so the consult that was supposed to make "absent"
		// trustworthy never ran at all.
		const repo = buildRepo(makeThrowingKeyNetwork(), storageRepo, localPeer, async () => undefined);

		const result = await repo.get({ blockIds: [blockId] });

		expect(result[blockId]?.block).to.equal(undefined);
		expect(result[blockId]?.unavailable).to.equal('peers-unreachable');
	});

	it('returns the fetched block with no flag when the consult succeeds for a locally-missing block', async () => {
		const localPeer = await makePeerId();
		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const cluster = makeClusterPeers([localPeer, peerA, peerB]);

		const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
		// Self holds nothing; the two remote peers corroborate rev 2.
		const callback: ClusterLatestCallback = async (peerId) =>
			peerId.equals(localPeer) ? undefined : remoteLatest;

		const { repo: storageRepo } = makeAbsentThenAdoptingStorageRepo(blockId);
		const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

		const result = await repo.get({ blockIds: [blockId] });

		expect(result[blockId]?.block?.header.id, 'fetched block served').to.equal(blockId);
		expect(result[blockId]?.state?.latest?.rev).to.equal(remoteLatest.rev);
		expect('unavailable' in result[blockId]!).to.equal(false);
	});

	it('keeps the real local answer, unflagged, when a merely-STALE block\'s consult throws', async () => {
		const localPeer = await makePeerId();
		const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);

		// Paranoid read-repair wants to verify the present block; the consult throws.
		// A failed consult on a block with a real local answer stays authoritative.
		const repo = buildRepo(makeThrowingKeyNetwork(), storageRepo, localPeer, async () => undefined, { readRepairMode: 'paranoid' });

		const result = await repo.get({ blockIds: [blockId] });

		expect(result[blockId]?.block?.header.id).to.equal(blockId);
		expect(result[blockId]?.state?.latest?.rev).to.equal(1);
		expect('unavailable' in result[blockId]!).to.equal(false);
	});

	it('stays an authoritative absent when the consult runs but corroborates nothing (the new-collection probe)', async () => {
		const localPeer = await makePeerId();
		const peerA = await makePeerId();
		const peerB = await makePeerId();
		const cluster = makeClusterPeers([localPeer, peerA, peerB]);

		// Every peer answers "I hold nothing" — the healthy cohort's answer to a block
		// that genuinely does not exist yet. Flagging THIS would make creating any
		// collection impossible (the probe would retry and then throw).
		const { repo: storageRepo } = makeAbsentStorageRepo();
		const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, async () => undefined);

		const result = await repo.get({ blockIds: [blockId] });

		expect(result[blockId]!.state).to.deep.equal({});
		expect('unavailable' in result[blockId]!).to.equal(false);
	});

	it('never overwrites storage\'s sharper unmaterializable flag with peers-unreachable', async () => {
		const localPeer = await makePeerId();
		const { repo: storageRepo } = makeUnmaterializableStorageRepo(blockId);

		const repo = buildRepo(makeThrowingKeyNetwork(), storageRepo, localPeer, async () => undefined);

		const result = await repo.get({ blockIds: [blockId] });

		expect(result[blockId]?.unavailable).to.equal('unmaterializable');
	});

	it('skipClusterFetch reads are never flagged (no consult is attempted)', async () => {
		const localPeer = await makePeerId();
		const { repo: storageRepo, calls } = makeAbsentStorageRepo();

		// Even with a key network that would throw, a cluster-internal sync read skips
		// the consult entirely — flagging it would feed the recursion the bypass prevents.
		const repo = buildRepo(makeThrowingKeyNetwork(), storageRepo, localPeer, async () => undefined);

		const result = await repo.get({ blockIds: [blockId] }, { skipClusterFetch: true } as MessageOptions);

		expect(result[blockId]!.state).to.deep.equal({});
		expect('unavailable' in result[blockId]!).to.equal(false);
		expect(calls.length, 'only the plain local read ran').to.equal(1);
	});
});
