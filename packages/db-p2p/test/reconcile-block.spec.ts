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
import { canonicalBlockHash } from '@optimystic/db-core';
import type { ActionId, ActionRev, BlockHeader, BlockId, CommitRequest, IBlock } from '@optimystic/db-core';
import type { BlockArchive } from '../src/storage/struct.js';
import { singleRevisionArchive } from '../src/storage/block-archive.js';
import { createReconcileBlock, type ReconcileBlockDeps } from '../src/cluster/reconcile-block.js';
import { resolveClusterPolicy } from '../src/cluster/cluster-policy.js';
import { PenaltyReason } from '../src/reputation/types.js';
import type { BlockCommitProof } from '../src/cluster/commit-proof.js';
import { captureLog, hasTag } from './support/capture-log.js';
import { makeSignedProof } from './support/commit-proof-fixtures.js';

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
const archiveAt = (rev: number, actionId: string, block: IBlock | undefined, proof?: BlockCommitProof): BlockArchive =>
	singleRevisionArchive(BLOCK_ID, { rev, actionId: actionId as ActionId }, block, proof);

interface Harness {
	reconcile: ReturnType<typeof createReconcileBlock>;
	saved: { blockId: BlockId; block: IBlock; source: ActionRev; proof?: BlockCommitProof }[];
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
		// Mirrors PROOF_THRESHOLDS in support/commit-proof-fixtures.ts — the fixtures sign full
		// cohorts, so any threshold ≤ 1 passes; 0.75 is the production default.
		superMajorityThreshold: 0.75,
		repairCorroborationClusterSize: 2,
		async fetchArchive(peerId) {
			fetches.push(peerId);
			return archives[peerId];
		},
		async saveReplicatedBlock(blockId, block, source, proof) {
			saved.push({ blockId, block, source, proof });
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
			superMajorityThreshold: 0.75,
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

	/**
	 * Ticket: certified-claims-reconcile-and-persist. The commit-path reconcile runs each
	 * proof-carrying answer through the shared certification layer (`cluster/certified-claims.ts`)
	 * before selection, mirroring the read path: a verified cohort commit proof stands in for
	 * distinct-peer corroboration, and only a proof verified against the exact served bytes is
	 * handed onward to `saveReplicatedBlock` for persistence.
	 */
	describe('certified claims (cohort commit proofs)', () => {
		/** A commit for BLOCK_ID at `rev` declaring the digest of `block` (omit `block` for no digest). */
		const commitFor = async (rev: number, actionId: string, block?: IBlock): Promise<CommitRequest> => ({
			actionId: actionId as ActionId,
			blockIds: [BLOCK_ID],
			tailId: BLOCK_ID,
			rev,
			...(block ? { blockDigests: { [BLOCK_ID]: { digest: await canonicalBlockHash(block) } } } : {})
		});

		it('a single certified holder heals where corroboration declines, and the proof is persisted', async () => {
			// Same shape as 'still demands two corroborators when the cohort only LOOKS two-node',
			// except the lone holder now attaches a verified proof binding these exact bytes — the
			// cohort's signature set IS the corroboration, so the heal lands at capacity 9.
			const block = makeBlock('v2');
			const { proof } = await makeSignedProof(3, await commitFor(2, 'action-2', block));
			const h = harness(
				{ [PEER_A]: archiveAt(2, 'action-2', block, proof) },
				{ repairCorroborationClusterSize: 10 }
			);

			await h.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);

			expect(h.saved.length, 'the certified lone claim heals').to.equal(1);
			expect(payloadOf(h.saved[0]!.block)).to.equal('v2');
			expect(h.saved[0]!.source).to.deep.equal({ actionId: 'action-2', rev: 2 });
			expect(h.saved[0]!.proof, 'the verified proof is persisted alongside the bytes').to.equal(proof);
			expect(h.penalties).to.deep.equal([]);
		});

		it('rejects digest-contradicting content, penalizes the server, and still heals certified', async () => {
			// Both peers serve the SAME valid proof (digest = the honest bytes); one serves tampered
			// bytes under it. The liar's rev claim genuinely verified, but its bytes provably
			// contradict the declared digest: dropped from the content quorum, penalized once, and
			// the honest carrier's certified content wins without a second carrier.
			const honestBlock = makeBlock('v2');
			const { proof } = await makeSignedProof(3, await commitFor(2, 'action-2', honestBlock));
			const h = harness(
				{
					honest: archiveAt(2, 'action-2', honestBlock, proof),
					evil: archiveAt(2, 'action-2', makeBlock('tampered'), proof)
				},
				{ repairCorroborationClusterSize: 10 }
			);

			await h.reconcile(BLOCK_ID, COMMITTED, ['honest', 'evil']);

			expect(h.saved.length, 'repair continues on the honest holder').to.equal(1);
			expect(payloadOf(h.saved[0]!.block), 'the digest-bound content wins').to.equal('v2');
			expect(h.saved[0]!.proof).to.equal(proof);
			expect(h.penalties, 'the contradicting server is penalized exactly once')
				.to.deep.equal([{ peerId: 'evil', reason: PenaltyReason.InvalidRestoration }]);
		});

		it('treats an unparseable proof as an ordinary uncertified corroborator, without penalty', async () => {
			// `malformed-proof` is non-attributable: relayed junk, not provable misbehavior by the
			// server. The claims still corroborate each other, so the heal lands the plain way —
			// and no proof reaches persistence.
			const block = makeBlock('v2');
			const bogus = { v: 1, bogus: true } as unknown as BlockCommitProof;
			const h = harness(
				{
					p1: archiveAt(2, 'action-2', block, bogus),
					p2: archiveAt(2, 'action-2', block, bogus)
				},
				{ repairCorroborationClusterSize: 4 }
			);

			await h.reconcile(BLOCK_ID, COMMITTED, ['p1', 'p2']);

			expect(h.saved.length, 'plain corroboration still heals').to.equal(1);
			expect(h.penalties, 'a non-attributable proof failure penalizes nobody').to.deep.equal([]);
			expect(h.saved[0]!.proof, 'an unverified proof is never persisted').to.equal(undefined);
		});

		it('declines on certified rev equivocation and logs the distinct incident line', async () => {
			// Two verified proofs certify DIFFERENT actions into the same revision: the cohort (or
			// whoever holds its keys) provably signed both sides. Neither claimant is penalized —
			// which side is wrong is exactly what this node cannot know — and the decline logs
			// distinctly from a routine no-quorum. Both peers serve the same bytes and each commit
			// declares that digest, so no digest penalties muddy the assertion.
			const block = makeBlock('v2');
			const { proof: proofA } = await makeSignedProof(3, await commitFor(2, 'action-a', block));
			const { proof: proofB } = await makeSignedProof(3, await commitFor(2, 'action-b', block));
			const h = harness(
				{
					pa: archiveAt(2, 'action-a', block, proofA),
					pb: archiveAt(2, 'action-b', block, proofB)
				},
				{ repairCorroborationClusterSize: 4 }
			);

			const captured = await captureLog('reconcile-block', async () => {
				await h.reconcile(BLOCK_ID, COMMITTED, ['pa', 'pb']);
			});

			expect(h.saved.length, 'the whole selection declines rather than picking a side').to.equal(0);
			expect(h.penalties, 'equivocation convicts the cohort keys, not a serving peer').to.deep.equal([]);
			const payload = captured.find(args =>
				typeof args[0] === 'string' && args[0].includes('reconcile:certified-equivocation'))?.[1] as
				{ rev?: number; actionIds?: string[] } | undefined;
			expect(payload, 'expected reconcile:certified-equivocation').to.not.equal(undefined);
			expect(payload?.rev).to.equal(2);
			expect(payload?.actionIds).to.have.members(['action-a', 'action-b']);
		});

		it('declines on certified content equivocation and logs both hashes', async () => {
			// Same (rev, actionId) certified over two DIFFERENT digests, each peer serving the bytes
			// its own proof binds: the cohort's keys signed two digests into one revision. The rev
			// converges (both claims certified, same pair), the content declines, and the incident
			// line names both hashes so an operator can tell it from a carrier shortfall.
			const blockA = makeBlock('content-A');
			const blockB = makeBlock('content-B');
			const { proof: proofA } = await makeSignedProof(3, await commitFor(2, 'action-2', blockA));
			const { proof: proofB } = await makeSignedProof(3, await commitFor(2, 'action-2', blockB));
			const h = harness(
				{
					pa: archiveAt(2, 'action-2', blockA, proofA),
					pb: archiveAt(2, 'action-2', blockB, proofB)
				},
				{ repairCorroborationClusterSize: 4 }
			);

			const captured = await captureLog('reconcile-block', async () => {
				await h.reconcile(BLOCK_ID, COMMITTED, ['pa', 'pb']);
			});

			expect(h.saved.length, 'certified content equivocation must not resolve by luck').to.equal(0);
			const payload = captured.find(args =>
				typeof args[0] === 'string' && args[0].includes('reconcile:certified-content-equivocation'))?.[1] as
				{ rev?: number; hashes?: string[] } | undefined;
			expect(payload, 'expected reconcile:certified-content-equivocation').to.not.equal(undefined);
			expect(payload?.rev).to.equal(2);
			expect(payload?.hashes).to.have.members([
				await canonicalBlockHash(blockA), await canonicalBlockHash(blockB)
			]);
		});

		it('a corroboration-only heal persists no proof', async () => {
			// The pre-proof shape: two proof-less peers agreeing. The heal lands exactly as before
			// and the persistence parameter stays empty — nothing unverified may reach storage.
			const h = harness(
				{
					p1: archiveAt(2, 'action-2', makeBlock('v2')),
					p2: archiveAt(2, 'action-2', makeBlock('v2'))
				},
				{ repairCorroborationClusterSize: 4 }
			);

			await h.reconcile(BLOCK_ID, COMMITTED, ['p1', 'p2']);

			expect(h.saved.length).to.equal(1);
			expect(h.saved[0]!.proof, 'no certified carrier ⇒ no proof persisted').to.equal(undefined);
		});

		it('does not penalize dissenting bytes when the certified rule won the content gate', async () => {
			// Contradicting-content penalties run ONLY on a corroborated win. An unanchored proof
			// must not become a reputation lever against the honest cohort: anyone holding N keys
			// can mint a proof that verifies here, and letting it convict dissenters would be the
			// worse failure mode. Without that skip the proof-less dissenter below would be
			// penalized exactly as `evil` is in 'rejects a content liar and persists the majority
			// content in a larger cohort'. Flip this assertion only alongside
			// `feat-cluster-membership-threshold-cert-anchoring`, which is what would make a
			// certified win trustworthy enough to convict on.
			const certifiedBlock = makeBlock('v2');
			const { proof } = await makeSignedProof(3, await commitFor(2, 'action-2', certifiedBlock));
			const h = harness(
				{
					carrier: archiveAt(2, 'action-2', certifiedBlock, proof),
					dissenter: archiveAt(2, 'action-2', makeBlock('other-bytes'))
				},
				{ repairCorroborationClusterSize: 10 }
			);

			await h.reconcile(BLOCK_ID, COMMITTED, ['carrier', 'dissenter']);

			expect(h.saved.length, 'the certified carrier wins the content gate outright').to.equal(1);
			expect(payloadOf(h.saved[0]!.block), 'the digest-bound bytes win').to.equal('v2');
			expect(h.saved[0]!.proof).to.equal(proof);
			expect(h.penalties, 'a certified win must never convict a dissenting peer').to.deep.equal([]);
		});

		it('certifies only the revision when the proof declares no digest for this block', async () => {
			// The pre-digest-upgrade shape: a genuine, fully-signed proof whose commit op named no
			// digest for BLOCK_ID. `no-digest-declared` is a verdict, not misbehavior — the revision
			// certifies, the content does not, nobody is penalized, and the content gate falls back
			// to ordinary carrier corroboration.
			const block = makeBlock('v2');
			const { proof } = await makeSignedProof(3, await commitFor(2, 'action-2'));
			const lone = harness(
				{ [PEER_A]: archiveAt(2, 'action-2', block, proof) },
				{ repairCorroborationClusterSize: 10 }
			);
			const captured = await captureLog('reconcile-block', async () => {
				await lone.reconcile(BLOCK_ID, COMMITTED, [PEER_A]);
			});

			expect(lone.saved.length, 'an undeclared digest buys the content gate nothing').to.equal(0);
			expect(lone.penalties, 'no-digest-declared implicates nobody').to.deep.equal([]);
			expect(hasTag(captured, 'reconcile:certified-selected'), 'the revision still went certified').to.equal(true);
			expect(hasTag(captured, 'reconcile:no-content-quorum'), 'the content gate declined for want of carriers').to.equal(true);

			// Same proof, plus an ordinary second carrier: the content gate is satisfied the normal
			// way, and the proof — which bound no bytes — is still never persisted.
			const corroborated = harness(
				{
					p1: archiveAt(2, 'action-2', block, proof),
					p2: archiveAt(2, 'action-2', makeBlock('v2'))
				},
				{ repairCorroborationClusterSize: 4 }
			);

			await corroborated.reconcile(BLOCK_ID, COMMITTED, ['p1', 'p2']);

			expect(corroborated.saved.length, 'ordinary corroboration still heals').to.equal(1);
			expect(corroborated.saved[0]!.proof, 'a proof that certified no bytes is never persisted').to.equal(undefined);
			expect(corroborated.penalties).to.deep.equal([]);
		});

		it('certifies a revision from a peer carrying the proof but no block bytes', async () => {
			// A pruned archive advertises the revision and retains the proof without the materialized
			// block, so certification routes through `certifyClaim` rather than `certifyContent` — an
			// arm of `certifyCandidates` no other reconcile test reaches. The revision certifies off
			// that block-less answer (`reconcile:certified-selected` fires, which plain corroboration
			// alone would not produce); the bytes still come from ordinary carriers, and nothing is
			// persisted as proof because nothing bound that proof to these bytes.
			const { proof } = await makeSignedProof(3, await commitFor(2, 'action-2', makeBlock('v2')));
			const h = harness(
				{
					keeper: archiveAt(2, 'action-2', undefined, proof),
					c1: archiveAt(2, 'action-2', makeBlock('v2')),
					c2: archiveAt(2, 'action-2', makeBlock('v2'))
				},
				{ repairCorroborationClusterSize: 4 }
			);

			const captured = await captureLog('reconcile-block', async () => {
				await h.reconcile(BLOCK_ID, COMMITTED, ['keeper', 'c1', 'c2']);
			});

			expect(h.saved.length).to.equal(1);
			expect(payloadOf(h.saved[0]!.block)).to.equal('v2');
			expect(h.saved[0]!.proof, 'certifyClaim binds no bytes, so no proof is persisted').to.equal(undefined);
			expect(h.penalties).to.deep.equal([]);
			expect(
				hasTag(captured, 'reconcile:certified-selected'),
				'the block-less proof carried the revision selection'
			).to.equal(true);
		});

		it('penalizes a block-less peer presenting a genuine proof for a revision it does not cover', async () => {
			// The replay case on the same `certifyClaim` arm: the proof is real and fully signed, but
			// it commits rev 2 while the peer advertises rev 9. `claim-not-in-message` is attributable
			// — a genuine proof presented for a claim it does not cover implicates whoever served it —
			// and the inflated claim still never steers the heal.
			const { proof } = await makeSignedProof(3, await commitFor(2, 'action-2', makeBlock('v2')));
			const h = harness(
				{
					replayer: archiveAt(9, 'action-2', undefined, proof),
					c1: archiveAt(2, 'action-2', makeBlock('v2')),
					c2: archiveAt(2, 'action-2', makeBlock('v2'))
				},
				{ repairCorroborationClusterSize: 4 }
			);

			await h.reconcile(BLOCK_ID, COMMITTED, ['replayer', 'c1', 'c2']);

			expect(h.penalties, 'a replayed proof implicates the peer that served it')
				.to.deep.equal([{ peerId: 'replayer', reason: PenaltyReason.InvalidRestoration }]);
			expect(h.saved.length, 'the corroborated revision still heals').to.equal(1);
			expect(h.saved[0]!.source, 'the inflated claim never steers restoration')
				.to.deep.equal({ actionId: 'action-2', rev: 2 });
		});

		/**
		 * The signer count is measured in `certified-claims.ts` and weighed in `quorum-restore.ts`;
		 * every test either side of that pins one end. These two drive a real proof the whole way
		 * through `certifyCandidates` → `selectQuorumRev` so the WIRING is covered: an absent count
		 * weighs as single-signer, so a broken plumb throws nothing and logs nothing — multi-signer
		 * proofs would simply start losing ties they should win. The pair is deliberately symmetric:
		 * the first fails if the count stops arriving, the second if it arrives as a constant.
		 */
		it('a MULTI-SIGNER proof still beats an equal-rev corroborated pair end to end', async () => {
			const certBlock = makeBlock('cert');
			const { proof } = await makeSignedProof(3, await commitFor(2, 'action-cert', certBlock));
			const h = harness(
				{
					cert: archiveAt(2, 'action-cert', certBlock, proof),
					h1: archiveAt(2, 'action-cohort', makeBlock('cohort')),
					h2: archiveAt(2, 'action-cohort', makeBlock('cohort'))
				},
				{ repairCorroborationClusterSize: 4 }
			);

			await h.reconcile(BLOCK_ID, COMMITTED, ['cert', 'h1', 'h2']);

			expect(h.saved.length).to.equal(1);
			expect(h.saved[0]!.source, 'three signers outrank two voters at one revision')
				.to.deep.equal({ actionId: 'action-cert', rev: 2 });
			expect(h.saved[0]!.proof, 'the certified bytes carry their proof onward').to.equal(proof);
		});

		it('a SINGLE-SIGNER proof loses the same shape to the corroborated pair', async () => {
			// The motivating fork, end to end: a briefly-alone machine self-signed (2, 'action-solo')
			// while the cohort that stayed together committed (2, 'action-cohort').
			const soloBlock = makeBlock('solo-fork');
			const { proof } = await makeSignedProof(1, await commitFor(2, 'action-solo', soloBlock));
			const h = harness(
				{
					solo: archiveAt(2, 'action-solo', soloBlock, proof),
					h1: archiveAt(2, 'action-cohort', makeBlock('cohort')),
					h2: archiveAt(2, 'action-cohort', makeBlock('cohort'))
				},
				{ repairCorroborationClusterSize: 4 }
			);

			await h.reconcile(BLOCK_ID, COMMITTED, ['solo', 'h1', 'h2']);

			expect(h.saved.length).to.equal(1);
			expect(h.saved[0]!.source, 'a self-signed receipt does not outrank the cohort that stayed together')
				.to.deep.equal({ actionId: 'action-cohort', rev: 2 });
			expect(h.saved[0]!.proof, 'the losing proof is never persisted').to.equal(undefined);
			expect(h.penalties, 'the displaced solo holder is a partition casualty, not a liar')
				.to.deep.equal([]);
		});
	});
});
