import { expect } from 'chai';
import { localDurability } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type { IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, MessageOptions } from '@optimystic/db-core';
import type { FindCoordinatorOptions } from '@optimystic/db-core';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { ResponsibilityRefusalError, type ResponsibilityRefusalKind } from '../src/repo/responsibility.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { toString as u8ToString } from 'uint8arrays';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/** Build ClusterPeers from an array of PeerIds */
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

/** Stub IKeyNetwork that returns a fixed cluster */
const makeKeyNetwork = (cluster: ClusterPeers): IKeyNetwork => ({
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return { ...cluster };
	}
});

/** No-op storage repo for testing */
const makeStorageRepo = (): IRepo => ({
	async get(_blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		return {};
	},
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [], durability: localDurability() };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> {},
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true, durability: localDurability() };
	}
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

/** Key network whose every lookup throws, as when FRET is not wired on the node; counts its calls. */
const makeThrowingKeyNetwork = (): IKeyNetwork & { calls: number } => {
	const net = {
		calls: 0,
		async findCoordinator(): Promise<PeerId> { throw new Error('not used'); },
		async findCluster(): Promise<ClusterPeers> {
			net.calls++;
			throw new Error('network failure');
		}
	};
	return net;
};

/** Run `op`, expecting a responsibility refusal of `kind` naming exactly `blockIds`. */
const expectRefusal = async (op: () => Promise<unknown>, kind: ResponsibilityRefusalKind, blockIds: string[]): Promise<ResponsibilityRefusalError> => {
	let thrown: unknown;
	try {
		await op();
	} catch (err) {
		thrown = err;
	}
	expect(thrown, 'the write is refused').to.be.instanceOf(ResponsibilityRefusalError);
	const refusal = thrown as ResponsibilityRefusalError;
	expect(refusal.kind).to.equal(kind);
	expect([...refusal.blockIds]).to.deep.equal(blockIds);
	return refusal;
};

describe('CoordinatorRepo proximity verification', () => {
	const blockId = 'test-block-id-1';

	describe('when localPeerId is not set (backward compatibility)', () => {
		it('allows all operations without verification', async () => {
			const singlePeer = await makePeerId();
			// Single-peer cluster → fast path (no consensus needed)
			const cluster = makeClusterPeers([singlePeer]);
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				makeStorageRepo()
			);

			// get should work
			const getResult = await repo.get({ blockIds: [blockId] });
			expect(getResult).to.deep.equal({});

			// pend should work (peerCount=1 → fast path to storageRepo)
			const pendResult = await repo.pend({
				actionId: 'action-1' as any,
				transforms: { inserts: {}, updates: { [blockId]: [] }, deletes: [] },
				blockIds: [blockId]
			} as any);
			expect(pendResult.success).to.equal(true);
		});
	});

	describe('when node IS in cluster (responsible)', () => {
		it('allows get, pend, commit via fast path', async () => {
			const localPeer = await makePeerId();

			// Cluster includes only localPeer → fast path (peerCount=1, no consensus needed)
			const cluster = makeClusterPeers([localPeer]);
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize: 3 },
				undefined,
				localPeer
			);

			// get should succeed
			const getResult = await repo.get({ blockIds: [blockId] });
			expect(getResult).to.deep.equal({});

			// pend should succeed (peerCount=1 → fast path to storageRepo)
			const pendResult = await repo.pend({
				actionId: 'action-1' as any,
				transforms: { inserts: {}, updates: { [blockId]: [] }, deletes: [] },
				blockIds: [blockId]
			} as any);
			expect(pendResult.success).to.equal(true);

			// commit should succeed (peerCount=1 → fast path to storageRepo)
			const commitResult = await repo.commit({
				actionId: 'action-1' as any,
				blockIds: [blockId]
			} as any);
			expect(commitResult.success).to.equal(true);
		});
	});

	describe('when node is NOT in cluster (not responsible)', () => {
		let localPeer: PeerId;
		let cluster: ClusterPeers;

		beforeEach(async () => {
			localPeer = await makePeerId();
			const otherPeers = await Promise.all([1, 2, 3].map(() => makePeerId()));
			// Cluster does NOT include localPeer
			cluster = makeClusterPeers(otherPeers);
		});

		it('allows get with warning (soft check)', async () => {
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize: 3 },
				undefined,
				localPeer
			);

			// get should still succeed (soft check — warns but serves)
			const result = await repo.get({ blockIds: [blockId] });
			expect(result).to.deep.equal({});
		});

		it('refuses a pend as not-responsible', async () => {
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize: 3 },
				undefined,
				localPeer
			);

			const refusal = await expectRefusal(() => repo.pend({
				actionId: 'action-1' as any,
				transforms: { inserts: {}, updates: { [blockId]: [] }, deletes: [] },
				blockIds: [blockId]
			} as any), 'not-responsible', [blockId]);
			expect(refusal.message).to.include('Not responsible for block');
		});

		it('refuses a cancel as not-responsible', async () => {
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize: 3 },
				undefined,
				localPeer
			);

			await expectRefusal(() => repo.cancel({ actionId: 'action-1' as any, blockIds: [blockId] }), 'not-responsible', [blockId]);
		});

		it('refuses a commit as not-responsible', async () => {
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize: 3 },
				undefined,
				localPeer
			);

			await expectRefusal(() => repo.commit({ actionId: 'action-1' as any, blockIds: [blockId] } as any), 'not-responsible', [blockId]);
		});

		it('names every non-responsible block in the refusal', async () => {
			const repo = new CoordinatorRepo(
				makeKeyNetwork(cluster),
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize: 3 },
				undefined,
				localPeer
			);

			const refusal = await expectRefusal(() => repo.pend({
				actionId: 'action-1' as any,
				transforms: { inserts: {}, updates: { 'block-a': [], 'block-b': [] }, deletes: [] },
				blockIds: ['block-a', 'block-b']
			} as any), 'not-responsible', ['block-a', 'block-b']);
			expect(refusal.message).to.include('block-a');
			expect(refusal.message).to.include('block-b');
		});
	});

	describe('caching', () => {
		it('caches cluster membership result and reuses it', async () => {
			const localPeer = await makePeerId();
			const otherPeers = await Promise.all([1, 2].map(() => makePeerId()));

			let findClusterCalls = 0;
			const keyNetwork: IKeyNetwork = {
				async findCoordinator() { throw new Error('not used'); },
				async findCluster() {
					findClusterCalls++;
					return makeClusterPeers([localPeer, ...otherPeers]);
				}
			};

			const repo = new CoordinatorRepo(
				keyNetwork,
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize: 3 },
				undefined,
				localPeer
			);

			// First call populates cache
			await repo.get({ blockIds: [blockId] });
			expect(findClusterCalls).to.equal(1);

			// Second call should use cache
			await repo.get({ blockIds: [blockId] });
			expect(findClusterCalls).to.equal(1);
		});
	});

	/**
	 * A thrown lookup used to read as "responsible" everywhere — the acceptance half of GitHub #19, where a
	 * phone whose every cohort lookup threw committed solo and answered plain success. Writes now fail
	 * CLOSED with a refusal distinct from "not responsible"; reads stay open.
	 */
	describe('when the cohort lookup throws', () => {
		const buildRepo = async (keyNetwork: IKeyNetwork): Promise<CoordinatorRepo> => new CoordinatorRepo(
			keyNetwork,
			makeClusterClient,
			makeStorageRepo(),
			{ clusterSize: 3 },
			undefined,
			await makePeerId()
		);

		it('still serves a read (fail-open)', async () => {
			const repo = await buildRepo(makeThrowingKeyNetwork());

			const result = await repo.get({ blockIds: [blockId] });
			expect(result).to.deep.equal({});
		});

		it('refuses pend, cancel and commit as undetermined (fail-closed)', async () => {
			const repo = await buildRepo(makeThrowingKeyNetwork());

			const refusal = await expectRefusal(() => repo.pend({
				actionId: 'action-1' as any,
				transforms: { inserts: {}, updates: { [blockId]: [] }, deletes: [] },
				blockIds: [blockId]
			} as any), 'undetermined', [blockId]);
			expect(refusal.message, 'a routing fault reads differently from a misroute').to.not.include('Not responsible');
			await expectRefusal(() => repo.cancel({ actionId: 'action-1' as any, blockIds: [blockId] }), 'undetermined', [blockId]);
			await expectRefusal(() => repo.commit({ actionId: 'action-1' as any, blockIds: [blockId] } as any), 'undetermined', [blockId]);
		});

		it('never caches a failed lookup: the next write asks again', async () => {
			const keyNetwork = makeThrowingKeyNetwork();
			const repo = await buildRepo(keyNetwork);

			await expectRefusal(() => repo.commit({ actionId: 'action-1' as any, blockIds: [blockId] } as any), 'undetermined', [blockId]);
			await expectRefusal(() => repo.commit({ actionId: 'action-1' as any, blockIds: [blockId] } as any), 'undetermined', [blockId]);
			expect(keyNetwork.calls).to.equal(2);
		});

		it('refuses a whole multi-block pend when one block cannot be determined, naming that block', async () => {
			const localPeer = await makePeerId();
			const keyNetwork: IKeyNetwork = {
				async findCoordinator() { throw new Error('not used'); },
				async findCluster(key: Uint8Array) {
					if (new TextDecoder().decode(key) === 'block-lost') throw new Error('network failure');
					return makeClusterPeers([localPeer]);
				}
			};
			const repo = new CoordinatorRepo(keyNetwork, makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);

			await expectRefusal(() => repo.pend({
				actionId: 'action-1' as any,
				transforms: { inserts: {}, updates: { 'block-fine': [], 'block-lost': [] }, deletes: [] },
				blockIds: ['block-fine', 'block-lost']
			} as any), 'undetermined', ['block-lost']);
		});

		it('reports not-responsible when the other blocks settle that the write is misrouted', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const keyNetwork: IKeyNetwork = {
				async findCoordinator() { throw new Error('not used'); },
				async findCluster(key: Uint8Array) {
					if (new TextDecoder().decode(key) === 'block-lost') throw new Error('network failure');
					return makeClusterPeers([otherPeer]);
				}
			};
			const repo = new CoordinatorRepo(keyNetwork, makeClusterClient, makeStorageRepo(), { clusterSize: 3 }, undefined, localPeer);

			await expectRefusal(() => repo.pend({
				actionId: 'action-1' as any,
				transforms: { inserts: {}, updates: { 'block-elsewhere': [], 'block-lost': [] }, deletes: [] },
				blockIds: ['block-elsewhere', 'block-lost']
			} as any), 'not-responsible', ['block-elsewhere']);
		});
	});

	describe('mixed blocks (some responsible, some not)', () => {
		it('throws when any block is not in cluster', async () => {
			const localPeer = await makePeerId();
			const otherPeer = await makePeerId();
			const responsibleBlockId = 'block-alpha';
			const nonResponsibleBlockId = 'block-beta';

			// Return different clusters per block key
			const keyNetwork: IKeyNetwork = {
				async findCoordinator() { throw new Error('not used'); },
				async findCluster(key: Uint8Array) {
					const keyStr = new TextDecoder().decode(key);
					if (keyStr === responsibleBlockId) {
						return makeClusterPeers([localPeer, otherPeer]);
					}
					return makeClusterPeers([otherPeer]); // localPeer not in cluster
				}
			};

			const repo = new CoordinatorRepo(
				keyNetwork,
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize: 3 },
				undefined,
				localPeer
			);

			await expectRefusal(() => repo.pend({
				actionId: 'action-1' as any,
				transforms: {
					inserts: {},
					updates: {
						[responsibleBlockId]: [],
						[nonResponsibleBlockId]: []
					},
					deletes: []
				},
				blockIds: [responsibleBlockId, nonResponsibleBlockId]
			} as any), 'not-responsible', [nonResponsibleBlockId]);
		});
	});

	describe('pend block id extraction (regression for Object.keys(transforms) bug)', () => {
		it('uses actual block ids from transforms, not the literal keys "inserts"/"updates"/"deletes"', async () => {
			const localPeer = await makePeerId();
			const insertedBlockId = 'inserted-block';
			const updatedBlockId = 'updated-block';
			const deletedBlockId = 'deleted-block';

			const verified: string[] = [];
			const keyNetwork: IKeyNetwork = {
				async findCoordinator() { throw new Error('not used'); },
				async findCluster(key: Uint8Array) {
					const keyStr = new TextDecoder().decode(key);
					verified.push(keyStr);
					return makeClusterPeers([localPeer]);
				}
			};

			const repo = new CoordinatorRepo(
				keyNetwork,
				makeClusterClient,
				makeStorageRepo(),
				{ clusterSize: 3 },
				undefined,
				localPeer
			);

			const result = await repo.pend({
				actionId: 'action-multi' as any,
				transforms: {
					inserts: { [insertedBlockId]: { header: { id: insertedBlockId } } as any },
					updates: { [updatedBlockId]: [] },
					deletes: [deletedBlockId]
				},
				blockIds: [insertedBlockId, updatedBlockId, deletedBlockId]
			} as any);

			expect(result.success).to.equal(true);
			// Only real block ids should have been passed to findCluster — never the literal
			// Transforms container keys.
			expect(verified).to.not.include('inserts');
			expect(verified).to.not.include('updates');
			expect(verified).to.not.include('deletes');
			expect(verified).to.include.members([insertedBlockId, updatedBlockId, deletedBlockId]);
		});
	});
});
