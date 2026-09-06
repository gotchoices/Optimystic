/**
 * Ticket: solo-node-read-repair-never-settles (GitHub issue #8)
 *
 * On a node that is the entire cohort for a block, `fetchBlockFromCluster` takes the
 * solo-self short-circuit: it skips the cluster-latest callback (correctly — there is no
 * remote to sync from, and dialling self can hang a listener-less node). Before the fix it
 * returned WITHOUT stamping `lastSeenCommitMs`, so the lazy read-repair window was never
 * armed: `shouldReadRepair` saw `lastSeen == null` on every read and re-triggered the
 * consult forever. The reporter's device logged 3,880 `cluster-tx:read-repair-triggered`
 * against 3,879 `cluster-tx:read-repair-noop` and a 47-minute cold schema apply.
 *
 * These specs pin the fix and its bounded cost.
 *
 * TRAP for anyone editing this file: do NOT advance the clock past `readRepairWindowMs`
 * between reads. A lapsed window is SUPPOSED to re-trigger — that is what lazy read-repair
 * is for — so a probe that steps a full window between reads shows N triggers both before
 * and after the fix and makes the fix look inert. The defect is only visible on reads taken
 * INSIDE the window.
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
import { captureLog } from './support/capture-log.js';

const captureCoordinatorLog = (fn: () => Promise<void>): Promise<unknown[][]> =>
	captureLog('coordinator-repo', fn);

/** How many captured lines carry `tag`. The bug is a RATIO, so counting is the whole point. */
const countTag = (captured: unknown[][], tag: string): number =>
	captured.filter(args => typeof args[0] === 'string' && args[0].includes(tag)).length;

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

/**
 * Key network whose cohort view can change between reads — the growth spec below needs a
 * peer to join partway through. `findCluster` snapshots the live object on every call.
 */
const makeMutableKeyNetwork = (cluster: ClusterPeers): IKeyNetwork => ({
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return { ...cluster };
	}
});

/** Storage repo holding one block at a fixed rev. Nothing here ever commits, so nothing else arms the window. */
const makePresentStorageRepo = (blockId: BlockId, rev: number): IRepo => {
	const held: ActionRev = { actionId: 'local-action', rev };
	return {
		async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
			const result: GetBlockResults = {};
			for (const id of blockGets.blockIds) {
				result[id] = id === blockId ? { state: { latest: held } } : { state: {} };
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
};

/** Storage repo that holds nothing, so every read of `blockId` is a local miss. */
const makeEmptyStorageRepo = (): IRepo => ({
	async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		return Object.fromEntries(blockGets.blockIds.map(id => [id, { state: {} }]));
	},
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [] };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true };
	}
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const makeClusterClient = ((_peerId: PeerId) => ({} as any)) as (peerId: PeerId) => ClusterClient;

describe('CoordinatorRepo solo-cohort read-repair window', () => {
	const blockId: BlockId = 'block-solo-window';
	const WINDOW_MS = 10_000;
	const BASE_TIME = 1_000_000;

	/**
	 * A coordinator whose cohort starts as `[self]`. The returned `cluster` object is live —
	 * mutate it to change what `findCluster` reports on later reads.
	 */
	const makeSoloRepo = async (readRepairMode: 'lazy' | 'paranoid' = 'lazy') => {
		const localPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer]);
		const callbackInvocations: string[] = [];
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			callbackInvocations.push(peerId.toString());
			return undefined;
		};

		const repo = new CoordinatorRepo(
			makeMutableKeyNetwork(cluster),
			makeClusterClient,
			makePresentStorageRepo(blockId, 1),
			{ clusterSize: 3, readRepairMode, readRepairWindowMs: WINDOW_MS, readRepairSampleRate: 0 },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);
		// Deterministic clock. The block is never marked seen up front — this node has not
		// committed it, which is exactly the field case (control-network blocks this node reads
		// but never writes).
		let clock = BASE_TIME;
		repo.now = () => clock;
		const setClock = (t: number) => { clock = t; };

		return { repo, localPeer, cluster, callbackInvocations, setClock };
	};

	it('settles after one consult: N reads inside the window trigger read-repair exactly once', async () => {
		const { repo, setClock } = await makeSoloRepo();

		// Nine reads, one second apart — reads 2..9 all land INSIDE the 10s window.
		const captured = await captureCoordinatorLog(async () => {
			for (let i = 0; i < 9; i++) {
				setClock(BASE_TIME + i * 1_000);
				await repo.get({ blockIds: [blockId] });
			}
		});

		// At HEAD before the fix this was 9 / 9 / 9 — one triggered + noop + solo-skip per read,
		// forever; the same 1:1 ratio the reporter measured on device (3,880 / 3,879).
		expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
			'the solo exit must arm the window so later reads inside it do not re-consult').to.equal(1);
		expect(countTag(captured, 'cluster-tx:read-repair-noop')).to.equal(1);
		expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(1);
	});

	it('still serves the block on the suppressed reads', async () => {
		// Arming the window must suppress the CONSULT, not the answer.
		const { repo, setClock } = await makeSoloRepo();

		await repo.get({ blockIds: [blockId] });
		setClock(BASE_TIME + 1_000);
		const result = await repo.get({ blockIds: [blockId] });

		expect(result[blockId]?.state?.latest?.rev).to.equal(1);
	});

	it('re-triggers once the window lapses', async () => {
		// The fix bounds the consult rate at one per window; it must not turn read-repair off.
		const { repo, setClock } = await makeSoloRepo();

		const captured = await captureCoordinatorLog(async () => {
			await repo.get({ blockIds: [blockId] });          // triggers, arms at BASE_TIME
			setClock(BASE_TIME + 1_000);
			await repo.get({ blockIds: [blockId] });          // inside window — suppressed
			setClock(BASE_TIME + WINDOW_MS + 1);
			await repo.get({ blockIds: [blockId] });          // window lapsed — triggers again
		});

		expect(countTag(captured, 'cluster-tx:read-repair-triggered')).to.equal(2);
		expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(2);
	});

	it('paranoid mode still consults on every read', async () => {
		// `paranoid` means "verify every read" by definition; the window is not consulted at all
		// in that mode, and the fix must not quietly turn it into `lazy`.
		const { repo, setClock } = await makeSoloRepo('paranoid');

		const captured = await captureCoordinatorLog(async () => {
			for (let i = 0; i < 5; i++) {
				setClock(BASE_TIME + i * 1_000);
				await repo.get({ blockIds: [blockId] });
			}
		});

		expect(countTag(captured, 'cluster-tx:read-repair-triggered')).to.equal(5);
		expect(countTag(captured, 'cluster-fetch:solo-self-skip')).to.equal(5);
	});

	it('costs at most one window when the cohort later grows', async () => {
		// Intended behaviour, pinned so it is not rediscovered as a bug: a peer joining inside
		// the window is not consulted until the window lapses. Bounded by `readRepairWindowMs`
		// (10s default) and self-healing.
		const { repo, cluster, callbackInvocations, setClock } = await makeSoloRepo();
		const newPeer = await makePeerId();

		// Solo read arms the window.
		await repo.get({ blockIds: [blockId] });
		expect(callbackInvocations, 'solo read consults nobody').to.deep.equal([]);

		// A second peer becomes responsible for the block.
		Object.assign(cluster, makeClusterPeers([newPeer]));

		// Inside the window: still suppressed. This is the cost of the fix, stated out loud.
		setClock(BASE_TIME + 1_000);
		await repo.get({ blockIds: [blockId] });
		expect(callbackInvocations, 'suppressed for at most one window after cohort growth').to.deep.equal([]);

		// Past the window: the grown cohort is consulted.
		setClock(BASE_TIME + WINDOW_MS + 1);
		await repo.get({ blockIds: [blockId] });
		expect(callbackInvocations).to.include(newPeer.toString());
	});

	it('does not suppress reads of a block this node does not hold', async () => {
		// The solo exit stamps whatever block id reached it, INCLUDING one that is missing
		// locally. That stamp is inert because `get` short-circuits on `isMissing` before it ever
		// consults `shouldReadRepair` — a missing block is re-consulted on every read regardless
		// of the window. Pinned here because "inert" is the only thing keeping the stamp harmless:
		// if the missing-block bypass is ever narrowed, this case fails and says so, instead of a
		// never-held block quietly reporting an authoritative absence for a whole window.
		const localPeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer]);
		const repo = new CoordinatorRepo(
			makeMutableKeyNetwork(cluster),
			makeClusterClient,
			makeEmptyStorageRepo(),
			{ clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: WINDOW_MS, readRepairSampleRate: 0 },
			undefined,
			localPeer,
			undefined,
			async () => undefined
		);
		let clock = BASE_TIME;
		repo.now = () => clock;

		const captured = await captureCoordinatorLog(async () => {
			for (let i = 0; i < 9; i++) {
				clock = BASE_TIME + i * 1_000;	// all nine reads land inside the window
				await repo.get({ blockIds: [blockId] });
			}
		});

		expect(countTag(captured, 'cluster-fetch:solo-self-skip'),
			'a locally-missing block consults on every read, window or no window').to.equal(9);
		// Not a stale-content decision, so it is not read-repair: the triggered/no-op pair belongs
		// to the present-but-possibly-stale path only.
		expect(countTag(captured, 'cluster-tx:read-repair-triggered')).to.equal(0);
	});

	it('leaves the empty-cohort exit unarmed: every read re-triggers', async () => {
		// Deliberate asymmetry (see the NOTE at the `peerIds.length === 0` exit): an empty cohort
		// is a routing failure, not a settled answer, so arming would suppress a genuine repair
		// for a whole window after a transient routing blip. Re-entering costs only the
		// `findCluster` lookup the read already makes.
		const cluster: ClusterPeers = {};
		const localPeer = await makePeerId();
		const callbackInvocations: string[] = [];
		const repo = new CoordinatorRepo(
			makeMutableKeyNetwork(cluster),
			makeClusterClient,
			makePresentStorageRepo(blockId, 1),
			{ clusterSize: 3, readRepairMode: 'lazy', readRepairWindowMs: WINDOW_MS, readRepairSampleRate: 0 },
			undefined,
			localPeer,
			undefined,
			async (peerId) => { callbackInvocations.push(peerId.toString()); return undefined; }
		);
		let clock = BASE_TIME;
		repo.now = () => clock;

		const captured = await captureCoordinatorLog(async () => {
			for (let i = 0; i < 9; i++) {
				clock = BASE_TIME + i * 1_000;
				await repo.get({ blockIds: [blockId] });
			}
		});

		expect(countTag(captured, 'cluster-tx:read-repair-triggered'),
			'the empty-cohort exit deliberately does not arm the window').to.equal(9);
		expect(countTag(captured, 'cluster-fetch:solo-self-skip'), 'not the solo path').to.equal(0);
		expect(callbackInvocations, 'no cohort member to consult').to.deep.equal([]);
	});
});
