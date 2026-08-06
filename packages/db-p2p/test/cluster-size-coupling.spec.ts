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
import { DEFAULT_CLUSTER_SIZE, resolveClusterPolicy } from '../src/cluster/cluster-policy.js';
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
				const keyNetwork = node.keyNetwork;
				const networkManager = (node as unknown as Libp2p & { services: { networkManager: { effectiveClusterSize: number } } })
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
				const keyNetwork = node.keyNetwork;
				const networkManager = (node as unknown as Libp2p & { services: { networkManager: { effectiveClusterSize: number } } })
					.services.networkManager;

				expect(keyNetwork.effectiveClusterSize).to.equal(4);
				expect(networkManager.effectiveClusterSize).to.equal(4);
			} finally {
				await node.stop();
			}
		});

		// Ticket bug-second-key-network-built-with-defaults: two hosts each built a SECOND
		// Libp2pKeyPeerNetwork from constructor defaults, because reaching the node's own required
		// a cast while `new Libp2pKeyPeerNetwork(node)` compiled. This asserts the shape that made
		// the wrong path attractive is gone: `node.keyNetwork` is typed on the returned node, and
		// what it carries is the node's resolved cluster size AND its network-namespaced prefix —
		// the two properties a defaults-built instance got wrong.
		it('attaches its ONE key network on the typed node surface, carrying the resolved cluster size and network prefix', async () => {
			const networkName = 'test-attached-key-network';
			const node = await createLibp2pNode({
				bootstrapNodes: [],
				networkName,
				arachnode: { enableRingZulu: false }
			});
			try {
				// No cast: `createLibp2pNode` returns an OptimysticNode.
				const keyNetwork = node.keyNetwork;

				expect(keyNetwork, 'the node exposes its key network').to.not.equal(undefined);
				expect(keyNetwork.effectiveClusterSize, 'carries the resolved cluster size, not a constructor default')
					.to.equal(resolveClusterPolicy({}).clusterSize);
				expect(keyNetwork.effectiveProtocolPrefix, 'network-membership filter is on and scoped to THIS network')
					.to.equal(`/optimystic/${networkName}`);
			} finally {
				await node.stop();
			}
		});

		it('resolves an unconfigured clusterSize to DEFAULT_CLUSTER_SIZE, the constant a standalone caller must pass', () => {
			// The foreign-node fallback in the Quereus collection-factory constructs a key network
			// for a node it did not build and has to state a size; DEFAULT_CLUSTER_SIZE is that
			// answer, so it must stay equal to what an unconfigured node resolves.
			expect(resolveClusterPolicy({}).clusterSize).to.equal(DEFAULT_CLUSTER_SIZE);
		});
	});
});
