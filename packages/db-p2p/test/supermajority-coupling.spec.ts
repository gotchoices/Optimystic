import { expect } from 'chai';
import { DEFAULT_SUPER_MAJORITY_THRESHOLD } from '@optimystic/db-core';
import { ClusterMember } from '../src/cluster/cluster-repo.js';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import { assertSuperMajorityCoupling } from '../src/cluster/supermajority-coupling.js';

// The super-majority threshold is read by two components that must agree: the cluster MEMBER (accepts a
// super-majority of promises as sufficient) and the COORDINATOR (declares a transaction committed once it
// has that super-majority). This suite locks in (a) the fail-fast coupling assertion, (b) that a shared
// config keeps both in lockstep, and (c) that the unified default removed the old 1.0-vs-0.75 drift.

// Minimal stand-ins: neither constructor touches the network — they only store these and read config.
const dummy = {} as any;

/** Construct a real ClusterMember with the given consensus config (or none, to exercise the default). */
function makeMember(superMajorityThreshold?: number): ClusterMember {
	const cfg = superMajorityThreshold === undefined
		? undefined
		: ({ superMajorityThreshold } as any);
	return new ClusterMember(dummy, dummy, dummy, dummy, undefined, undefined, undefined, undefined, undefined, cfg);
}

/** Construct a real CoordinatorRepo with the given consensus config (or none, to exercise the default). */
function makeCoordinator(superMajorityThreshold?: number): CoordinatorRepo {
	const cfg = superMajorityThreshold === undefined ? undefined : { superMajorityThreshold };
	return new CoordinatorRepo(dummy, dummy, dummy, cfg);
}

describe('super-majority threshold coupling', () => {

	describe('assertSuperMajorityCoupling (the fail-fast guard)', () => {
		it('throws when member and coordinator resolve different thresholds', () => {
			expect(() => assertSuperMajorityCoupling(
				{ effectiveSuperMajorityThreshold: 1.0 },
				{ effectiveSuperMajorityThreshold: 0.75 }
			)).to.throw(/mismatch/i);
		});

		it('error names BOTH conflicting values and their provenance', () => {
			let message = '';
			try {
				assertSuperMajorityCoupling(
					{ effectiveSuperMajorityThreshold: 1.0 },
					{ effectiveSuperMajorityThreshold: 0.75 }
				);
			} catch (err) {
				message = (err as Error).message;
			}
			expect(message).to.contain('1');
			expect(message).to.contain('0.75');
			// Provenance: the reader must know where each value comes from.
			expect(message).to.contain('consensusConfig.superMajorityThreshold');
			expect(message).to.contain('DEFAULT_SUPER_MAJORITY_THRESHOLD');
		});

		it('passes silently when the two thresholds are equal', () => {
			expect(() => assertSuperMajorityCoupling(
				{ effectiveSuperMajorityThreshold: 0.75 },
				{ effectiveSuperMajorityThreshold: 0.75 }
			)).to.not.throw();
		});
	});

	describe('real member + coordinator wiring', () => {
		it('both default to DEFAULT_SUPER_MAJORITY_THRESHOLD when no config is supplied (no more 1.0-vs-0.75 drift)', () => {
			const member = makeMember();
			const coordinator = makeCoordinator();
			try {
				// The core regression: member used to default to 1.0 (unanimity), coordinator to 0.75.
				expect(member.effectiveSuperMajorityThreshold).to.equal(DEFAULT_SUPER_MAJORITY_THRESHOLD);
				expect(coordinator.effectiveSuperMajorityThreshold).to.equal(DEFAULT_SUPER_MAJORITY_THRESHOLD);
				expect(() => assertSuperMajorityCoupling(member, coordinator)).to.not.throw();
			} finally {
				member.dispose();
			}
		});

		it('a shared explicit config keeps both in lockstep and couples cleanly', () => {
			const member = makeMember(0.6);
			const coordinator = makeCoordinator(0.6);
			try {
				expect(member.effectiveSuperMajorityThreshold).to.equal(0.6);
				expect(coordinator.effectiveSuperMajorityThreshold).to.equal(0.6);
				expect(() => assertSuperMajorityCoupling(member, coordinator)).to.not.throw();
			} finally {
				member.dispose();
			}
		});

		it('a member/coordinator threshold mismatch is rejected at startup', () => {
			// Simulates the danger: member expecting unanimity while the coordinator commits at 0.75.
			const member = makeMember(1.0);
			const coordinator = makeCoordinator(0.75);
			try {
				expect(() => assertSuperMajorityCoupling(member, coordinator)).to.throw(/mismatch/i);
			} finally {
				member.dispose();
			}
		});
	});
});
