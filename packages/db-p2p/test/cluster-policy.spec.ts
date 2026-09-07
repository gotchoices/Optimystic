/**
 * Ticket: corroboration-floor-defaults-to-two-for-large-meshes.
 *
 * `resolveClusterPolicy` is the extracted composition-root resolution — the numbers
 * `createLibp2pNodeBase` hands to the cluster member, the coordinator, and both block-restoration
 * paths. It used to be an inline literal, so nothing could assert on it without booting a libp2p
 * node, and a default that relaxed the repair corroboration floor to a single voter went unnoticed.
 *
 * These specs pin the one thing the literal could not: that `clusterPolicy.assumedClusterSize`
 * resolves to two different defaults, permissive for the membership admission gate and strict for the
 * repair floor, and to one shared value the moment an operator declares it — plus (ticket
 * `feat-declare-repair-yardstick-alone-apply-by-rebuild`) that
 * `clusterPolicy.repairCorroborationClusterSize` moves the repair floor ALONE, so a deployment can
 * tighten repair without also raising the low-confidence write floor.
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

	/**
	 * Ticket: feat-declare-repair-yardstick-alone-apply-by-rebuild.
	 *
	 * `assumedClusterSize` sets BOTH yardsticks, so a deployment that wanted the strict one (the
	 * repair corroboration floor) raised had to raise the permissive one (the membership admission
	 * gate's low-confidence write floor) with it — which can refuse writes it needs. The largest
	 * consumer therefore pinned `assumedClusterSize: 2` at every group size and got no repair
	 * tightening at all. `clusterPolicy.repairCorroborationClusterSize` moves the repair yardstick
	 * alone.
	 */
	describe('declaring the repair yardstick on its own', () => {
		it('moves ONLY the repair yardstick — the write floor and the replication factor stay put', () => {
			// The downstream shape: a host that knows it enrolled 8 machines wants repair measured
			// against 8, while the admission gate stays permissive so real writes are never refused.
			const policy = resolveClusterPolicy({ clusterPolicy: { repairCorroborationClusterSize: 8 } });

			expect(policy.repairCorroborationClusterSize).to.equal(8);
			expect(policy.assumedClusterSize, 'the admission/write floor is untouched').to.equal(minAbsoluteClusterSize);
			expect(policy.clusterSize, 'the replication factor is untouched').to.equal(10);
		});

		it('wins over assumedClusterSize for repair, while assumedClusterSize still sets admission', () => {
			const policy = resolveClusterPolicy({
				clusterSize: 10,
				clusterPolicy: { assumedClusterSize: 3, repairCorroborationClusterSize: 8 }
			});

			expect(policy.repairCorroborationClusterSize, 'the specific field wins').to.equal(8);
			expect(policy.assumedClusterSize, 'and does not bleed into the admission gate').to.equal(3);
			expect(policy.clusterSize).to.equal(10);
		});

		it('is accepted above clusterSize — harmless, since the floor is capped anyway', () => {
			const policy = resolveClusterPolicy({ clusterSize: 4, clusterPolicy: { repairCorroborationClusterSize: 32 } });

			expect(policy.repairCorroborationClusterSize).to.equal(32);
			expect(policy.clusterSize, 'never rewrites the replication factor').to.equal(4);
			expect(policy.assumedClusterSize).to.equal(minAbsoluteClusterSize);
		});

		it('is floored at minAbsoluteClusterSize when declared below it', () => {
			// 1 would mean "a cohort of one", which has no peer to corroborate with at all.
			const policy = resolveClusterPolicy({ clusterPolicy: { repairCorroborationClusterSize: 1 } });

			expect(policy.repairCorroborationClusterSize).to.equal(minAbsoluteClusterSize);
		});

		it('resolves to the same yardstick a hand-wired CoordinatorRepo would', () => {
			// `CoordinatorRepo` applies its own chain to the config object it is handed:
			// `cfg?.repairCorroborationClusterSize ?? policy.assumedClusterSize ?? policy.clusterSize`
			// (`repo/coordinator-repo.ts`). A real node and a direct `coordinatorRepo(...)` given the
			// SAME operator numbers must land on the same yardstick, or the two composition paths
			// silently disagree about how much a lone peer is trusted.
			const coordinatorChain = (cfg: { repairCorroborationClusterSize?: number, assumedClusterSize?: number, clusterSize: number }) =>
				cfg.repairCorroborationClusterSize ?? cfg.assumedClusterSize ?? cfg.clusterSize;

			for (const options of [
				{ clusterSize: 10, clusterPolicy: { repairCorroborationClusterSize: 8 } },
				{ clusterSize: 10, clusterPolicy: { assumedClusterSize: 3, repairCorroborationClusterSize: 8 } },
				{ clusterSize: 10, clusterPolicy: { assumedClusterSize: 4 } },
				{ clusterSize: 6 }
			]) {
				const resolved = resolveClusterPolicy(options);
				const handWired = coordinatorChain({ clusterSize: options.clusterSize, ...options.clusterPolicy });

				expect(handWired, `hand-wired cfg for ${JSON.stringify(options)}`)
					.to.equal(resolved.repairCorroborationClusterSize);
				// ...and the resolved policy is what `libp2p-node-base` spreads into that same factory,
				// so on the resolved object the coordinator's chain is inert.
				expect(coordinatorChain(resolved), JSON.stringify(options))
					.to.equal(resolved.repairCorroborationClusterSize);
			}
		});
	});

	/**
	 * Ticket: feat-declare-repair-yardstick-alone-apply-by-rebuild.
	 *
	 * A degenerate declared size must never land on 2 — the ONE size whose corroboration floor relaxes
	 * to a single voter. Clamping to `minAbsoluteClusterSize` would do exactly that, turning a typo
	 * into "trust one peer"; falling through to the next term treats nonsense as no declaration and
	 * lands on the strict default instead.
	 */
	describe('degenerate declared sizes fall through rather than poisoning the floor', () => {
		const degenerates: [string, number][] = [
			['zero', 0],
			['negative', -5],
			['NaN', Number.NaN],
			['Infinity', Number.POSITIVE_INFINITY],
			['non-integer', 2.5]
		];

		for (const [label, value] of degenerates) {
			it(`a ${label} repairCorroborationClusterSize falls through to clusterSize`, () => {
				const policy = resolveClusterPolicy({ clusterSize: 10, clusterPolicy: { repairCorroborationClusterSize: value } });

				expect(policy.repairCorroborationClusterSize, 'the strict default, not the relaxed 2').to.equal(10);
			});

			it(`a ${label} assumedClusterSize falls through for repair`, () => {
				const policy = resolveClusterPolicy({ clusterSize: 10, clusterPolicy: { assumedClusterSize: value } });

				expect(policy.repairCorroborationClusterSize).to.equal(10);
			});

			it(`a ${label} repairCorroborationClusterSize falls through to a DECLARED assumedClusterSize`, () => {
				const policy = resolveClusterPolicy({
					clusterSize: 10,
					clusterPolicy: { assumedClusterSize: 4, repairCorroborationClusterSize: value }
				});

				expect(policy.repairCorroborationClusterSize).to.equal(4);
			});
		}

		it('floors a degenerate clusterSize at minAbsoluteClusterSize', () => {
			// The only input for which the trailing max() is not a no-op.
			expect(resolveClusterPolicy({ clusterSize: 1 }).repairCorroborationClusterSize).to.equal(minAbsoluteClusterSize);
			expect(resolveClusterPolicy({ clusterSize: 0 }).repairCorroborationClusterSize).to.equal(minAbsoluteClusterSize);
		});

		it('leaves the admission gate an unvalidated pass-through — cluster-repo floors it itself', () => {
			// Deliberately unchanged behaviour: `cluster-repo.admissionFloor` already handles a
			// degenerate value, and tightening it here would alter documented behaviour with no bug.
			expect(resolveClusterPolicy({ clusterPolicy: { assumedClusterSize: 0 } }).assumedClusterSize).to.equal(0);
			expect(resolveClusterPolicy({ clusterPolicy: { assumedClusterSize: -1 } }).assumedClusterSize).to.equal(-1);
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
				declaredRepairSize?: number,
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

		/**
		 * Ticket: small-cohort-arming-rule (review pass).
		 *
		 * The advisory's permanent-decline warnings are about PROOF-LESS data, and only ONE of the two
		 * permanent shapes went quiet. An operator who reads "a provably permanent decline no longer
		 * consults on every read" and then watches `sole-holder` consult on every read has been told
		 * something false by the same paragraph that exists to stop the advisory overstating itself.
		 */
		it('scopes its softeners: proof-less data only, and only cohort-too-small went quiet', async () => {
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 10 });
			});

			const message = advisoryPayload(captured)?.message;
			expect(message).to.contain('VERIFIED cohort commit proof');
			expect(message).to.contain('PROOF-LESS data only');
			// The quiet shape, named, and scoped to blocks this node holds.
			expect(message).to.contain('reason=cohort-too-small');
			expect(message).to.contain('arms the lazy read-repair window');
			expect(message).to.contain('for each block this node HOLDS');
			// ...and the two shapes that deliberately stay loud.
			expect(message).to.contain('Two shapes still consult on every read');
			expect(message).to.contain('does not hold at all');
			// The over-broad claim the review replaced must not come back.
			expect(message).to.not.contain('a provably permanent decline no longer consults');
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

		/**
		 * Ticket: feat-declare-repair-yardstick-alone-apply-by-rebuild.
		 *
		 * Declaring `repairCorroborationClusterSize` IS a declaration. The advisory's undeclared arm
		 * tells the reader to go and set `assumedClusterSize`, which is the wrong advice — and the
		 * wrong field — for someone who has already declared the repair yardstick directly.
		 */
		it('stays silent when only the repair yardstick is declared, at a size with margin', async () => {
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 10, clusterPolicy: { repairCorroborationClusterSize: 5 } });
			});

			expect(hasTag(captured, 'repair-fault-tolerance')).to.equal(false);
		});

		it('still fires the no-margin arm — but not the undeclared arm — when the repair yardstick declares a small size', async () => {
			for (const declared of [2, 3]) {
				const captured = await captureLog('cluster-policy', async () => {
					resolveClusterPolicy({ clusterSize: 10, clusterPolicy: { repairCorroborationClusterSize: declared } });
				});

				const payload = advisoryPayload(captured);
				expect(hasTag(captured, 'repair-fault-tolerance'), `declared ${declared}`).to.equal(true);
				expect(payload?.noRepairMargin, `declared ${declared}`).to.equal(true);
				expect(payload?.cohortUndeclared, 'the operator DID declare a size, just not that field')
					.to.equal(false);
				expect(payload?.message).to.contain('NO fault tolerance');
				expect(payload?.message).to.not.contain('No clusterPolicy.assumedClusterSize declared');
			}
		});

		it('logs which field produced the resolved number', async () => {
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 10, clusterPolicy: { assumedClusterSize: 3, repairCorroborationClusterSize: 3 } });
			});

			const payload = advisoryPayload(captured);
			expect(payload?.declaredCohortSize).to.equal(3);
			expect(payload?.declaredRepairSize).to.equal(3);
		});

		it('names BOTH escape hatches, and which one also moves the write floor', async () => {
			const captured = await captureLog('cluster-policy', async () => {
				resolveClusterPolicy({ clusterSize: 10 });
			});

			const message = advisoryPayload(captured)?.message;
			expect(message).to.contain('clusterPolicy.repairCorroborationClusterSize moves ONLY this repair yardstick');
			expect(message).to.contain("clusterPolicy.assumedClusterSize moves it AND the membership admission gate's write floor");
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
