/**
 * Ticket: silent-read-repair-consults-back-off (gotchoices/sereus#48).
 *
 * A consult for a held block that a silent cohort peer left unarmed is not re-sent on the very next
 * read: the block is held for one declared link round trip, doubling per consecutive silent consult
 * up to the reconcile pass bound, and released as soon as a silent peer answers anything
 * (`SilentConsultHolds`). These specs pin the three rules that make that true: a base of 0 keeps
 * today's re-ask-at-once behaviour, the hold doubles to its cap while carrying the same doubt marker a
 * read always carried, and an answer about another block releases it.
 */

import { expect } from 'chai';
import { localDurability } from '@optimystic/db-core';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	IRepo, IKeyNetwork, ClusterPeers, BlockGets, GetBlockResults,
	PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks,
	MessageOptions, BlockId, ActionRev, FindCoordinatorOptions
} from '@optimystic/db-core';
import { CoordinatorRepo, type ClusterLatestCallback, type CoordinatorRepoConfig } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { toString as u8ToString } from 'uint8arrays';
import { captureLog } from './support/capture-log.js';

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

const makeClusterPeers = (peerIds: PeerId[]): ClusterPeers => Object.fromEntries(peerIds.map(peerId => [
	peerId.toString(),
	{ multiaddrs: ['/ip4/127.0.0.1/tcp/8000'], publicKey: u8ToString(peerId.publicKey?.raw ?? new Uint8Array(), 'base64url') }
]));

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

const BLOCK_X: BlockId = 'block-silent-consult-x';
const BLOCK_Y: BlockId = 'block-silent-consult-y';
const HELD: ActionRev = { actionId: 'local-action', rev: 1 };
const BASE_TIME = 1_000_000;

/** Storage holding every block at {@link HELD}. Nothing commits, so nothing else arms the window. */
const storageRepo: IRepo = {
	async get(blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		return Object.fromEntries(blockGets.blockIds.map(id => [id, { state: { latest: HELD } }]));
	},
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: [], durability: localDurability() };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> { },
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true, durability: localDurability() };
	}
};

/** What a partner answers the latest-revision consult with; `'silent'` rejects, as a dead dial does. */
type Answer = 'silent' | ActionRev | undefined;

/**
 * A coordinator holding every block at rev 1, in a cohort of itself plus one partner per entry of
 * `answers` (each re-read on every consult, so a spec can change what a partner says). The window is
 * never armed — every consult either has a silent peer or declines — so whether a read consults is
 * decided by the hold alone.
 */
const makeRepo = async (answers: Answer[], cfg: CoordinatorRepoConfig) => {
	const localPeer = await makePeerId();
	const partners = await Promise.all(answers.map(() => makePeerId()));
	const asked = new Map<string, number>();
	const callback: ClusterLatestCallback = async (peerId) => {
		if (peerId.equals(localPeer)) return HELD;
		const index = partners.findIndex(p => p.equals(peerId));
		asked.set(peerId.toString(), (asked.get(peerId.toString()) ?? 0) + 1);
		const answer = answers[index];
		if (answer === 'silent') throw new Error('partner unreachable');
		return answer;
	};
	const repo = new CoordinatorRepo(
		makeKeyNetwork(makeClusterPeers([localPeer, ...partners])), makeClusterClient, storageRepo,
		{ readRepairMode: 'lazy', readRepairSampleRate: 0, ...cfg },
		undefined, localPeer, undefined, callback
	);
	repo.awaitWindowConsults = true;
	let clock = BASE_TIME;
	repo.now = () => clock;
	return {
		repo,
		partners,
		/** How many times `partner` has been consulted so far. */
		askedOf: (partner: PeerId) => asked.get(partner.toString()) ?? 0,
		setClock: (t: number) => { clock = t; }
	};
};

const heldMs = (captured: unknown[][]): number[] => captured
	.filter(args => typeof args[0] === 'string' && args[0].includes('cluster-fetch:consult-held'))
	.map(args => (args[1] as { holdMs: number }).holdMs);

describe('CoordinatorRepo silent-consult backoff', () => {

	it('a base of 0 re-asks on the next read, as before', async () => {
		const { repo, partners, askedOf, setClock } = await makeRepo(['silent'], {});

		const captured = await captureLog('coordinator-repo', async () => {
			await repo.get({ blockIds: [BLOCK_X] });
			setClock(BASE_TIME + 1);
			await repo.get({ blockIds: [BLOCK_X] });
		});

		expect(askedOf(partners[0]!), 'every read consults').to.equal(2);
		expect(heldMs(captured), 'no hold is placed').to.deep.equal([]);
	});

	it('holds for one base, doubling per silent consult up to the reconcile pass bound, and the held read keeps its doubt', async () => {
		// Partner A claims rev 5, which one voter cannot corroborate; B is silent. So each consult leaves
		// a claim memo AND is held by B's silence. The default per-peer budget (1000 ms) puts the cap,
		// `reconcilePassTimeoutMs`, at 5000 ms.
		const BASE = 1_000;
		const CAP = 5_000;
		const { repo, partners, askedOf, setClock } = await makeRepo(
			[{ actionId: 'a-ahead', rev: 5 }, 'silent'], { retryBackoffBaseMs: BASE });
		const silentPeer = partners[1]!;
		const expected = [BASE, 2 * BASE, 4 * BASE, CAP, CAP];

		let now = BASE_TIME;
		const captured = await captureLog('coordinator-repo', async () => {
			for (const [i, holdMs] of expected.entries()) {
				setClock(now);
				await repo.get({ blockIds: [BLOCK_X] });
				expect(askedOf(silentPeer), `consult ${i + 1} ran when its hold ended`).to.equal(i + 1);

				setClock(now + holdMs - 1);
				const held = await repo.get({ blockIds: [BLOCK_X] });
				expect(askedOf(silentPeer), `the read 1 ms before hold ${i + 1} ends consults nobody`).to.equal(i + 1);
				expect(held[BLOCK_X]?.unconfirmedAheadRev, 'a held read carries the same doubt it always did').to.equal(5);

				now += holdMs;
			}
		});

		expect(heldMs(captured)).to.deep.equal(expected);
	});

	it('a silent peer answering a consult of another block releases the hold and restarts its doubling', async () => {
		const BASE = 1_000;
		const answers: Answer[] = ['silent'];
		const { repo, partners, askedOf, setClock } = await makeRepo(answers, { retryBackoffBaseMs: BASE });
		const partner = partners[0]!;

		const captured = await captureLog('coordinator-repo', async () => {
			await repo.get({ blockIds: [BLOCK_X] });           // silent: X held for BASE
			setClock(BASE_TIME + BASE / 2);
			await repo.get({ blockIds: [BLOCK_X] });           // held
			expect(askedOf(partner)).to.equal(1);

			answers[0] = undefined;                            // the partner recovers
			await repo.get({ blockIds: [BLOCK_Y] });           // and answers a consult of Y
			expect(askedOf(partner)).to.equal(2);

			answers[0] = 'silent';
			await repo.get({ blockIds: [BLOCK_X] });           // still inside X's hold, yet consults
		});

		expect(askedOf(partner), 'the answer about Y released X').to.equal(3);
		expect(heldMs(captured), 'the released hold restarts at one base, not two').to.deep.equal([BASE, BASE]);
	});
});
