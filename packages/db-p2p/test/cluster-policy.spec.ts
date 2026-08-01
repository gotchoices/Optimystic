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
});
