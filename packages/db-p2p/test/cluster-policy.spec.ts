/**
 * Ticket: corroboration-floor-defaults-to-two-for-large-meshes.
 *
 * `resolveClusterPolicy` is the extracted composition-root resolution — the numbers
 * `createLibp2pNodeBase` hands to the cluster member, the coordinator, and both block-restoration
 * paths. It used to be an inline literal, so nothing could assert on it without booting a libp2p
 * node, and a default that relaxed the repair corroboration floor to a single voter went unnoticed.
 *
 * These specs pin the one thing the literal could not: that the SINGLE operator field
 * (`clusterPolicy.assumedClusterSize`) resolves to two different defaults, permissive for the
 * membership admission gate and strict for the repair floor, and to one shared value the moment an
 * operator declares it.
 */

import { expect } from 'chai';
import { DEFAULT_SUPER_MAJORITY_THRESHOLD } from '@optimystic/db-core';
import { minAbsoluteClusterSize, resolveClusterPolicy } from '../src/cluster/cluster-policy.js';
import { captureLog, hasTag } from './support/capture-log.js';

describe('resolveClusterPolicy', () => {
	describe('unconfigured node (the defaults a real deployment runs on)', () => {
		it('keeps the admission gate permissive and the repair floor strict', () => {
			const policy = resolveClusterPolicy({});

			// Admission gate: an unconfigured two- or three-node mesh must still be able to transact.
			expect(policy.assumedClusterSize, 'admission-gate yardstick stays at the small-mesh default').to.equal(2);
			expect(policy.assumedClusterSize).to.equal(minAbsoluteClusterSize);

			// Repair floor: measured against the replication factor, so a peer view shrunk to one peer
			// cannot talk the corroboration requirement down to a single voter.
			expect(policy.repairCorroborationClusterSize, 'repair yardstick defaults to clusterSize').to.equal(10);
			expect(policy.clusterSize).to.equal(10);
		});

		it('resolves the rest of the consensus config to its documented defaults', () => {
			const policy = resolveClusterPolicy({});

			expect(policy.superMajorityThreshold).to.equal(DEFAULT_SUPER_MAJORITY_THRESHOLD);
			expect(policy.simpleMajorityThreshold).to.equal(0.51);
			expect(policy.minAbsoluteClusterSize).to.equal(minAbsoluteClusterSize);
			expect(policy.allowClusterDownsize).to.equal(true);
			expect(policy.clusterSizeTolerance).to.equal(0.5);
			// Fails closed: an undersized cluster with no confident network-size estimate is rejected.
			expect(policy.allowUnvalidatedSmallCluster).to.equal(false);
			expect(policy.partitionDetectionWindow).to.equal(60000);
		});
	});

	describe('one operator field, two yardsticks', () => {
		it('an explicit assumedClusterSize sets BOTH', () => {
			const policy = resolveClusterPolicy({ clusterSize: 10, clusterPolicy: { assumedClusterSize: 2 } });

			// A declaration means it for both consumers; only the absent case diverges.
			expect(policy.assumedClusterSize).to.equal(2);
			expect(policy.repairCorroborationClusterSize).to.equal(2);
			// ...and declaring a small cohort must NOT drop the replication factor.
			expect(policy.clusterSize, 'the replication factor is untouched').to.equal(10);
		});

		it('clusterSize alone moves only the repair yardstick', () => {
			const policy = resolveClusterPolicy({ clusterSize: 4 });

			expect(policy.repairCorroborationClusterSize, 'an honest clusterSize is the other escape hatch').to.equal(4);
			expect(policy.assumedClusterSize, 'the admission gate keeps its permissive default').to.equal(2);
		});

		it('an honest two-node clusterSize is enough to self-repair without any clusterPolicy', () => {
			const policy = resolveClusterPolicy({ clusterSize: 2 });

			expect(policy.repairCorroborationClusterSize).to.equal(2);
		});

		it('a large declared cohort raises the admission floor above the small-mesh default', () => {
			const policy = resolveClusterPolicy({ clusterSize: 20, clusterPolicy: { assumedClusterSize: 16 } });

			expect(policy.assumedClusterSize).to.equal(16);
			expect(policy.repairCorroborationClusterSize).to.equal(16);
		});
	});

	describe('pass-through of the remaining clusterPolicy knobs', () => {
		it('carries superMajorityThreshold, allowDownsize, sizeTolerance and the small-cluster opt-in', () => {
			const policy = resolveClusterPolicy({
				clusterPolicy: {
					superMajorityThreshold: 0.9,
					allowDownsize: false,
					sizeTolerance: 0.25,
					allowUnvalidatedSmallCluster: true
				}
			});

			expect(policy.superMajorityThreshold).to.equal(0.9);
			expect(policy.allowClusterDownsize).to.equal(false);
			expect(policy.clusterSizeTolerance).to.equal(0.25);
			expect(policy.allowUnvalidatedSmallCluster).to.equal(true);
		});

		it('is pure — same options in, same numbers out', () => {
			const options = { clusterSize: 7, clusterPolicy: { assumedClusterSize: 3 } };

			expect(resolveClusterPolicy(options)).to.deep.equal(resolveClusterPolicy(options));
		});
	});

	/**
	 * Ticket: repair-deadlock-is-never-named.
	 *
	 * The advisory used to fire only when `assumedClusterSize` was undeclared, and told the operator
	 * that three or more machines "can ignore this". Both were wrong in the same direction — three
	 * machines is the MINIMUM that can repair at all, not a size at which repair is safe, and
	 * declaring `assumedClusterSize: 3` does not conjure a third peer. These specs pin the widened
	 * trigger and the corrected claim. The requirement itself (two answering cohort peers besides the
	 * reader, whatever the declared size) is pinned in `quorum-restore.spec.ts`.
	 */
	describe('repair-fault-tolerance startup advisory', () => {
		const advisoryPayload = (captured: unknown[][]) => captured
			.find(args => typeof args[0] === 'string' && args[0].includes('repair-fault-tolerance'))
			?.[1] as {
				declaredCohortSize?: number,
				cohortUndeclared?: boolean,
				noRepairMargin?: boolean,
				requiredAnsweringPeers?: number,
				minimumSelfHealingDeployment?: number,
				repairCorroborationClusterSize?: number,
				message?: string
			} | undefined;

		it('fires exactly once per node construction', async () => {
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({});
			});

			expect(hasTag(captured, 'repair-fault-tolerance')).to.equal(true);
			expect(captured.filter(args => typeof args[0] === 'string' && args[0].includes('repair-fault-tolerance')))
				.to.have.lengthOf(1);
		});

		it('states the real requirement — two cohort peers besides the reader — and that three machines has no margin', async () => {
			// The old wording implied a three-machine deployment was in the clear. It is not: the
			// reader has exactly two peers and needs both, so one unreachable peer makes that reader's
			// copy unrepairable. An advisory that oversells the threshold is worse than none.
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 10 });
			});

			const payload = advisoryPayload(captured);
			expect(payload?.minimumSelfHealingDeployment).to.equal(3);
			expect(payload?.message).to.contain('2 cohort peers');
			expect(payload?.message).to.contain('BESIDES the reader');
			expect(payload?.message).to.contain('MINIMUM that can repair at all, not a safe');
			expect(payload?.message).to.contain('4 machines is the first size with any margin');
			// The undeclared remedy, and the reassurance that it is not a replication downgrade.
			expect(payload?.cohortUndeclared).to.equal(true);
			expect(payload?.message).to.contain('clusterPolicy.assumedClusterSize');
			expect(payload?.message).to.contain('clusterSize=10');
			expect(payload?.message).to.contain('fewer than 3 machines');
			expect(payload?.message).to.not.contain('fewer than 10 machines');
		});

		/**
		 * Ticket: name-the-single-holder-deadlock.
		 *
		 * Every number in the advisory counts MACHINES, and until this ticket that was all it said —
		 * which quietly overstated the guarantee. Repair also needs two of those machines to actually
		 * HOLD the block, and that is a property of the block, not of the deployment. An operator at
		 * four-plus machines read "the first size with any margin" and believed they were covered while
		 * a block written when the deployment was smaller sat stranded at one copy. The advisory has to
		 * scope its own claim.
		 */
		it('scopes its fault-tolerance claim to blocks more than one peer holds', async () => {
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 10 });
			});

			const message = advisoryPayload(captured)?.message;
			// The claim it is scoping is still there, verbatim...
			expect(message).to.contain('4 machines is the first size with any margin');
			// ...and is now explicitly about a block at least two peers already hold.
			expect(message).to.contain('machines are only half the requirement');
			expect(message).to.contain('only ONE cohort peer holds can never be repaired at ANY deployment size');
			// The concrete way an operator ends up outside the scope, and the remedy that is NOT machines.
			expect(message).to.contain('GROWING THE DEPLOYMENT DOES NOT COPY IT');
			expect(message).to.contain('reason=sole-holder');
			expect(message).to.contain('never more machines');
		});

		it('still fires for a large, genuinely-provisioned clusterSize — it is advisory, not a fault', async () => {
			// A deployment that really does run 16 machines is correctly configured and gets the
			// advisory too; the wording is conditional ("if you actually run fewer than N machines"),
			// not a claim that this deployment is wrong.
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 16 });
			});

			expect(hasTag(captured, 'repair-fault-tolerance')).to.equal(true);
			expect(advisoryPayload(captured)?.noRepairMargin).to.equal(false);
		});

		it('stays quiet for a large DECLARED cohort — nothing to warn about', async () => {
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 16, clusterPolicy: { assumedClusterSize: 16 } });
			});

			expect(hasTag(captured, 'repair-fault-tolerance')).to.equal(false);
		});

		it('fires for a DECLARED three-machine cohort — declaring the number does not add a peer', async () => {
			// The case the old trigger missed entirely. `assumedClusterSize: 3` has exactly the same
			// zero tolerance as an undeclared three.
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 10, clusterPolicy: { assumedClusterSize: 3 } });
			});

			const payload = advisoryPayload(captured);
			expect(hasTag(captured, 'repair-fault-tolerance')).to.equal(true);
			expect(payload?.cohortUndeclared, 'the operator DID declare a size').to.equal(false);
			expect(payload?.noRepairMargin).to.equal(true);
			expect(payload?.requiredAnsweringPeers).to.equal(2);
			expect(payload?.message).to.contain('NO fault tolerance');
			expect(payload?.message).to.contain('the reader has 2 cohort peer(s) and needs 2');
			// Nothing to fix by declaring — the size IS declared — so the undeclared remedy stays out.
			expect(payload?.message).to.not.contain('No clusterPolicy.assumedClusterSize declared');
		});

		it('fires for a two-machine cohort, declared or honest — it repairs, with one peer and no margin', async () => {
			for (const options of [
				{ clusterSize: minAbsoluteClusterSize },
				{ clusterSize: 10, clusterPolicy: { assumedClusterSize: minAbsoluteClusterSize } }
			]) {
				const captured = await captureLog('cluster-policy', async () => {
					resolveClusterPolicy(options);
				});

				const payload = advisoryPayload(captured);
				expect(hasTag(captured, 'repair-fault-tolerance'), JSON.stringify(options)).to.equal(true);
				expect(payload?.noRepairMargin).to.equal(true);
				// The one size whose floor relaxes to a single corroborator — which is still every peer
				// it has.
				expect(payload?.requiredAnsweringPeers).to.equal(1);
				expect(payload?.message).to.contain('the reader has 1 cohort peer(s) and needs 1');
			}
		});

		it('names both problems at once when an undeclared deployment is also too small', async () => {
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 3 });
			});

			const payload = advisoryPayload(captured);
			expect(payload?.cohortUndeclared).to.equal(true);
			expect(payload?.noRepairMargin).to.equal(true);
			expect(payload?.message).to.contain('No clusterPolicy.assumedClusterSize declared');
			expect(payload?.message).to.contain('NO fault tolerance');
			// Still one line, not two.
			expect(captured.filter(args => typeof args[0] === 'string' && args[0].includes('repair-fault-tolerance')))
				.to.have.lengthOf(1);
		});
	});
});
