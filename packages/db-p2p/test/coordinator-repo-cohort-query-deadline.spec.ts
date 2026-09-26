/**
 * Ticket: cohort-read-deadlines-are-fixed-at-lan-speeds (GitHub issue #22).
 *
 * The per-peer deadline on the cohort's latest-revision consult was a hardcoded 1000 ms — a
 * LAN-shaped budget. Two phones reaching each other only through a public circuit relay have a
 * round trip near 1.8s, so every honest answer arrived late, counted as silence, and in a
 * two-member cohort one late answer is the whole quorum: the consult declined on every read and a
 * rejoining node never caught up.
 *
 * `resolveClusterPolicy` pins what the setting RESOLVES to (`cluster-policy.spec.ts`). This pins the
 * one thing resolution cannot: that the per-peer deadline site actually reads the resolved number.
 * Two cases over one callback delay, asserting the two outcomes the reproduction established.
 *
 * Small declared durations, not the default: there is no fake-timer library in this package
 * (devDependencies are mocha + chai) and `withDeadline` uses real `setTimeout`, which the class's
 * `now` seam does not cover — that seam is only for the read-repair window. A 250 ms answer against
 * a 40 ms and a 1500 ms deadline is roughly half a second of real time for both cases, with a ~6x
 * margin either side of the delay so a loaded CI run does not flip the verdict. Exercising the
 * DEFAULT would mean waiting past 1000 ms, and the default is already pinned at the resolution tier.
 */

import { expect } from 'chai';
import { localDurability } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, FindCoordinatorOptions
} from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { toString as u8ToString } from 'uint8arrays';
import { captureLog, hasTag } from './support/capture-log.js';

/** How long the one remote peer takes to answer, in ms. Both cases use it. */
const ANSWER_DELAY_MS = 250;

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

/** A storage repo that holds nothing at all — the rejoining reader's shape. */
const makeEmptyStorageRepo = (): IRepo => ({
	async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		const result: GetBlockResults = {};
		for (const id of blockGets.blockIds) result[id] = { state: {} };
		return result;
	},
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [], durability: localDurability() };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true, durability: localDurability() };
	}
});

describe('CoordinatorRepo per-peer cohort deadline', () => {
	const blockId: BlockId = 'block-cohort-deadline';

	/**
	 * A two-member cohort whose one remote peer answers HONESTLY, with the revision, `ANSWER_DELAY_MS`
	 * late. `repairCorroborationClusterSize: 2` relaxes the corroboration floor to one voter, so that
	 * single honest answer is a quorum whenever the deadline lets it land.
	 */
	const makeReader = async (cohortQueryTimeoutMs: number) => {
		const localPeer = await makePeerId();
		const remotePeer = await makePeerId();
		const cluster = makeClusterPeers([localPeer, remotePeer]);
		const clusterLatestCallback: ClusterLatestCallback = async (peerId) => {
			if (peerId.equals(localPeer)) return undefined;	// this node holds nothing
			await new Promise(resolve => { setTimeout(resolve, ANSWER_DELAY_MS).unref(); });
			return { actionId: 'remote-action', rev: 7 };
		};
		return new CoordinatorRepo(
			makeKeyNetwork(cluster),
			makeClusterClient,
			makeEmptyStorageRepo(),
			{ clusterSize: 2, repairCorroborationClusterSize: 2, cohortQueryTimeoutMs },
			undefined,
			localPeer,
			undefined,
			clusterLatestCallback
		);
	};

	it('counts an honest answer that misses the deadline as silence, and declines the read', async () => {
		const repo = await makeReader(40);

		let results: GetBlockResults | undefined;
		const captured = await captureLog('coordinator-repo', async () => {
			results = await repo.get({ blockIds: [blockId] });
		});

		expect(hasTag(captured, 'cluster-fetch:peers-silent'), 'the late answer reads as silence').to.equal(true);
		expect(hasTag(captured, 'cluster-fetch:no-quorum'), 'so no claim reaches the quorum').to.equal(true);
		// Every cohort member this node knows of went unheard, so it cannot rule the block out.
		expect(results?.[blockId]?.unavailable).to.equal('cohort-unreachable');
	});

	it('counts the same answer when the deadline is longer than the delay', async () => {
		const repo = await makeReader(1500);

		let results: GetBlockResults | undefined;
		const captured = await captureLog('coordinator-repo', async () => {
			results = await repo.get({ blockIds: [blockId] });
		});

		expect(hasTag(captured, 'cluster-fetch:peers-silent'), 'nobody was silent').to.equal(false);
		expect(hasTag(captured, 'cluster-fetch:no-quorum'), 'the claim met the quorum').to.equal(false);
		// The claim was counted and selected; with no `acquireBlockFromCohort` wired the bytes have
		// nowhere to come from, so the read is flagged as claimed by a peer rather than absent —
		// which is exactly the half under test.
		expect(results?.[blockId]?.unavailable).to.equal('claimed-elsewhere');
	});
});
