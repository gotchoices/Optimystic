/**
 * Mesh-tier coverage of CLIENT TRANSACTION SIGNATURE ENFORCEMENT — a receiving cluster member
 * refusing an unsigned or badly-signed transaction at PEND, driven through the real coordinator +
 * member stack instead of a `TransactionValidator` constructed by hand (that tier is
 * `client-tx-signature.spec.ts`, which shares this file's builders via `test/support/`).
 *
 * ## Why this file exists
 *
 * Signing ships whenever a node key exists and is exercised end to end. Enforcement was proven only
 * at the validator seam, because `createMesh` never populated `clusterMember({ … validator })` at
 * all — and `ClusterMember.validatePendOperations` returns success when no validator is configured,
 * so on the mesh the entire validation step was a no-op. `MeshOptions.validatorFactory` closes that
 * gap; these cases assert the wire-level guarantee "an unsigned client is refused by the cluster".
 *
 * ## How a member's refusal surfaces
 *
 * A member votes `reject` with a signed, free-form `rejectReason`. When rejections make the
 * super-majority unreachable, `ClusterCoordinator` throws `ValidatorRejectionError` reading
 * `Transaction rejected by validators (n/m rejected): <peerId>: <reason>; …`, carrying the per-peer
 * map on `.rejectReasons`. Assertions here match the SUBSTRING (`Missing client signature`), never a
 * whole message: the peer ids are random per run and two members can word the same verdict
 * differently.
 *
 * ## The arithmetic every case turns on
 *
 * `superMajorityThreshold` defaults to 0.75, so `superMajority = ceil(peerCount * 0.75)` and
 * `maxAllowedRejections = peerCount - superMajority`:
 *   - 3-node mesh → superMajority 3, maxAllowedRejections 0: ONE rejecting member kills the pend.
 *   - 4-node mesh → superMajority 3, maxAllowedRejections 1: one rejecting member is absorbed, two
 *     are fatal. That is what makes the per-node case below meaningful rather than arbitrary.
 *
 * ## Isolating the signature step
 *
 * Every transaction here carries NO statements, so re-execution yields no actions and the validator
 * computes `hashOperations([])` at step 8 whatever transforms the pend request carries. Sending
 * `operationsHash: await emptyOpsHash()` therefore makes every validator step except the signature
 * check pass trivially. Add statements to a case and it starts failing at step 9 (operations-hash
 * mismatch) instead — a different verdict that proves nothing about signatures.
 *
 * Two more deliberate choices, both about keeping other gates out of the way:
 *   - The pend request omits `rev`. That skips the member's stale-revision precheck entirely, and
 *     keeps `CoordinatorRepo.classifyStaleRejection` (which only runs when `rev` is present) from
 *     reinterpreting a signature rejection as an optimistic-concurrency loss.
 *   - Every mesh declares `clusterPolicy.assumedClusterSize` equal to its node count and is
 *     unpartitioned, so the MEMBERSHIP ADMISSION GATE admits. `evaluatePromise` runs
 *     `admitMembership` BEFORE `validatePendOperations`, so a mesh whose admission gate rejected
 *     would surface the membership reason and never reach the signature check at all.
 */

import { expect } from 'chai';
import type { BlockId, IBlock, BlockHeader, Transforms, Transaction } from '@optimystic/db-core';
import type { PrivateKey } from '@libp2p/interface';
import { createMesh, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';
import { ValidatorRejectionError } from '../src/repo/cluster-coordinator.js';
import {
	makeValidator,
	verifier,
	emptyOpsHash,
	buildSignedTx,
	buildUnsignedTx,
	generateClientIdentity,
} from './support/client-tx-signature.js';

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

/**
 * The multi-collection pend shape `TransactionCoordinator.pendCollection` builds: transforms plus
 * the transaction and its operations hash, which are the only two fields
 * `ClusterMember.validatePendOperations` hands to a configured validator.
 */
const pendTx = async (node: MeshNode, blockId: string, actionId: string, transaction: Transaction) =>
	node.coordinatorRepo.pend({
		actionId,
		transforms: makeTransforms(blockId),
		policy: 'c',
		transaction,
		operationsHash: await emptyOpsHash()
	});

const commitBlock = (node: MeshNode, blockId: string, actionId: string, rev = 1) =>
	node.coordinatorRepo.commit({ actionId, tailId: blockId as BlockId, rev, blockIds: [blockId as BlockId] });

/** Run `fn` and return whatever it threw, if anything. */
const captureFailure = async (fn: () => Promise<unknown>): Promise<Error | undefined> => {
	try {
		await fn();
		return undefined;
	} catch (err) {
		return err as Error;
	}
};

/** Assert no node in the mesh holds a committed revision for `blockId`. */
const expectNowhereCommitted = async (mesh: Mesh, blockId: string): Promise<void> => {
	for (const node of mesh.nodes) {
		const result = await node.storageRepo.get({ blockIds: [blockId as BlockId] });
		expect(result[blockId]?.state?.latest, `${node.peerId.toString().slice(0, 12)} must hold no committed revision`)
			.to.equal(undefined);
	}
};

/** Every reject reason the coordinator collected, across peers. */
const reasonsOf = (error: Error | undefined): string[] =>
	error instanceof ValidatorRejectionError ? Object.values(error.rejectReasons) : [];

// ─── mesh construction ───

/**
 * `nodeCount` nodes, every one responsible for every key, declaring its real cohort size so the
 * membership admission gate has an honest yardstick and admits. `enforcingIndices` names which nodes
 * get a signature-ENFORCING validator (omit it for "all of them"); the rest still get a validator,
 * but one with no verifier port — the phased-rollout posture, where signed and unsigned alike pass
 * the signature step. For the case where a node has NO validator at all, build the mesh without
 * `validatorFactory`.
 */
const createEnforcingMesh = async (nodeCount: number, enforcingIndices?: number[]): Promise<Mesh> => {
	const enforcing = enforcingIndices === undefined
		? undefined
		: new Set(enforcingIndices);
	return await createMesh(nodeCount, {
		responsibilityK: nodeCount,
		clusterSize: nodeCount,
		clusterPolicy: { assumedClusterSize: nodeCount },
		validatorFactory: (index) =>
			// `enforcing === undefined` ⇒ every node enforces. A named subset arms only those indices;
			// the others still receive a validator, but one with NO verifier port — the migration
			// posture, where signed and unsigned alike pass the signature step.
			makeValidator(enforcing === undefined || enforcing.has(index) ? verifier : undefined)
	});
};

describe('mesh — client transaction signature enforcement at PEND', () => {
	let clientKey: PrivateKey;
	let clientPeerId: string;
	let strangerKey: PrivateKey;

	beforeEach(async () => {
		// The client is a STRANGER: an Ed25519 identity unrelated to any mesh node's key. That is the
		// attack shape the enforcement exists for. (The plugin's real-world case — the client is also
		// a node, signing with its own node key — is covered by the mesh-node-signs case below.)
		({ key: clientKey, peerId: clientPeerId } = await generateClientIdentity());
		({ key: strangerKey } = await generateClientIdentity());
	});

	describe('an enforcing cohort refuses a transaction it cannot attribute', () => {
		it('refuses an unsigned client at PEND, naming the missing signature', async () => {
			// 3 nodes, all enforcing: maxAllowedRejections = 3 - ceil(3 * 0.75) = 0, so all three
			// rejecting (indeed, any one) makes the super-majority unreachable.
			const mesh = await createEnforcingMesh(3);
			const blockId = 'block-unsigned-refused';

			const error = await captureFailure(
				async () => pendTx(mesh.nodes[0]!, blockId, 'a-unsigned', await buildUnsignedTx(clientPeerId))
			);

			expect(error, 'the pend must fail').to.be.instanceOf(ValidatorRejectionError);
			// Assert the REASON, not merely that it failed — a bare "it threw" would pass for an
			// admission refusal, a stale revision, or an unreachable cohort.
			expect(error!.message).to.include('Missing client signature');
			expect(reasonsOf(error), 'every rejecting member named the same cause')
				.to.satisfy((rs: string[]) => rs.length > 0 && rs.every(r => r === 'Missing client signature'));
			await expectNowhereCommitted(mesh, blockId);
		});

		it('refuses a signature made by a key that does not match stamp.peerId', async () => {
			// Impersonation: stamped as the client, signed by a stranger. The public key derived from
			// `stamp.peerId` cannot verify it.
			const mesh = await createEnforcingMesh(3);
			const blockId = 'block-impersonated-refused';

			const error = await captureFailure(
				async () => pendTx(mesh.nodes[0]!, blockId, 'a-impersonated', await buildSignedTx(clientPeerId, strangerKey))
			);

			expect(error, 'the pend must fail').to.be.instanceOf(ValidatorRejectionError);
			expect(error!.message).to.include('Invalid client signature');
			await expectNowhereCommitted(mesh, blockId);
		});

		it('refuses a malformed signature and a non-Ed25519 peer id without an exception escaping the member', async () => {
			// The verifier closure must be TOTAL: `b64urlToBytes` on garbage and `peerIdFromString` on a
			// synthetic id both throw, and either escaping `validatePendOperations` would surface as
			// something other than a signed reject vote — an error out of the cluster stream, not a
			// verdict the cohort can agree on.
			const mesh = await createEnforcingMesh(3);

			const garbageSig = await buildUnsignedTx(clientPeerId);
			garbageSig.signature = '!!!not base64url!!!';
			const garbageError = await captureFailure(
				async () => pendTx(mesh.nodes[0]!, 'block-garbage-sig', 'a-garbage', garbageSig)
			);
			expect(garbageError, 'a malformed signature is a verdict, not a crash')
				.to.be.instanceOf(ValidatorRejectionError);
			expect(reasonsOf(garbageError)).to.include('Invalid client signature');

			// A well-formed signature over a stamp whose peerId is not a libp2p identity at all.
			const fakeIdTx = await buildSignedTx('not-a-real-peer-id', clientKey);
			const fakeIdError = await captureFailure(
				async () => pendTx(mesh.nodes[0]!, 'block-fake-peer-id', 'a-fake-id', fakeIdTx)
			);
			expect(fakeIdError, 'an undecodable peer id is a verdict, not a crash')
				.to.be.instanceOf(ValidatorRejectionError);
			expect(reasonsOf(fakeIdError)).to.include('Invalid client signature');
		});
	});

	describe('a correctly signed client is admitted — the control', () => {
		it('pends and commits across an all-enforcing cohort', async () => {
			// Without this case a validator that rejected EVERYTHING would read as a passing suite.
			const mesh = await createEnforcingMesh(3);
			const blockId = 'block-signed-commits';

			const result = await pendTx(mesh.nodes[0]!, blockId, 'a-signed', await buildSignedTx(clientPeerId, clientKey));
			// Not merely "did not throw": pend also reports a lost race or a stale revision as a
			// returned `success: false`.
			expect(result.success, 'the signed pend must report success').to.equal(true);

			expect((await commitBlock(mesh.nodes[0]!, blockId, 'a-signed')).success).to.equal(true);
			const read = await mesh.nodes[0]!.coordinatorRepo.get({ blockIds: [blockId as BlockId] });
			expect(read[blockId]?.block?.header?.id).to.equal(blockId);
		});

		it('accepts a client that IS a mesh node, signing with its own node key', async () => {
			// The Quereus plugin's real-world shape: the writing node signs with the same Ed25519 key
			// its peer id is derived from, and its cohort peers verify it. Distinct from the stranger
			// case above only in whose key it is — which is exactly the point: enforcement is about the
			// key matching `stamp.peerId`, not about membership.
			const mesh = await createEnforcingMesh(3);
			const writer = mesh.nodes[0]!;
			const blockId = 'block-node-signed';

			const tx = await buildSignedTx(writer.peerId.toString(), writer.privateKey);
			expect((await pendTx(writer, blockId, 'a-node-signed', tx)).success).to.equal(true);
			expect((await commitBlock(writer, blockId, 'a-node-signed')).success).to.equal(true);
		});
	});

	describe('enforcement is a per-node decision', () => {
		it('one enforcing member out of four is absorbed by the super-majority', async () => {
			// 4 nodes, ONE enforcing: superMajority = ceil(4 * 0.75) = 3, so
			// maxAllowedRejections = 4 - 3 = 1. A single reject does not make the super-majority
			// unreachable and the remaining three approvals clear the bar — the unsigned write PENDS.
			//
			// This is the honest, uncomfortable statement of the rollout posture: partial enforcement
			// does not enforce. Until enough of the cohort verifies, an unsigned client still writes.
			const mesh = await createEnforcingMesh(4, [0]);
			const blockId = 'block-one-enforcer';

			// Driven by node 1 (a non-enforcing member) so the rejecting node is a remote peer rather
			// than the coordinator's own local member.
			const result = await pendTx(mesh.nodes[1]!, blockId, 'a-one-enforcer', await buildUnsignedTx(clientPeerId));
			expect(result.success, 'one rejection out of four is within maxAllowedRejections').to.equal(true);
			// Commit is deliberately NOT asserted here: the enforcing member never pended locally, so
			// the commit path exercises cohort-drift reconciliation, which is a different subject.
		});

		it('two enforcing members out of four make the super-majority unreachable', async () => {
			// Same mesh shape, one more enforcer: 2 rejections > maxAllowedRejections 1 → refused.
			const mesh = await createEnforcingMesh(4, [0, 1]);
			const blockId = 'block-two-enforcers';

			const error = await captureFailure(
				async () => pendTx(mesh.nodes[2]!, blockId, 'a-two-enforcers', await buildUnsignedTx(clientPeerId))
			);

			expect(error, 'two rejections must kill the pend').to.be.instanceOf(ValidatorRejectionError);
			expect(error!.message).to.include('Missing client signature');
			expect(Object.keys((error as ValidatorRejectionError).rejectReasons),
				'exactly the two enforcing members rejected').to.have.lengthOf(2);
			await expectNowhereCommitted(mesh, blockId);
		});
	});

	describe('no validator ⇒ no signature step at all', () => {
		it('the same unsigned transaction commits on a mesh built without validatorFactory', async () => {
			// The negative control that makes every case above meaningful: it proves the refusals came
			// from the validator and not from something else in the pend path. It is also production's
			// current posture — no composition root supplies `NodeOptions.validator`, so every deployed
			// member runs `validatePendOperations` with no validator and re-validates nothing (backlog
			// `feat-no-deployment-validates-transactions-at-pend`).
			const mesh = await createMesh(3, {
				responsibilityK: 3,
				clusterSize: 3,
				clusterPolicy: { assumedClusterSize: 3 }
			});
			const blockId = 'block-no-validator';

			const result = await pendTx(mesh.nodes[0]!, blockId, 'a-no-validator', await buildUnsignedTx(clientPeerId));
			expect(result.success, 'with no validator the unsigned pend succeeds').to.equal(true);
			expect((await commitBlock(mesh.nodes[0]!, blockId, 'a-no-validator')).success).to.equal(true);
		});
	});
});
