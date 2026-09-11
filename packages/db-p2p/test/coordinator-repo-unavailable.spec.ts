/**
 * Tickets: repo-reports-unavailable-vs-absent,
 *          cluster-read-consult-cannot-report-unreachable,
 *          coordinator-serves-stale-data-as-if-confirmed,
 *          absence-verdict-names-the-evidence
 *
 * `CoordinatorRepo.get` answers "absent" authoritatively only because it consults the
 * cohort for any block that is missing locally. That consult can fail to rule the block
 * out several ways, and the flag NAMES which one — the local "absent" is an answer the
 * coordinator just failed to confirm, and the reason says what the consult established:
 *  - `'peers-unreachable'` — the consult THREW, or part of the cohort answered while
 *    part stayed silent (a per-peer consult that rejects or times out). Another, better-
 *    connected coordinator may still settle it.
 *  - `'cohort-unreachable'` — NO cohort member outside this node could be asked at all:
 *    there is no better-connected coordinator to re-ask; this node's view is all there is.
 *  - `'claimed-elsewhere'` — a cohort peer positively CLAIMED a revision that could be
 *    neither corroborated to a quorum nor acquired; the block is known to exist somewhere.
 * Each is flagged instead of posing as an authoritative absent (which NetworkTransactor
 * deliberately never retries).
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
import { captureLog, hasTagAtRev } from './support/capture-log.js';

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

		it('flags a locally-missing block cohort-unreachable when the sole cohort peer never answers (per-peer deadline)', async function () {
			// Real time passes here: the consult's 1s per-peer deadline has to expire.
			this.timeout(5000);
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA]);

			// The two-node topology from the field failure: after self-exclusion there is
			// exactly one peer to consult, and it hangs. Before the deadline rejected, the
			// expiry surfaced as an absent claim and the reader confidently reported the
			// block missing — licencing createOrOpen to invent a rival empty collection.
			// With NO non-self cohort member answering, this is isolation, not partial
			// silence: 'cohort-unreachable' tells the caller no better-connected
			// coordinator exists to re-ask.
			const callback: ClusterLatestCallback = async (peerId) =>
				peerId.equals(localPeer) ? undefined : new Promise<never>(() => { /* never settles */ });

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.unavailable).to.equal('cohort-unreachable');
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
			// It is not remembered afterwards: only a cohort of one settles an absence for a window
			// (ticket a-block-we-do-not-hold-is-consulted-on-every-read), so on this two-member cohort
			// the next read asks again.
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

		// The doubt has to outlive the consult that formed it. A corroborated-but-unacquired pass
		// marks the block SEEN (that is what the read-repair window tracks), so in the default
		// `lazy` mode the next reads inside the window consult nobody — and if the mark lived only
		// in the consult's return value, every one of them would serve the same content as
		// confirmed. That is the original lie, re-opened `readRepairWindowMs` at a time.
		describe('the mark outlives the consult (read-repair window)', () => {
			/** Cohort of three where both remote peers claim `remoteRev` and nothing can acquire it,
			 *  so every pass corroborates a revision this node fails to converge onto.
			 *
			 *  The returned `cluster` object is the SAME one `makeKeyNetwork` reads on every
			 *  `findCluster` (it spreads at call time), so a spec can shrink the cohort between reads
			 *  by deleting keys from it — that is how the solo-self and empty-cohort variants below
			 *  reach the exits that consult nobody. `silenceRemotes()` is the third variant: the
			 *  cohort stays whole and both remote callbacks reject instead. */
			const buildUnacquirableCohort = async (remoteRev: number) => {
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let consults = 0;
				let remotesSilent = false;
				const callback: ClusterLatestCallback = async (peerId) => {
					consults++;
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
					if (remotesSilent) throw new Error('dial failed');
					return { actionId: 'remote-action', rev: remoteRev };
				};
				return {
					localPeer, holderA, holderB, cluster, callback,
					consultCount: () => consults,
					silenceRemotes: () => { remotesSilent = true; }
				};
			};

			/** Drop every peer but `keep` from the cohort view, in place, so the next `findCluster`
			 *  returns the shrunken cohort. Pass nothing to empty it entirely. */
			const shrinkCohort = (cluster: ClusterPeers, keep?: PeerId): void => {
				for (const id of Object.keys(cluster)) {
					if (keep === undefined || id !== keep.toString()) delete cluster[id];
				}
			};

			it('keeps marking a read whose consult the window skipped', async () => {
				const { localPeer, cluster, callback, consultCount } = await buildUnacquirableCohort(3);
				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'lazy' });

				const first = await repo.get({ blockIds: [blockId] });
				expect(first[blockId]?.unconfirmedAheadRev, 'the consulting read is marked').to.equal(3);

				const afterFirst = consultCount();
				const second = await repo.get({ blockIds: [blockId] });

				expect(consultCount(), 'the read-repair window suppressed the second consult').to.equal(afterFirst);
				expect(second[blockId]?.unconfirmedAheadRev, 'the remembered claim still marks it').to.equal(3);
			});

			it('drops the mark once a consult finds nothing ahead any more', async () => {
				// The claim was settled (or the claimant caught up / went away). A consult DID run,
				// so it is the authority — the remembered doubt must not outlive its refutation.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let remoteRev = 3;
				const callback: ClusterLatestCallback = async (peerId) =>
					peerId.equals(localPeer)
						? { actionId: 'local-action', rev: 1 }
						: { actionId: remoteRev === 1 ? 'local-action' : 'remote-action', rev: remoteRev };

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				remoteRev = 1;	// the cohort now agrees with what this node holds
				const after = await repo.get({ blockIds: [blockId] });

				expect('unconfirmedAheadRev' in after[blockId]!, 'the refuted claim is forgotten').to.equal(false);
			});

			it('drops the mark once this node reaches the claimed revision', async () => {
				// Even with the window suppressing consults, a block that caught up (a commit landed
				// here) is no longer behind anything — nothing left to doubt.
				const { localPeer, cluster, callback } = await buildUnacquirableCohort(3);
				let heldRev = 1;
				const storageRepo: IRepo = {
					async get(blockGets: BlockGets): Promise<GetBlockResults> {
						return Object.fromEntries(blockGets.blockIds.map(id => [id, id === blockId
							? { block: { header: { id: blockId, type: 'T', collectionId: 'c' as BlockId } }, state: { latest: { actionId: 'local-action', rev: heldRev } } }
							: { state: {} }]));
					},
					...writeStubs
				};
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'lazy' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				heldRev = 3;	// a commit landed locally
				const after = await repo.get({ blockIds: [blockId] });

				expect('unconfirmedAheadRev' in after[blockId]!, 'caught up — nothing to doubt').to.equal(false);
			});

			// A consult that reached NOBODY refutes nothing (ticket
			// a-consult-that-asked-nobody-erases-recorded-doubt). Three exits of
			// `fetchBlockFromCluster` ask no cohort member at all — solo-self, empty cohort, and every
			// asked peer staying silent — and each used to report the same "no claim" the healthy
			// no-claim case reports, erasing a memo an earlier pass recorded and serving the stale
			// copy as confirmed-current. All three run in `paranoid` mode so a consult definitely
			// RUNS on the second read: this is about what a running consult learned, not about the
			// read-repair window suppressing it (that is the first spec in this describe).
			it('keeps the mark when the cohort shrinks to this node alone (solo-self exit)', async () => {
				const { localPeer, cluster, callback } = await buildUnacquirableCohort(3);
				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				// The two holders drop out of the cohort view — a mid-identify or churning routing
				// table. The solo short-circuit now runs, dialling nobody. It learned nothing about
				// the claim, so it must not clear it.
				shrinkCohort(cluster, localPeer);
				const after = await repo.get({ blockIds: [blockId] });

				expect(after[blockId]?.unconfirmedAheadRev, 'a solo consult refutes nothing').to.equal(3);
			});

			it('keeps the mark when the cohort lookup comes back empty (empty-cohort exit)', async () => {
				const { localPeer, cluster, callback } = await buildUnacquirableCohort(3);
				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				// An empty cohort is a routing failure, not an answer — the sharpest form of "asked
				// nobody" there is.
				shrinkCohort(cluster);
				const after = await repo.get({ blockIds: [blockId] });

				expect(after[blockId]?.unconfirmedAheadRev, 'an empty cohort refutes nothing').to.equal(3);
			});

			it('keeps the mark when every cohort peer goes silent (total silence)', async () => {
				const { localPeer, cluster, callback, silenceRemotes } = await buildUnacquirableCohort(3);
				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				// The whole cohort is still in the view and every one of them rejects. The consult
				// ran, dialled, and came back with nothing — no evidence, same as never asking.
				// This is the common field shape and the one unaffected by read-repair-window arming.
				silenceRemotes();
				const after = await repo.get({ blockIds: [blockId] });

				expect(after[blockId]?.unconfirmedAheadRev, 'total silence refutes nothing').to.equal(3);
			});

			it('drops the mark when the surviving claim fails quorum AND is not ahead of us', async () => {
				// The remaining "nothing ahead" row the fix left argued rather than asserted: the
				// no-quorum exit, reached with a claim present that is NOT ahead of this node's
				// baseline. It falls to the shared `nothingAheadVerdict`, which is only correct
				// there because a claim can exist at all only when a peer answered. Pinning it
				// keeps that reasoning honest if the shared verdict is ever re-keyed.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let phase = 1;
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 2 };
					if (phase === 1) return { actionId: 'remote-action', rev: 3 };
					// Same revision as this node holds, and the two peers name DIFFERENT actions, so
					// the quorum declines and the claim survives only as `uncorroboratedRev`.
					return { actionId: peerId.equals(holderA) ? 'fork-a' : 'fork-b', rev: 2 };
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 2);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				phase = 2;
				const after = await repo.get({ blockIds: [blockId] });

				expect('unconfirmedAheadRev' in after[blockId]!, 'an answered claim level with us refutes the old one').to.equal(false);
			});

			it('drops the mark when peers answer with a claim strictly BELOW what this node holds', async () => {
				// The refutation that must keep working, and the row most easily broken by an
				// over-cautious reading of the ticket above: peers DID answer, and what they hold is
				// behind this node — so nothing is ahead and the memo goes. Distinct from the
				// equality case in `drops the mark once a consult finds nothing ahead any more`, and
				// deliberately arranged so the served revision (2) stays BELOW the memo (3): the
				// catch-up branch in `flagUnconfirmedCurrency` cannot fire, leaving the refutation
				// itself as the only thing that can clear the mark.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let remoteRev = 3;
				const callback: ClusterLatestCallback = async (peerId) =>
					peerId.equals(localPeer)
						? { actionId: 'local-action', rev: 2 }
						: { actionId: 'remote-action', rev: remoteRev };

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 2);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				remoteRev = 1;	// the cohort now holds LESS than this node
				const after = await repo.get({ blockIds: [blockId] });

				expect('unconfirmedAheadRev' in after[blockId]!, 'answered peers behind us refute the claim').to.equal(false);
			});

			// Only the peers that MADE a claim can retire it (ticket
			// currency-doubt-cleared-by-a-partial-answer). "Somebody answered and said nothing is
			// ahead" used to be enough, so a peer that never knew the claimed revision could erase
			// the memo the moment the peer holding that revision went unreachable — the silent stale
			// serve this marker exists to end. The rule is now: retire when at least one non-self
			// cohort member answered AND no peer that made the claim was silent. All of these run in
			// `paranoid` mode so a consult definitely RUNS on the second read.
			it('keeps the mark under PARTIAL silence — a silent claimant is not spoken for', async () => {
				// Read 1: both remote peers claim rev 3 and nothing can acquire it. Read 2: holder A
				// (a claimant) is unreachable and holder B answers "I hold nothing". B never reported
				// rev 3, so its answer is no evidence about A's claim.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let phase = 1;
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
					if (phase === 1) return { actionId: 'remote-action', rev: 3 };
					if (peerId.equals(holderA)) throw new Error('dial failed');
					return undefined;	// holder B answers, holding nothing
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				phase = 2;
				const after = await repo.get({ blockIds: [blockId] });

				expect(after[blockId]?.unconfirmedAheadRev, 'a non-claimant cannot retire a silent peer\'s claim').to.equal(3);
			});

			it('keeps the mark when the ONLY claimant goes silent and the other peer never knew the claim', async () => {
				// The sharpest form of the same defect: holder B answers "I hold nothing" on BOTH
				// reads, so it demonstrably never knew rev 3. Holder A is the sole claimant, and when
				// it drops out its word is the only thing that could retire the doubt.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let holderAReachable = true;
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
					if (peerId.equals(holderB)) return undefined;
					if (!holderAReachable) throw new Error('dial failed');
					return { actionId: 'remote-action', rev: 3 };
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev, 'one claim, quorum declines, doubt recorded').to.equal(3);

				holderAReachable = false;
				const after = await repo.get({ blockIds: [blockId] });

				expect(after[blockId]?.unconfirmedAheadRev, 'the sole holder of rev 3 is unreachable — nothing refutes it').to.equal(3);
			});

			it('drops the mark when the claimant itself answers, even with another peer silent', async () => {
				// The rule must not degrade into "any silence blocks retirement" — that would flag a
				// block forever behind one permanently unreachable cohort peer. Here holder A, the
				// only peer that ever claimed rev 3, answers rev 1: it has retired its own word. B is
				// silent, but B never claimed anything, so its silence is irrelevant to this claim.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let phase = 1;
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
					if (peerId.equals(holderB)) {
						if (phase === 1) return undefined;
						throw new Error('dial failed');
					}
					return phase === 1 ? { actionId: 'remote-action', rev: 3 } : { actionId: 'local-action', rev: 1 };
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				phase = 2;
				const after = await repo.get({ blockIds: [blockId] });

				expect('unconfirmedAheadRev' in after[blockId]!, 'the claimant retired its own claim').to.equal(false);
			});

			it('drops the mark once the claimant leaves the cohort view — membership, not a timer, settles the doubt', async () => {
				// What bounds the doubt when a claimant never comes back. There is deliberately no
				// expiry: erasing a correctness signal because time passed re-opens the same lie
				// through a slower door. Instead, a peer that is genuinely gone leaves the routing
				// table, so `findCluster` stops holding it responsible for the block — it is then
				// neither an answer nor a silence, and its old word no longer binds the cohort.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
					if (peerId.equals(holderA)) return { actionId: 'remote-action', rev: 3 };
					return undefined;	// holder B holds nothing, throughout
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				// The claimant departs the cohort view. Two peers remain, so this is still a real
				// consult (not the solo-self exit), and holder B answers it.
				delete cluster[holderA.toString()];
				const after = await repo.get({ blockIds: [blockId] });

				expect('unconfirmedAheadRev' in after[blockId]!, 'a departed claimant stops blocking retirement').to.equal(false);
			});

			it('accumulates claimants across passes that claim the SAME revision', async () => {
				// Two passes hear rev 3 from DIFFERENT peers. If the second pass simply replaced the
				// recorded claimants, holder A's still-unanswered word would be forgotten and the
				// third pass — where A is silent and B answers "I hold nothing" — would retire the
				// claim on B's answer alone. Claimants for an unchanged revision therefore union.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let pass = 1;
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
					if (peerId.equals(holderA)) {
						if (pass === 1) return { actionId: 'remote-action', rev: 3 };
						throw new Error('dial failed');	// silent from pass 2 onward
					}
					// Holder B claims rev 3 only on pass 2 — one claim per pass, so the corroboration
					// quorum declines throughout and every pass records the claim uncorroborated.
					return pass === 2 ? { actionId: 'remote-action', rev: 3 } : undefined;
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev, 'pass 1: A claims 3').to.equal(3);

				pass = 2;
				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev, 'pass 2: B claims 3, A silent').to.equal(3);

				pass = 3;
				const after = await repo.get({ blockIds: [blockId] });

				expect(after[blockId]?.unconfirmedAheadRev, 'A is still a claimant and still silent').to.equal(3);
			});

			it('this node\'s own answer refutes nothing, even with localPeerId left unset', async () => {
				// `localPeerId` is optional for the single-node/test construction this class has
				// always tolerated, and with it unset this node's own answer counts as a peer answer.
				// That used to reach "somebody answered, nothing is ahead" off this node agreeing
				// with itself and erase the memo. Provenance closes it without touching the
				// constructor: the claimant recorded is the REMOTE peer that reported rev 3 (this
				// node's own answer reads the storage being repaired, so it can only ever corroborate
				// the revision already held), and when that peer goes silent the memo stands.
				const nodePeer = await makePeerId();
				const holderA = await makePeerId();
				const cluster = makeClusterPeers([nodePeer, holderA]);
				let holderAReachable = true;
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(nodePeer)) return { actionId: 'local-action', rev: 1 };
					if (!holderAReachable) throw new Error('dial failed');
					return { actionId: 'remote-action', rev: 3 };
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				// Built directly rather than through `buildRepo`: the whole point is the unset
				// `localPeerId` (the sixth constructor argument).
				const repo = new CoordinatorRepo(
					makeKeyNetwork(cluster),
					makeClusterClient,
					storageRepo,
					{ clusterSize: 3, readRepairMode: 'paranoid' },
					undefined,
					undefined,
					undefined,
					callback
				);

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(3);

				holderAReachable = false;
				const after = await repo.get({ blockIds: [blockId] });

				expect(after[blockId]?.unconfirmedAheadRev, 'agreeing with itself retires nothing').to.equal(3);
			});

			// Retiring a claim and revising it DOWN are the same act, so they answer to the same
			// rule. A lower claim replacing a higher one used to slip past the retirement check
			// entirely and drop the higher claimant's word — the same erasure by a peer that never
			// made the claim, one step less obvious, and it erases the mark outright once this node
			// reaches the lower revision.
			it('keeps the HIGHER recorded claim when a lower one arrives while the higher claimant is silent', async () => {
				// Read 1: holder A alone claims rev 5 — one claim of two non-self peers, so the
				// corroboration quorum declines and rev 5 is recorded as A's unsettled claim. Read 2:
				// A is unreachable and holder B claims rev 3. B never reported rev 5, so its lower
				// claim is no evidence that rev 5 does not exist.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let phase = 1;
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
					if (peerId.equals(holderA)) {
						if (phase === 2) throw new Error('dial failed');
						return { actionId: 'remote-action', rev: 5 };
					}
					return phase === 1 ? undefined : { actionId: 'other-action', rev: 3 };
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev, 'A claims 5, quorum declines').to.equal(5);

				phase = 2;
				const after = await repo.get({ blockIds: [blockId] });

				expect(after[blockId]?.unconfirmedAheadRev, 'a lower claim cannot revise away the higher claim of a silent peer').to.equal(5);
			});

			it('lets a lower claim replace the recorded one once the higher claimant has answered', async () => {
				// The over-correction side: keeping the higher claim forever would deny reads on the
				// word of a peer that has since answered. Here holder A, the only claimant of rev 5,
				// answers rev 2 on read 2 — it has retired its own word — so holder B's rev 3 claim
				// becomes the whole of the recorded doubt.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let phase = 1;
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
					if (peerId.equals(holderA)) {
						return phase === 1 ? { actionId: 'remote-action', rev: 5 } : { actionId: 'lagging-action', rev: 2 };
					}
					return phase === 1 ? undefined : { actionId: 'other-action', rev: 3 };
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				expect((await repo.get({ blockIds: [blockId] }))[blockId]?.unconfirmedAheadRev).to.equal(5);

				phase = 2;
				const after = await repo.get({ blockIds: [blockId] });

				expect(after[blockId]?.unconfirmedAheadRev, 'the rev-5 claimant answered, so the doubt is now the rev 3 holder B reported').to.equal(3);
			});

			it('names the unreachable claimant in the log — the only operator signal that doubt cannot settle', async () => {
				// A block whose mark can never be cleared from this node looks, from the outside,
				// exactly like a block that is genuinely behind: every read carries the same marker.
				// `cluster-fetch:claim-unrefutable` is what tells an operator the difference — the
				// claimant is unreachable rather than the content stale — so it is worth pinning.
				const localPeer = await makePeerId();
				const holderA = await makePeerId();
				const holderB = await makePeerId();
				const cluster = makeClusterPeers([localPeer, holderA, holderB]);
				let holderAReachable = true;
				const callback: ClusterLatestCallback = async (peerId) => {
					if (peerId.equals(localPeer)) return { actionId: 'local-action', rev: 1 };
					if (peerId.equals(holderB)) return undefined;
					if (!holderAReachable) throw new Error('dial failed');
					return { actionId: 'remote-action', rev: 3 };
				};

				const { repo: storageRepo } = makePresentStorageRepo(blockId, 1);
				const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback, { readRepairMode: 'paranoid' });

				await repo.get({ blockIds: [blockId] });	// records A's rev-3 claim

				holderAReachable = false;
				const captured = await captureLog('coordinator-repo', async () => {
					await repo.get({ blockIds: [blockId] });
				});

				expect(hasTagAtRev(captured, 'cluster-fetch:claim-unrefutable', 3), 'the declined retirement is named').to.equal(true);
				const line = captured.find(args => typeof args[0] === 'string' && args[0].includes('cluster-fetch:claim-unrefutable'))!;
				expect((line[1] as { silentClaimants: string[] }).silentClaimants, 'and it names WHO is unreachable')
					.to.deep.equal([holderA.toString()]);
			});
		});
	});

	describe('corroborated but not restored', () => {
		it('flags a locally-missing block claimed-elsewhere when the cohort corroborates a revision this node cannot acquire', async () => {
			const localPeer = await makePeerId();
			const holderA = await makePeerId();
			const holderB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, holderA, holderB]);

			// The whole cohort answers — nobody is silent — and two peers corroborate rev 2, so
			// the reader has just been TOLD the block exists. Convergence then fails (no
			// acquisition callback wired, promotion has nothing local to promote), leaving the
			// block missing. Reporting that as an authoritative absent would licence
			// `createOrOpen` to build a rival empty collection over data that demonstrably
			// exists — and because the cohort positively attested the block, the flag is
			// 'claimed-elsewhere', not the silence-shaped 'peers-unreachable'.
			const callback: ClusterLatestCallback = async (peerId) =>
				peerId.equals(localPeer) ? undefined : { actionId: 'remote-action', rev: 2 };

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block, 'nothing was acquired').to.equal(undefined);
			expect(result[blockId]?.unavailable).to.equal('claimed-elsewhere');
		});
	});

	describe('absence verdicts name the evidence (ticket absence-verdict-names-the-evidence)', () => {
		it('flags claimed-elsewhere when a lone peer claims a revision the quorum declines', async () => {
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const peerB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA, peerB]);

			// peerA positively claims rev 2; self and peerB answer "I hold nothing"; nobody is
			// silent. One claim against a corroboration floor of two: the quorum rightly declines
			// (a lone unverifiable claim must never drive restoration), but the reader has just
			// been TOLD the block exists — an unflagged absent here is the same lie the
			// present-block path stopped telling via `unconfirmedAheadRev`, mirrored onto the
			// missing path.
			const callback: ClusterLatestCallback = async (peerId) =>
				peerId.equals(peerA) ? { actionId: 'remote-action', rev: 2 } : undefined;

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block).to.equal(undefined);
			expect(result[blockId]?.unavailable).to.equal('claimed-elsewhere');
			// The two doubt markers stay disjoint by meaning: `unavailable` is existence doubt,
			// `unconfirmedAheadRev` is currency doubt on served content — a blockless entry
			// must never carry the latter.
			expect('unconfirmedAheadRev' in result[blockId]!).to.equal(false);
		});

		it('a claim outranks silence: still claimed-elsewhere when the other peer is also silent', async () => {
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const peerB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA, peerB]);

			// Same lone claim from peerA, but peerB rejects instead of answering. A peer
			// positively saying "it exists" is the sharpest fact available — sharper than
			// whatever a silent peer might have said — so the claim verdict wins.
			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(peerA)) return { actionId: 'remote-action', rev: 2 };
				if (peerId.equals(peerB)) throw new Error('dial failed');
				return undefined;
			};

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.unavailable).to.equal('claimed-elsewhere');
		});

		it('flags cohort-unreachable when the sole cohort peer rejects', async () => {
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA]);

			// The isolated-node shape: after self-exclusion there is one peer to consult and it
			// cannot be dialled. Nobody outside this node was reached, so there is no
			// better-connected coordinator for the caller to re-ask — a different fact from
			// partial silence, and the one an isolation policy above needs.
			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(localPeer)) return undefined;
				throw new Error('dial failed');
			};

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.block).to.equal(undefined);
			expect(result[blockId]?.unavailable).to.equal('cohort-unreachable');
		});

		it('flags cohort-unreachable when every non-self cohort member rejects — isolation is about reach, not cohort size', async () => {
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const peerB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA, peerB]);

			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(localPeer)) return undefined;
				throw new Error('dial failed');
			};

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.unavailable).to.equal('cohort-unreachable');
		});

		it('partial reach is NOT isolation: peers-unreachable when one peer rejects but another answers', async () => {
			// Overlaps the silent-cohort spec above on purpose: that one asserts the flag
			// exists, this one asserts WHICH of the three reasons it is.
			const localPeer = await makePeerId();
			const peerA = await makePeerId();
			const peerB = await makePeerId();
			const cluster = makeClusterPeers([localPeer, peerA, peerB]);

			const callback: ClusterLatestCallback = async (peerId) => {
				if (peerId.equals(peerA)) throw new Error('dial failed');
				return undefined; // self and peerB answer "I hold nothing"
			};

			const { repo: storageRepo } = makeAbsentStorageRepo();
			const repo = buildRepo(makeKeyNetwork(cluster), storageRepo, localPeer, callback);

			const result = await repo.get({ blockIds: [blockId] });

			expect(result[blockId]?.unavailable).to.equal('peers-unreachable');
		});
	});
});
