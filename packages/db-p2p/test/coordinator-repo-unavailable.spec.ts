/**
 * Tickets: repo-reports-unavailable-vs-absent,
 *          cluster-read-consult-cannot-report-unreachable,
 *          coordinator-serves-stale-data-as-if-confirmed
 *
 * `CoordinatorRepo.get` answers "absent" authoritatively only because it consults the
 * cohort for any block that is missing locally. That consult can come back INCONCLUSIVE
 * three ways — it THROWS, it runs while part of the cohort is SILENT (a per-peer consult
 * that rejects or times out), or it corroborates a revision this node then fails to
 * acquire — and in each the local "absent" is an answer the coordinator just failed to
 * confirm. These specs pin that such an entry is flagged
 * `unavailable: 'peers-unreachable'` instead of posing as an authoritative absent
 * (which NetworkTransactor deliberately never retries).
 *
 * A PRESENT block has the mirror lie: a repair pass that left a cohort peer's claim of a
 * strictly higher revision unsettled (it failed the corroboration quorum, or was
 * corroborated but could not be acquired) must not serve the local content as
 * confirmed-current. Those entries carry `unconfirmedAheadRev` — see the stale-present
 * describe below.
 *
 * Equally important are the answers that must STAY authoritative: a consult where the
 * whole cohort answers and simply corroborates nothing (the common new-collection
 * probe), a merely-stale block whose consult fails (it has a real local answer) or whose
 * cohort is silent without claiming anything, and a cluster-internal sync read
 * (`skipClusterFetch`).
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

/** Storage repo answering the way `StorageRepo.get` does for a pending-only insert read through
 *  its pending overlay: real CONTENT, but no committed revision under it, so `state.latest` is
 *  undefined while `state.pendings` names the overlaid action. */
const makePendingOverlayStorageRepo = (blockId: BlockId): { repo: IRepo } => {
	const repo: IRepo = {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				result[id] = id === blockId
					? {
						block: { header: { id: blockId, type: 'T', collectionId: 'c' as BlockId } },
						state: { pendings: ['p1'] }	// no `latest`: nothing committed yet
					}
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

	it('keeps a pending-only insert\'s CONTENT unflagged when its consult throws', async () => {
		// A block pended but not yet committed is served through the pending overlay: real
		// content, and `state.latest` undefined because there is no committed revision under it.
		// The consult still runs (this node holds no revision, so a cohort may) and here it fails
		// — but the entry is NOT an absence to downgrade. Flagging content this node positively
		// holds would make NetworkTransactor's `isAuthoritative` treat the batch as unanswered
		// and burn its retry budget re-asking peers for a block it already has.
		const localPeer = await makePeerId();
		const { repo: storageRepo } = makePendingOverlayStorageRepo(blockId);

		const repo = buildRepo(makeThrowingKeyNetwork(), storageRepo, localPeer, async () => undefined);

		const result = await repo.get({ blockIds: [blockId] });

		expect(result[blockId]?.block?.header.id, 'the pending content survives').to.equal(blockId);
		expect(result[blockId]?.state?.latest, 'still nothing committed').to.equal(undefined);
		expect('unavailable' in result[blockId]!, 'content is never an unconfirmed absence').to.equal(false);
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

	describe('silent cohort peers (ticket cluster-read-consult-cannot-report-unreachable)', () => {
		it('flags a locally-missing block peers-unreachable when a cohort peer\'s consult rejects', async () => {
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const peerB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA, peerB]);

			// peerA is unreachable — its consult REJECTS, the dial-failure shape of silence.
			// peerB answers "I hold nothing". The silent peer could be the sole holder, so
			// the local absent is a guess the reader must not present as an answer.
			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(peerA)) throw new Error('dial failed');
				return undefined;
			};

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block).to.equal(undefined);
			expect(result[blockId]?.unavailable).to.equal('peers-unreachable');
		});

		it('flags a locally-missing block peers-unreachable when the sole cohort peer never answers (per-peer deadline)', async function () {
			// Real time passes here: the consult's 1s per-peer deadline has to expire.
			this.timeout(5000);
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA]);

			// The two-node topology from the field failure: after self-exclusion there is
			// exactly one peer to consult, and it hangs. Before the deadline rejected, the
			// expiry surfaced as an absent claim and the reader confidently reported the
			// block missing — licencing createOrOpen to invent a rival empty collection.
			const callback: ClusterLatestCallback = async (peerId) =>
				peerId.equals(localPeer) ? undefined : new Promise<never>(() => { /* never settles */ });

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.unavailable).to.equal('peers-unreachable');
		});

		it('serves the corroborated block, unflagged, when the rest of the cohort corroborates past one silent peer', async () => {
			const localPeer = await makePeerId();
			const silentPeer = await makePeerId();
			const holderA = await makePeerId();
			const holderB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, silentPeer, holderA, holderB]);

			const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 2 };
			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(localPeer)) return undefined;
				if (peerId.equals(silentPeer)) throw new Error('dial failed');
				return remoteLatest;
			};

			// Two holders corroborate rev 2, meeting the quorum without the silent peer —
			// the block is restored, which is a real answer and needs no flag.
			const { repo: storageRepo } = makeAbsentThenAdoptingStorageRepo(blockId);
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block?.header.id).to.equal(blockId);
			expect(result[blockId]?.state?.latest?.rev).to.equal(remoteLatest.rev);
			expect('unavailable' in result[blockId]!).to.equal(false);
		});

		it('keeps a merely-STALE block authoritative even when a cohort peer is silent', async () => {
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA]);

			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
				throw new Error('dial failed');
			};

			// Paranoid read-repair consults for the present block and the only peer is
			// silent — but a block with a real local answer is never downgraded.
			const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block?.header.id).to.equal(blockId);
			expect(result[blockId]?.state?.latest?.rev).to.equal(1);
			expect('unavailable' in result[blockId]!).to.equal(false);
		});

		it('a callback that swallows a dial failure into `undefined` still yields an authoritative absent — the contract boundary', async () => {
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA]);

			// This is the PRE-FIX shape of the production callback: catch everything, return
			// `undefined`. The coordinator cannot tell that apart from the peer answering
			// "I hold nothing", so the absent stays authoritative — which is exactly why
			// ClusterLatestCallback implementations must REJECT on transport failure rather
			// than swallow (see the type's doc comment). Pinned so the boundary is explicit.
			const swallowing: ClusterLatestCallback = async () => {
				try {
					throw new Error('dial failed');
				} catch {
					return undefined;
				}
			};

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, swallowing);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]!.state).to.deep.equal({});
			expect('unavailable' in result[blockId]!).to.equal(false);
		});
	});

	describe('stale-present blocks (ticket coordinator-serves-stale-data-as-if-confirmed)', () => {
		it('flags a stale-present block when a reachable peer claims a higher revision it cannot corroborate', async () => {
			// The field failure's exact shape: cohort of three, self (B) holds rev 1, A is
			// reachable and claims rev 2, C is unreachable — and C is unreachable precisely
			// because the record being repaired is C's address, so the repair can never
			// converge. One claim against a corroboration floor of two: the quorum rightly
			// declines (relaxing it is the attack quorum-restore.ts exists to prevent), but
			// the served rev-1 content must say it could not be confirmed current instead of
			// posing as authoritative — that silent pose is what froze a whole collection view.
			const peerB = await makePeerId();  // self — the forked node
			const peerA = await makePeerId();  // reachable, holds the newer revision
			const peerC = await makePeerId();  // unreachable — its address is the record being repaired
			const cluster = makeClusterPeers([peerB, peerA, peerC]);

			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(peerB)) return { actionId: 'old-action', rev: 1 };
				if (peerId.equals(peerA)) return { actionId: 'new-action', rev: 2 };
				throw new Error('dial failed');
			};

			const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, peerB, callback, { readRepairMode: 'paranoid' });

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block?.header.id, 'the local content is still served').to.equal(blockId);
			expect(result[blockId]?.unconfirmedAheadRev, 'but marked as possibly behind rev 2').to.equal(2);
			expect('unavailable' in result[blockId]!, 'currency doubt is not an existence doubt').to.equal(false);
		});

		it('flags a stale-present block when the cohort corroborates a revision this node cannot acquire', async () => {
			// Both other peers agree on rev 3, so it clears the quorum — but nothing can bring
			// the bytes here (no acquisition callback, nothing local to promote). The reader was
			// positively TOLD a newer revision exists; serving rev 1 as confirmed would be a lie.
			const localPeer = await makePeerId();
			const holderA = await makePeerId();
			const holderB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, holderA, holderB]);

			const remoteLatest: ActionRev = { actionId: 'remote-action', rev: 3 };
			const callback: ClusterLatestCallback = async (peerId) =>
				peerId.equals(localPeer) ? { actionId: 'local-action', rev: 1 } : remoteLatest;

			const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block?.header.id).to.equal(blockId);
			expect(result[blockId]?.unconfirmedAheadRev).to.equal(3);
			expect('unavailable' in result[blockId]!).to.equal(false);
		});

		it('never flags when the uncorroborated claim is NOT ahead of what this node holds', async () => {
			// A lone peer claiming the same revision this node already serves is lag or noise,
			// not evidence of doubt — there is nothing to be behind of.
			const peerB = await makePeerId();
			const peerA = await makePeerId();
			const peerC = await makePeerId();
			const cluster = makeClusterPeers([peerB, peerA, peerC]);

			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(peerB)) return { actionId: 'local-action', rev: 1 };
				if (peerId.equals(peerA)) return { actionId: 'local-action', rev: 1 };
				throw new Error('dial failed');
			};

			const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, peerB, callback, { readRepairMode: 'paranoid' });

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block?.header.id).to.equal(blockId);
			expect('unconfirmedAheadRev' in result[blockId]!).to.equal(false);
			expect('unavailable' in result[blockId]!).to.equal(false);
		});

		it('never flags a read pinned BELOW the claimed revision — that view is being served correctly', async () => {
			// A committed read view legitimately pinned at rev 1 asked for rev-1 content and got
			// it; a peer claiming rev 2 says nothing about THAT view. This is what keeps a
			// collection's context-pinned data reads quiet while its unpinned tail read speaks up.
			const peerB = await makePeerId();
			const peerA = await makePeerId();
			const peerC = await makePeerId();
			const cluster = makeClusterPeers([peerB, peerA, peerC]);

			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(peerB)) return { actionId: 'old-action', rev: 1 };
				if (peerId.equals(peerA)) return { actionId: 'new-action', rev: 2 };
				throw new Error('dial failed');
			};

			const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, peerB, callback, { readRepairMode: 'paranoid' });

			const result = await repo.get({
				blockIds: [blockId],
				context: { committed: [{ actionId: 'old-action', rev: 1 }], rev: 1 }
			});

			expect(result[blockId]?.block?.header.id).to.equal(blockId);
			expect('unconfirmedAheadRev' in result[blockId]!).to.equal(false);
		});

		it('flags a read pinned AT or ABOVE the claimed revision — that view should contain the claim', async () => {
			const peerB = await makePeerId();
			const peerA = await makePeerId();
			const peerC = await makePeerId();
			const cluster = makeClusterPeers([peerB, peerA, peerC]);

			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(peerB)) return { actionId: 'old-action', rev: 1 };
				if (peerId.equals(peerA)) return { actionId: 'new-action', rev: 2 };
				throw new Error('dial failed');
			};

			const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, peerB, callback, { readRepairMode: 'paranoid' });

			const result = await repo.get({
				blockIds: [blockId],
				context: { committed: [{ actionId: 'new-action', rev: 2 }], rev: 2 }
			});

			expect(result[blockId]?.unconfirmedAheadRev).to.equal(2);
		});
	});

	describe('corroborated but not restored', () => {
		it('flags a locally-missing block peers-unreachable when the cohort corroborates a revision this node cannot acquire', async () => {
			const localPeer = await makePeerId();
			const holderA = await makePeerId();
			const holderB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, holderA, holderB]);

			// The whole cohort answers — nobody is silent — and two peers corroborate rev 2, so
			// the reader has just been TOLD the block exists. Convergence then fails (no
			// acquisition callback wired, promotion has nothing local to promote), leaving the
			// block missing. Reporting that as an authoritative absent would licence
			// `createOrOpen` to build a rival empty collection over data that demonstrably exists.
			const callback: ClusterLatestCallback = async (peerId) =>
				peerId.equals(localPeer) ? undefined : { actionId: 'remote-action', rev: 2 };

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block, 'nothing was acquired').to.equal(undefined);
			expect(result[blockId]?.unavailable).to.equal('peers-unreachable');
		});
	});
});
