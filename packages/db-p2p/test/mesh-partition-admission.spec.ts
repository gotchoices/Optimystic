/**
 * Mesh-tier coverage of the MEMBERSHIP ADMISSION GATE (`ClusterMember.admitMembership`) under a
 * simulated network partition, driven through the real coordinator + member stack rather than by
 * hand-feeding a member one crafted record at a time (that layer is
 * `cluster-membership-admission.spec.ts`).
 *
 * ## What "partition" means here
 *
 * `MeshFailureConfig.partitionSides` shapes cluster VIEWS, not transport: a node inside a listed
 * side sees only its own side's members when it asks the key network who is in a block's cohort.
 * That is exactly the input the gate exists to refuse — an unauthenticated, shrunken cohort — and
 * it is enough to reproduce split-brain, because a partitioned coordinator only ever contacts the
 * cohort it declared, which is already its own side.
 *
 * ## The arithmetic every case below turns on
 *
 * The mesh declares its real cohort size (`clusterPolicy.assumedClusterSize: 5`), so:
 *   - confident floor  = max(minAbsoluteClusterSize 2, ceil(membershipAdmissionFraction 0.75 * kEst))
 *   - fallback floor   = max(2, ceil(0.75 * assumedClusterSize 5)) = 4   [used when the member has
 *     no confident derived view — low FRET confidence, a derivation error, or no coordinating block]
 *   - super-majority   = ceil(declaredPeerCount * 0.75), measured against the DECLARED (possibly
 *     shrunk) set — which is precisely why the admission gate, not the threshold, is the split-brain
 *     defence.
 *
 * Theorem 2 (`docs/correctness.md`) needs `2 * 0.75 * 0.75 = 1.125 > 1`: two sides of a split cannot
 * both recruit `fraction * threshold * K` distinct honest members out of one K-peer cluster.
 *
 * ## Known gap this file pins rather than papers over
 *
 * Only `CoordinatorRepo.pend` puts `coordinatingBlockIds` on the `RepoMessage`; `commit` and
 * `cancel` do not, and `ClusterCoordinator.makeRecord` copies the field straight off the message.
 * A member therefore has NO block id to derive its own view from on the commit path, so the gate's
 * confident predicates never run there and every commit falls to the fallback floor. See
 * `commit path: the gate has no block to derive from` below, and ticket
 * `commit-and-cancel-records-omit-the-coordinating-block`.
 */

import { expect } from 'chai';
import type { BlockId, IBlock, BlockHeader, Transforms, ClusterPeers, ClusterRecord, RepoMessage } from '@optimystic/db-core';
import { computeClusterMessageHash, membershipDigest } from '@optimystic/db-core';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import { createMesh, type Mesh, type MeshNode, type MeshOptions } from '../src/testing/mesh-harness.js';
import { MEMBERSHIP_NOT_ADMITTED } from '../src/cluster/cluster-repo.js';
import { captureLog } from './support/capture-log.js';

// ─── block/transform helpers ───

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string): IBlock => ({ header: makeHeader(id) });

const makeTransforms = (blockId: string): Transforms => ({
	inserts: { [blockId]: makeBlock(blockId) },
	updates: {},
	deletes: []
});

const pendBlock = (node: MeshNode, blockId: string, actionId: string) =>
	node.coordinatorRepo.pend({ actionId, transforms: makeTransforms(blockId), policy: 'c' });

const commitBlock = (node: MeshNode, blockId: string, actionId: string, rev = 1) =>
	node.coordinatorRepo.commit({ actionId, tailId: blockId as BlockId, rev, blockIds: [blockId as BlockId] });

/**
 * What a node's own storage holds for a block. Reads the node's `StorageRepo` directly rather than
 * its `CoordinatorRepo`, so no cluster consult can happen and no read-repair can manufacture the
 * very committed revision these cases assert is absent.
 */
const localState = async (node: MeshNode, blockId: string) => {
	const result = await node.storageRepo.get({ blockIds: [blockId as BlockId] });
	return result[blockId];
};

/** Assert no node in the mesh committed `blockId` — the split-brain half of every refusal case. */
const expectNowhereCommitted = async (mesh: Mesh, blockId: string): Promise<void> => {
	for (const node of mesh.nodes) {
		const state = await localState(node, blockId);
		expect(state?.state?.latest, `${node.peerId.toString().slice(0, 12)} must hold no committed revision`)
			.to.equal(undefined);
	}
};

// ─── log helpers ───

const payloadsOf = (captured: unknown[][], tag: string): Record<string, unknown>[] =>
	captured
		.filter(args => typeof args[0] === 'string' && (args[0] as string).includes(tag))
		.map(args => args[1] as Record<string, unknown>);

const admissionRejectReasons = (captured: unknown[][]): string[] =>
	payloadsOf(captured, 'cluster-member:admission-reject').map(p => String(p.reason));

/** Run `fn`, returning both the member-side log and whatever it threw (if anything). */
const runCapturingFailure = async (fn: () => Promise<unknown>): Promise<{ captured: unknown[][]; error?: Error }> => {
	let error: Error | undefined;
	const captured = await captureLog('cluster-member', async () => {
		try {
			await fn();
		} catch (err) {
			error = err as Error;
		}
	});
	return { captured, error };
};

// ─── mesh construction ───

/** Below `ClusterMember.MembershipConfidenceThreshold` (0.5); the check is strictly greater. */
const LOW_CONFIDENCE = 0.2;

interface PartitionMesh {
	mesh: Mesh;
	/** Nodes 0–2: the side that keeps a super-majority of the true 5-peer cohort. */
	majority: MeshNode[];
	/** Nodes 3–4. */
	minority: MeshNode[];
	/**
	 * Peer ids whose FRET-confidence stand-in collapses to {@link LOW_CONFIDENCE}. Mutable and read
	 * per vote, so a case fills it AFTER the mesh is built.
	 */
	lowConfidence: Set<string>;
}

const idsOf = (nodes: MeshNode[]): Set<string> => new Set(nodes.map(n => n.peerId.toString()));

/**
 * Five nodes, every one responsible for every key (`responsibilityK: 5`), declaring its real cohort
 * size so the gate's fallback path has an honest yardstick. No partition until a case asks for one.
 */
const createFiveNodeMesh = async (extra: Partial<MeshOptions> = {}): Promise<PartitionMesh> => {
	const lowConfidence = new Set<string>();
	const mesh = await createMesh(5, {
		responsibilityK: 5,
		clusterSize: 5,
		clusterPolicy: { assumedClusterSize: 5 },
		meshConfidence: (node: MeshNode) => lowConfidence.has(node.peerId.toString()) ? LOW_CONFIDENCE : 1,
		...extra
	});
	return { mesh, majority: mesh.nodes.slice(0, 3), minority: mesh.nodes.slice(3), lowConfidence };
};

/** Split the mesh's cluster views 3 | 2. Transport is untouched — see the file header. */
const splitViews = ({ mesh, majority, minority }: PartitionMesh): void => {
	mesh.failures.partitionSides = [idsOf(majority), idsOf(minority)];
};

const collapseConfidence = (target: PartitionMesh, nodes: MeshNode[]): void => {
	for (const node of nodes) target.lowConfidence.add(node.peerId.toString());
};

// ─── crafted-record helpers (the self-membership case needs a record no coordinator would build) ───

const clusterPeersOf = (nodes: MeshNode[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const node of nodes) {
		peers[node.peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: uint8ArrayToString(node.peerId.publicKey!.raw, 'base64url')
		};
	}
	return peers;
};

/**
 * A fresh (no promises/commits) record over `peers`, hashed through the SAME production functions
 * `ClusterCoordinator` uses — so the member cannot reject it for a malformed hash or digest and the
 * only thing under test is the admission gate.
 */
const craftRecord = async (peers: ClusterPeers, blockId: string): Promise<ClusterRecord> => {
	const message: RepoMessage = {
		operations: [{ get: { blockIds: [blockId as BlockId] } }],
		coordinatingBlockIds: [blockId as BlockId],
		expiration: Date.now() + 30_000
	};
	const digest = await membershipDigest(peers);
	return {
		messageHash: await computeClusterMessageHash(message, digest),
		membershipVersion: 2,
		membershipDigest: digest,
		message,
		peers,
		coordinatingBlockIds: [blockId],
		promises: {},
		commits: {}
	};
};

describe('mesh partition — membership admission gate', () => {

	describe('a partitioned minority cannot write', () => {
		it('refuses admission on its own side and commits nowhere', async () => {
			// Minority coordinator declares D = its 2-node side. Each minority member is unconfident
			// (the partition collapsed its size estimate), so both measure D against the FALLBACK
			// floor 4 = ceil(0.75 * 5): 2 < 4 → reject. Super-majority over the shrunk declared set is
			// ceil(2 * 0.75) = 2, so maxAllowedRejections = 0 and one reject already kills it.
			const target = await createFiveNodeMesh();
			splitViews(target);
			collapseConfidence(target, target.minority);

			const blockId = 'block-minority-refused';
			const { captured, error } = await runCapturingFailure(
				() => pendBlock(target.minority[0]!, blockId, 'a-minority')
			);

			expect(error, 'the minority pend must fail').to.be.instanceOf(Error);
			// The coordinator embeds every peer's signed rejectReason in the thrown message, so the
			// outcome and the log agree. Assert the VARIANT PREFIX only: the tail carries local numbers.
			expect(error!.message).to.include(`${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize`);
			expect(admissionRejectReasons(captured), 'member logged the refusal')
				.to.include('low-confidence-downsize');
			await expectNowhereCommitted(target.mesh, blockId);
		});

		it('refuses when the derivation itself fails, not only when confidence is low', async () => {
			// A member that cannot derive at all (findCluster threw, FRET unavailable) is "not
			// confident" by the same branch: derived === undefined → fallback floor 4 > declared 2.
			// Fail-closed, not fail-open.
			const target = await createFiveNodeMesh({
				deriveExpectedCluster: async () => { throw new Error('derivation-unavailable'); }
			});
			splitViews(target);

			const blockId = 'block-derivation-throws';
			const { captured, error } = await runCapturingFailure(
				() => pendBlock(target.minority[0]!, blockId, 'a-derive-throws')
			);

			expect(error, 'the minority pend must fail').to.be.instanceOf(Error);
			expect(error!.message).to.include(`${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize`);
			expect(payloadsOf(captured, 'cluster-member:derive-expected-cluster-error').length,
				'the derivation error is reported, not swallowed silently').to.be.greaterThan(0);
			await expectNowhereCommitted(target.mesh, blockId);
		});
	});

	describe('a confident majority is allowed to proceed', () => {
		it('admits the majority side on the pend path', async () => {
			// Only the minority lost confidence. The majority coordinator declares D = its 3-peer
			// side; each majority member derives that same side confidently → kEst 3, floor
			// max(2, ceil(0.75 * 3)) = 3, |D| = 3 >= 3, symDiff 0 → approve. Super-majority is
			// ceil(3 * 0.75) = 3, and all three approve.
			//
			// This is the posture Theorem 2 actually promises: the majority MAY proceed; the
			// protection is that the minority cannot ALSO commit (previous describe block).
			const target = await createFiveNodeMesh();
			splitViews(target);
			collapseConfidence(target, target.minority);

			const blockId = 'block-majority-pend';
			let result: Awaited<ReturnType<typeof pendBlock>> | undefined;
			const { captured, error } = await runCapturingFailure(async () => {
				result = await pendBlock(target.majority[0]!, blockId, 'a-majority');
			});

			expect(error, 'the majority pend must succeed').to.equal(undefined);
			// Not merely "did not throw": `pend` also reports a lost race or a stale revision as a
			// returned `success: false`, which would leave nothing admitted and still pass a
			// no-throw assertion.
			expect(result?.success, 'the majority pend must report success').to.equal(true);
			expect(admissionRejectReasons(captured), 'no majority member refused admission').to.deep.equal([]);
		});

		it('commit path: the gate has no block to derive from, so it falls back (KNOWN GAP)', async () => {
			// `CoordinatorRepo.commit` builds its RepoMessage WITHOUT `coordinatingBlockIds`, and
			// `ClusterCoordinator.makeRecord` copies the field off the message — so the member's
			// `deriveExpectedClusterView` finds no block id, returns undefined, and the confident
			// predicates that admitted the pend a moment ago never run. The commit is judged against
			// the fallback floor 4 instead, which the 3-peer majority cannot meet.
			//
			// Pinned as-is deliberately: it is a real defect (a cohort can pass pend and be refused at
			// commit, stranding the write pended-but-uncommitted), filed as
			// `commit-and-cancel-records-omit-the-coordinating-block`. When that lands this case flips to
			// asserting a successful commit — the arithmetic above already says the confident majority
			// should be admitted.
			const target = await createFiveNodeMesh();
			splitViews(target);
			collapseConfidence(target, target.minority);

			const blockId = 'block-majority-commit';
			expect((await pendBlock(target.majority[0]!, blockId, 'a-majority-commit')).success).to.equal(true);

			const { captured, error } = await runCapturingFailure(
				() => commitBlock(target.majority[0]!, blockId, 'a-majority-commit')
			);

			expect(error, 'commit is refused by the fallback floor').to.be.instanceOf(Error);
			expect(error!.message).to.include(`${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize`);
			expect(admissionRejectReasons(captured)).to.include('low-confidence-downsize');
		});
	});

	describe('a partition that collapses confidence everywhere stops both sides', () => {
		it('neither the majority nor the minority can pend', async () => {
			// The floor is measured against the TRUE cohort size the operator declared (5), not
			// against whatever each side can still see. Majority declares 3 < 4; minority declares
			// 2 < 4. Both refuse. This is the Theorem 2 property stated directly: with
			// 2 * 0.75 * 0.75 = 1.125 > 1, two sides cannot both clear the bar out of one 5-peer
			// cohort — and when no side is confident, neither clears it.
			const target = await createFiveNodeMesh();
			splitViews(target);
			collapseConfidence(target, target.mesh.nodes);

			const majorityBlock = 'block-both-sides-majority';
			const minorityBlock = 'block-both-sides-minority';

			const majorityRun = await runCapturingFailure(
				() => pendBlock(target.majority[0]!, majorityBlock, 'a-both-maj')
			);
			expect(majorityRun.error, 'the majority pend must fail').to.be.instanceOf(Error);
			expect(majorityRun.error!.message).to.include(`${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize`);
			expect(admissionRejectReasons(majorityRun.captured)).to.include('low-confidence-downsize');

			const minorityRun = await runCapturingFailure(
				() => pendBlock(target.minority[0]!, minorityBlock, 'a-both-min')
			);
			expect(minorityRun.error, 'the minority pend must fail').to.be.instanceOf(Error);
			expect(minorityRun.error!.message).to.include(`${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize`);

			await expectNowhereCommitted(target.mesh, majorityBlock);
			await expectNowhereCommitted(target.mesh, minorityBlock);
		});
	});

	describe('self-membership is enforced even with the small-cluster hatch open', () => {
		it('rejects a record whose declared peers omit the receiving member', async () => {
			// `allowUnvalidatedSmallCluster` skips the size/consistency predicates — it does NOT skip
			// self-membership, or a coordinator could pad its approval count by routing records to
			// peers that are not in the cohort at all.
			const mesh = await createMesh(3, {
				responsibilityK: 3,
				clusterSize: 3,
				clusterPolicy: { assumedClusterSize: 3, allowUnvalidatedSmallCluster: true }
			});
			const outsider = mesh.nodes[0]!;
			const record = await craftRecord(clusterPeersOf(mesh.nodes.slice(1)), 'block-self-not-member');

			const answered = await outsider.clusterMember.update(record);
			const sig = answered.promises[outsider.peerId.toString()];

			expect(sig?.type).to.equal('reject');
			expect(sig?.type === 'reject' ? sig.rejectReason : undefined)
				.to.equal(`${MEMBERSHIP_NOT_ADMITTED}:self-not-member`);
		});
	});

	describe('unpartitioned control', () => {
		it('the same 5-node shape pends, commits and reads back', async () => {
			// Guards against a gate that refuses everything: with no partition and no collapsed
			// confidence, every member derives the full 5-peer cohort (kEst 5, floor 4, |D| = 5,
			// symDiff 0 → approve), and the commit path's fallback floor 4 <= 5 admits too.
			const target = await createFiveNodeMesh();
			const blockId = 'block-unpartitioned-control';

			const { captured, error } = await runCapturingFailure(async () => {
				expect((await pendBlock(target.mesh.nodes[0]!, blockId, 'a-control')).success).to.equal(true);
				expect((await commitBlock(target.mesh.nodes[0]!, blockId, 'a-control')).success).to.equal(true);
			});

			expect(error, 'the unpartitioned write must succeed').to.equal(undefined);
			expect(admissionRejectReasons(captured), 'nothing was refused admission').to.deep.equal([]);

			const read = await target.mesh.nodes[0]!.coordinatorRepo.get({ blockIds: [blockId as BlockId] });
			expect(read[blockId]?.block?.header?.id).to.equal(blockId);
		});
	});
});
