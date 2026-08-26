/**
 * Ticket: bug-reconcile-cannot-heal-two-node-cohort.
 *
 * `ClusterMember` routes a commit it cannot materialize to `reconcileDivergentCommit`, which
 * calls the injected `ReconcileBlockCallback` to pull the missing revision from a cohort peer
 * (fix `d6a22d2`). These specs drive the real callback — `createReconcileBlock`, the logic
 * `libp2p-node-base` wires to the sync protocol — with an in-memory `fetchArchive` stand-in, and
 * ask the only question that matters at the size that keeps failing: with exactly one other peer
 * in the cohort, and that peer holding the block, does the node actually heal?
 *
 * Both restoration quorums (revision claim, then block content) are capped by the number of peers
 * that could answer at all, so a cohort with one other peer can converge; a cohort that merely
 * *looks* small — a full-size `repairCorroborationClusterSize` with a shrunken observed peer set —
 * still demands two.
 */

import { expect } from 'chai';
import type { ActionId, ActionRev, BlockHeader, BlockId, IBlock } from '@optimystic/db-core';
import type { BlockArchive } from '../src/storage/struct.js';
import { singleRevisionArchive } from '../src/storage/block-archive.js';
import { createReconcileBlock, type ReconcileBlockDeps } from '../src/cluster/reconcile-block.js';
import { resolveClusterPolicy } from '../src/cluster/cluster-policy.js';
import { PenaltyReason } from '../src/reputation/types.js';
import { captureLog } from './support/capture-log.js';

const BLOCK_ID = 'reconcile-target-block' as BlockId;
const COLLECTION_ID = 'reconcile-collection' as BlockId;
const SELF = 'node-b';
const PEER_A = 'node-a';
const THRESHOLD = 0.51;

const makeBlock = (payload: string): IBlock =>
	({ header: { id: BLOCK_ID, type: 'test', collectionId: COLLECTION_ID } as BlockHeader, payload } as unknown as IBlock);

const payloadOf = (block: IBlock | undefined): string | undefined =>
	(block as unknown as { payload?: string } | undefined)?.payload;

/** The archive a peer serves for its own latest revision — the SAME builder `SyncService` and the
 *  mesh harness serve real fetches with, so a stand-in here cannot drift from the real shape. */
const archiveAt = (rev: number, actionId: string, block: IBlock | undefined): BlockArchive =>
	singleRevisionArchive(BLOCK_ID, { rev, actionId: actionId as ActionId }, block);

interface Harness {
	reconcile: ReturnType<typeof createReconcileBlock>;
	saved: { blockId: BlockId; block: IBlock; source: ActionRev }[];
	fetches: string[];
	penalties: { peerId: string; reason: PenaltyReason }[];
}

const harness = (
	archives: Record<string, BlockArchive | undefined>,
	overrides: Partial<ReconcileBlockDeps> = {}
): Harness => {
	const saved: Harness['saved'] = [];
	const fetches: string[] = [];
	const penalties: Harness['penalties'] = [];
	const reconcile = createReconcileBlock({
		selfPeerId: SELF,
		simpleMajorityThreshold: THRESHOLD,
		repairCorroborationClusterSize: 2,
		async fetchArchive(peerId) {
			fetches.push(peerId);
			return archives[peerId];
		},
		async saveReplicatedBlock(blockId, block, source) {
			saved.push({ blockId, block, source });
		},
		reputation: { reportPeer: (peerId, reason) => { penalties.push({ peerId, reason }); } },
		...overrides
	});
	return { reconcile, saved, fetches, penalties };
};

const COMMITTED: ActionRev = { actionId: 'action-2' as ActionId, rev: 2 };

describe('createReconcileBlock (commit-path block restoration)', () => {
	it('heals a two-node cohort from its sole peer', async () => {
		// The exact shape the downstream two-node convergence scenario hits: node B refused a
		// commit it could not materialize and now asks the only other cohort member for it.
		const h = harness({ [PEER_A]: archiveAt(2, 'action-2', makeBlock('v2')) });

		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

		expect(h.fetches, 'the sole peer is asked').to.deep.equal([PEER_A]);
		expect(h.saved.length, 'the pulled revision must be persisted').to.equal(1);
		expect(payloadOf(h.saved[0]!.block)).to.equal('v2');
		expect(h.saved[0]!.source).to.deep.equal({ actionId: 'action-2', rev: 2 });
	});

	it('adopts a peer revision ahead of the one we committed', async () => {
		const h = harness({ [PEER_A]: archiveAt(5, 'action-5', makeBlock('v5')) });

		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

		expect(h.saved[0]!.source).to.deep.equal({ actionId: 'action-5', rev: 5 });
		expect(payloadOf(h.saved[0]!.block)).to.equal('v5');
	});

	it('still demands two corroborators when the cohort only LOOKS two-node', async () => {
		// Same single observed peer, but the operator declared a full-size cluster. A shrunken
		// view (partition, or routing influence) must not be able to talk the requirement down.
		const h = harness({ [PEER_A]: archiveAt(2, 'action-2', makeBlock('v2')) }, { repairCorroborationClusterSize: 10 });

		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

		expect(h.saved.length, 'one voter out of a possible nine is not corroboration').to.equal(0);
	});

	it('still demands two corroborators on an UNCONFIGURED node (the real composition-root default)', async () => {
		// Ticket: corroboration-floor-defaults-to-two-for-large-meshes. The case above pins the rule
		// against a hand-written yardstick; this one takes the number a real node actually resolves
		// (`resolveClusterPolicy` with no operator settings, i.e. clusterSize 10) and pins that the
		// unconfigured default is the STRICT one. Before the fix the node resolved 2 here and the lone
		// peer's claim was reconciled in.
		const resolved = resolveClusterPolicy({});
		const h = harness(
			{ [PEER_A]: archiveAt(2, 'action-2', makeBlock('v2')) },
			{
				simpleMajorityThreshold: resolved.simpleMajorityThreshold,
				repairCorroborationClusterSize: resolved.repairCorroborationClusterSize
			}
		);

		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

		expect(h.saved.length, 'an unconfigured node must not reconcile in a lone, uncorroborated claim').to.equal(0);
	});

	it('names the knob that caused the decline, not just the vote counts', async () => {
		// Ticket bug-cluster-size-resolution-single-source: an operator reading `reconcile:no-rev-quorum`
		// must be able to see WHICH setting made the quorum unreachable, and what it was set to.
		const resolved = resolveClusterPolicy({});
		const h = harness(
			{ [PEER_A]: archiveAt(2, 'action-2', makeBlock('v2')) },
			{
				simpleMajorityThreshold: resolved.simpleMajorityThreshold,
				repairCorroborationClusterSize: resolved.repairCorroborationClusterSize
			}
		);

		const captured = await captureLog('reconcile-block', async () => {
			await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);
		});

		const payload = captured.find(args => typeof args[0] === 'string' && args[0].includes('reconcile:no-rev-quorum'))?.[1] as
			{ cohortPeers?: number, holders?: number, behind?: number, noArchive?: number, fetchErrors?: number,
				required?: number, repairCorroborationClusterSize?: number } | undefined;

		expect(payload, 'expected reconcile:no-rev-quorum').to.not.equal(undefined);
		expect(payload?.repairCorroborationClusterSize).to.equal(resolved.repairCorroborationClusterSize);
		expect(payload?.holders).to.equal(1);
		expect(payload?.required).to.equal(2);
		// Ticket name-the-single-holder-deadlock: the decline separates the populations rather than
		// rolling them into one "responders" count — a shortfall of holders and a shortfall of answers
		// are different problems. `noArchive` conflates "holds nothing" with "unreachable", which is
		// `fetchArchive`'s contract, not something this site can infer around.
		expect(payload?.cohortPeers, 'one peer was consulted').to.equal(1);
		expect(payload?.behind).to.equal(0);
		expect(payload?.noArchive).to.equal(0);
		expect(payload?.fetchErrors).to.equal(0);
	});

	/**
	 * Review of name-the-single-holder-deadlock. The case above pins all four population counts at
	 * zero, which a constant would satisfy just as well. Splitting `responders` into populations is
	 * only worth anything if each one actually counts its own peers, so drive a cohort holding one of
	 * each and pin that they land in four different buckets and sum to the cohort.
	 */
	it('counts each shortfall population separately in the decline', async () => {
		const BEHIND = 'node-behind', EMPTY = 'node-empty', BROKEN = 'node-broken';
		const archives: Record<string, BlockArchive | undefined> = {
			[PEER_A]: archiveAt(2, 'action-2', makeBlock('v2')),   // holder, at the committed revision
			[BEHIND]: archiveAt(1, 'action-1', makeBlock('v1')),   // served an archive, but below the commit
			[EMPTY]: undefined                                      // served nothing
		};
		const h = harness(archives, {
			repairCorroborationClusterSize: 10,
			async fetchArchive(peerId) {
				if (peerId === BROKEN) throw new Error('stream reset');
				return archives[peerId];
			}
		});

		const captured = await captureLog('reconcile-block', async () => {
			await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A, BEHIND, EMPTY, BROKEN, SELF]);
		});

		const payload = captured.find(args => typeof args[0] === 'string' && args[0].includes('reconcile:no-rev-quorum'))?.[1] as
			{ cohortPeers?: number, holders?: number, behind?: number, noArchive?: number, fetchErrors?: number } | undefined;

		expect(payload, 'expected reconcile:no-rev-quorum').to.not.equal(undefined);
		expect(payload?.cohortPeers, 'self is not one of the peers consulted').to.equal(4);
		expect(payload?.holders).to.equal(1);
		expect(payload?.behind, 'an archive that stops below the commit is not a non-holder').to.equal(1);
		expect(payload?.noArchive).to.equal(1);
		expect(payload?.fetchErrors, 'a throwing fetch is not silently a non-holder').to.equal(1);
		const { holders = 0, behind = 0, noArchive = 0, fetchErrors = 0 } = payload ?? {};
		expect(holders + behind + noArchive + fetchErrors, 'the populations partition the cohort')
			.to.equal(payload?.cohortPeers);
	});

	it('heals unconfigured once the operator declares a genuine two-node deployment', async () => {
		// The counterpart trade: one explicit setting (which does NOT lower the replication factor)
		// buys back self-repair for a mesh that is really that small.
		const resolved = resolveClusterPolicy({ clusterPolicy: { assumedClusterSize: 2 } });
		const h = harness(
			{ [PEER_A]: archiveAt(2, 'action-2', makeBlock('v2')) },
			{ repairCorroborationClusterSize: resolved.repairCorroborationClusterSize }
		);

		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

		expect(h.saved.length, 'a declared two-node cohort still heals from its sole peer').to.equal(1);
		expect(payloadOf(h.saved[0]!.block)).to.equal('v2');
	});

	it('does not fetch or throw when the cohort has no other member', async () => {
		const h = harness({});

		await h.reconcile(BLOCK_ID, COMMITTED, []);
		await h.reconcile(BLOCK_ID, COMMITTED, [SELF]);

		expect(h.fetches, 'a single-node cohort must not dial anyone').to.deep.equal([]);
		expect(h.saved.length).to.equal(0);
	});

	it('declines cleanly and stays retryable when no peer holds the block', async () => {
		const h = harness({ [PEER_A]: undefined });

		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);
		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

		expect(h.saved.length, 'nothing to persist').to.equal(0);
		// Nothing is marked or cached on a decline, so a later attempt re-asks rather than
		// short-circuiting — and each attempt costs exactly one query per peer, not a spin.
		expect(h.fetches, 'each attempt re-queries exactly once').to.deep.equal([PEER_A, PEER_A]);
	});

	it('declines when the peer is behind the revision we committed', async () => {
		const h = harness({ [PEER_A]: archiveAt(1, 'action-1', makeBlock('v1')) });

		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

		expect(h.saved.length, 'restoring backwards would be a regression').to.equal(0);
	});

	it('declines when the sole peer corroborates the revision but carries no block bytes', async () => {
		// A pruned archive advertises the revision without the materialized block; there is
		// nothing to persist, so the heal must decline rather than save `undefined`.
		const h = harness({ [PEER_A]: archiveAt(2, 'action-2', undefined) });

		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

		expect(h.saved.length).to.equal(0);
	});

	it('rejects a content liar and persists the majority content in a larger cohort', async () => {
		const h = harness(
			{
				p1: archiveAt(2, 'action-2', makeBlock('v2')),
				p2: archiveAt(2, 'action-2', makeBlock('v2')),
				evil: archiveAt(2, 'action-2', makeBlock('tampered'))
			},
			{ repairCorroborationClusterSize: 4 }
		);

		await h.reconcile(BLOCK_ID, COMMITTED, ['p1', 'p2', 'evil']);

		expect(h.saved.length).to.equal(1);
		expect(payloadOf(h.saved[0]!.block), 'the honest content wins').to.equal('v2');
		expect(h.penalties).to.deep.equal([{ peerId: 'evil', reason: PenaltyReason.InvalidRestoration }]);
	});

	it('declines on an even content split rather than picking a side', async () => {
		const h = harness(
			{
				a1: archiveAt(2, 'action-2', makeBlock('A')),
				a2: archiveAt(2, 'action-2', makeBlock('A')),
				b1: archiveAt(2, 'action-2', makeBlock('B')),
				b2: archiveAt(2, 'action-2', makeBlock('B'))
			},
			{ repairCorroborationClusterSize: 5 }
		);

		await h.reconcile(BLOCK_ID, COMMITTED, ['a1', 'a2', 'b1', 'b2']);

		expect(h.saved.length, 'a genuine content disagreement must not be resolved by luck').to.equal(0);
	});

	it('outvotes a peer inflating its revision', async () => {
		const h = harness(
			{
				p1: archiveAt(2, 'action-2', makeBlock('v2')),
				p2: archiveAt(2, 'action-2', makeBlock('v2')),
				liar: archiveAt(99, 'bogus', makeBlock('bogus'))
			},
			{ repairCorroborationClusterSize: 4 }
		);

		await h.reconcile(BLOCK_ID, COMMITTED, ['p1', 'p2', 'liar']);

		expect(h.saved[0]!.source.rev, 'the corroborated revision wins over the highest one').to.equal(2);
	});

	it('lets one peer whose fetch rejects cost only that peer its vote', async () => {
		// `fetchArchive` is contracted to answer `undefined` for an unreachable peer, but a rejection
		// must not discard the answers the rest of the cohort already gave.
		const archives: Record<string, BlockArchive | undefined> = {
			p1: archiveAt(2, 'action-2', makeBlock('v2')),
			p2: archiveAt(2, 'action-2', makeBlock('v2'))
		};
		const saved: { source: ActionRev }[] = [];
		const reconcile = createReconcileBlock({
			selfPeerId: SELF,
			simpleMajorityThreshold: THRESHOLD,
			repairCorroborationClusterSize: 4,
			async fetchArchive(peerId) {
				if (peerId === 'broken') throw new Error('stream reset');
				return archives[peerId];
			},
			async saveReplicatedBlock(_blockId, _block, source) { saved.push({ source }); }
		});

		await reconcile(BLOCK_ID, COMMITTED, ['broken', 'p1', 'p2']);

		expect(saved.length, 'the two reachable corroborators still complete the heal').to.equal(1);
	});

	it('ignores a non-numeric revision key rather than dropping the peer', async () => {
		// Archive keys arrive as strings off the wire; `Number('latest')` is NaN, which would
		// poison the max and silently discard everything else the peer served.
		const poisoned = archiveAt(2, 'action-2', makeBlock('v2'));
		(poisoned.revisions as unknown as Record<string, unknown>)['latest'] = { action: undefined };
		const h = harness({ [PEER_A]: poisoned });

		await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

		expect(h.saved.length, 'the usable revision is still adopted').to.equal(1);
		expect(h.saved[0]!.source.rev).to.equal(2);
	});

	it('survives a reputation sink that throws', async () => {
		const h = harness(
			{
				p1: archiveAt(2, 'action-2', makeBlock('v2')),
				p2: archiveAt(2, 'action-2', makeBlock('v2')),
				evil: archiveAt(2, 'action-2', makeBlock('tampered'))
			},
			{
				repairCorroborationClusterSize: 4,
				reputation: { reportPeer: () => { throw new Error('reputation store down'); } }
			}
		);

		await h.reconcile(BLOCK_ID, COMMITTED, ['p1', 'p2', 'evil']);

		expect(h.saved.length, 'a reputation failure must never block restoration').to.equal(1);
	});
});
