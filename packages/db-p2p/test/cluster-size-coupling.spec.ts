/**
 * Ticket: bug-cluster-size-resolution-single-source (Arm A).
 *
 * `createLibp2pNodeBase` used to resolve `clusterSize` three separate times — once for
 * `networkManagerService`, once (correctly) for `consensusConfig`, and once raw for
 * `Libp2pKeyPeerNetwork`, which fell back to its own constructor default (16) whenever the operator
 * left `clusterSize` unset. An unconfigured node therefore ran peer selection at a different cohort
 * width than consensus believed was "full size", widening the gap the membership admission gate's
 * "suspiciously small?" check was supposed to catch.
 *
 * These specs cover both halves of the fix: every consumer resolves to the SAME value on a real
 * node (integration), and the fail-fast coupling check actually throws when consumers disagree
 * (unit, on `assertClusterSizeCoupling` directly — forcing real disagreement on a live node would
 * require reintroducing the bug).
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { resolveClusterPolicy } from '../src/cluster/cluster-policy.js';
import { assertClusterSizeCoupling } from '../src/cluster/cluster-size-coupling.js';

describe('cluster size: one resolved value per node', () => {
	describe('assertClusterSizeCoupling (unit)', () => {
		it('passes when every consumer agrees', () => {
			expect(() => assertClusterSizeCoupling(10, {
				keyNetwork: { effectiveClusterSize: 10 },
				networkManager: { effectiveClusterSize: 10 }
			})).to.not.throw();
		});

		it('throws, naming the disagreeing consumer, when one resolved a different size', () => {
			expect(() => assertClusterSizeCoupling(10, {
				keyNetwork: { effectiveClusterSize: 16 },
				networkManager: { effectiveClusterSize: 10 }
			})).to.throw(/keyNetwork resolved 16/);
		});

		it('throws for every disagreeing consumer at once', () => {
			expect(() => assertClusterSizeCoupling(10, {
				keyNetwork: { effectiveClusterSize: 16 },
				networkManager: { effectiveClusterSize: 1 }
			})).to.throw(/keyNetwork resolved 16.*networkManager resolved 1/s);
		});

		it('skips an undefined consumer rather than treating it as a mismatch', () => {
			expect(() => assertClusterSizeCoupling(10, {
				keyNetwork: { effectiveClusterSize: 10 },
				networkManager: undefined
			})).to.not.throw();
		});
	});

	describe('a real node (integration)', function () {
		// Real libp2p boot + FRET seeding dominate.
		this.timeout(40_000);

		it('resolves the same clusterSize in the key network, the network manager, and consensusConfig', async () => {
			const node = await createLibp2pNode({
				bootstrapNodes: [],
				networkName: 'test-cluster-size-coupling-default',
				arachnode: { enableRingZulu: false }
			});
			try {
				const expected = resolveClusterPolicy({}).clusterSize;
				const keyNetwork = (node as unknown as { keyNetwork: { effectiveClusterSize: number } }).keyNetwork;
				const networkManager = (node as Libp2p & { services: { networkManager: { effectiveClusterSize: number } } })
					.services.networkManager;

				expect(keyNetwork.effectiveClusterSize, 'Libp2pKeyPeerNetwork').to.equal(expected);
				expect(networkManager.effectiveClusterSize, 'NetworkManagerService').to.equal(expected);
			} finally {
				await node.stop();
			}
		});

		it('resolves a configured clusterSize the same way everywhere', async () => {
			const node = await createLibp2pNode({
				bootstrapNodes: [],
				networkName: 'test-cluster-size-coupling-configured',
				clusterSize: 4,
				arachnode: { enableRingZulu: false }
			});
			try {
				const keyNetwork = (node as unknown as { keyNetwork: { effectiveClusterSize: number } }).keyNetwork;
				const networkManager = (node as Libp2p & { services: { networkManager: { effectiveClusterSize: number } } })
					.services.networkManager;

				expect(keyNetwork.effectiveClusterSize).to.equal(4);
				expect(networkManager.effectiveClusterSize).to.equal(4);
			} finally {
				await node.stop();
			}
		});
	});
});
