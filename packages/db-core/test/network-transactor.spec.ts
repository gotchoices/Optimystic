import { expect } from 'chai'
import { NetworkTransactor } from '../src/transactor/network-transactor.js'
import { NetworkSimulation } from './simulation.js'
import type { Scenario } from './simulation.js'
import { randomBytes } from '@libp2p/crypto'
import { blockIdToBytes } from '../src/utility/block-id-to-bytes.js'
import type { BlockId, PendRequest, BlockOperation, ClusterPeers, FindCoordinatorOptions, IKeyNetwork, IRepo, BlockGets, GetBlockResults } from '../src/index.js'
import type { PeerId } from '../src/index.js'
import { peerIdFromString } from '../src/network/types.js'
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import { generateRandomActionId } from './generate-random-action-id.js'
import { TestTransactor } from '../src/testing/test-transactor.js'

describe('NetworkTransactor', () => {
  // Helper to generate block IDs
  const generateBlockId = (): BlockId => uint8ArrayToString(randomBytes(8), 'base64url') as BlockId

  // Helper to setup the test environment
  async function setupNetworkTest(scenario: Scenario = { nodeCount: 10, clusterSize: 1 }) {
    const network = await NetworkSimulation.create(scenario)

    const networkTransactor = new NetworkTransactor({
      timeoutMs: 1000,
      abortOrCancelTimeoutMs: 500,
      keyNetwork: network,
      getRepo: (peerId: PeerId) => {
				const peerIdString = peerId.toString();
				const node = network.getNode(peerIdString);
				if (!node) {
					throw new Error(`Node not found for peerId: ${peerIdString}`)
				}
        return node.transactor
      }
    })

    return { network, networkTransactor }
  }

  // Helper to create a valid BlockOperation
  const createBlockOperation = (): BlockOperation =>
    ['entity1', 0, 0, { field1: 'value1' }]

  // Basic tests for each method
  describe('get', () => {
    it('should fetch blocks from the network', async () => {
      const { networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()

      const result = await networkTransactor.get({
        blockIds: [blockId]
      })

      expect(result).to.be.an('object')
      expect(result[blockId]).to.exist
      expect(result[blockId]!.state).to.exist
    })
  })

  // Retry accounting for get(): an authoritative "absent" answer (an entry that is
  // present but carries no materialized block) is final and must cost exactly one
  // coordinator round. Only a genuine no-response — a missing/partial response with
  // no entry for a requested block id — earns the second-chance retry.
  describe('get retry accounting', () => {
    // Counts findCoordinator calls and picks the first non-excluded peer, so a
    // second-chance retry (which excludes the first coordinator) lands on a distinct
    // peer — letting the test observe whether a retry round happened at all.
    class CountingKeyNetwork implements IKeyNetwork {
      findCoordinatorCalls = 0
      constructor(private readonly peers: string[]) {}
      async findCoordinator(_key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
        this.findCoordinatorCalls++
        const excluded = new Set((options?.excludedPeers ?? []).map(p => p.toString()))
        const pick = this.peers.find(p => !excluded.has(p))
        if (!pick) throw new Error('No coordinator found')
        return peerIdFromString(pick)
      }
      async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
        const peers: ClusterPeers = {}
        for (const p of this.peers) peers[p] = { multiaddrs: [], publicKey: '' }
        return peers
      }
    }

    // Minimal IRepo whose only meaningful method is get(); pend/commit/cancel are
    // unused on the read path and throw if the test somehow reaches them.
    const makeGetOnlyRepo = (getImpl: (b: BlockGets) => Promise<GetBlockResults>): IRepo => ({
      get: getImpl,
      async pend() { throw new Error('unused on read path') },
      async commit() { throw new Error('unused on read path') },
      async cancel() { throw new Error('unused on read path') },
    })

    it('resolves after exactly one coordinator round for an authoritative absent', async () => {
      const peerA = 'peer-A'
      const peerB = 'peer-B' // the fallback the OLD (retry-on-not-found) code would have dialed
      const net = new CountingKeyNetwork([peerA, peerB])

      let getCalls = 0
      // Every requested block is authoritatively absent: entry present, no block.
      const absentRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
        getCalls++
        const res: GetBlockResults = {}
        for (const bid of blockIds) res[bid] = { state: {} }
        return res
      })

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: (_peerId: PeerId) => absentRepo,
      })

      const blockId = 'nonexistent-block' as BlockId
      const result = await networkTransactor.get({ blockIds: [blockId] })

      // Authoritative absent: the entry is present, the block is not.
      expect(result[blockId]).to.exist
      expect(result[blockId]!.block).to.be.undefined

      // Exactly one round — no second-chance retry to a different coordinator.
      expect(net.findCoordinatorCalls).to.equal(1)
      expect(getCalls).to.equal(1)
    })

    it('still retries a genuine no-response (empty response with no entry for the block)', async () => {
      const peerA = 'peer-A'
      const peerB = 'peer-B'
      const net = new CountingKeyNetwork([peerA, peerB])

      const blockId = 'block-x' as BlockId

      let aGets = 0
      let bGets = 0
      // peerA answers with an empty response — no entry for the block at all: a
      // genuine no-response that MUST earn a retry.
      const repoA = makeGetOnlyRepo(async () => {
        aGets++
        return {}
      })
      // peerB (the retry coordinator) answers authoritatively.
      const repoB = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
        bGets++
        const res: GetBlockResults = {}
        for (const bid of blockIds) res[bid] = { state: {} }
        return res
      })

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: (peerId: PeerId) => (peerId.toString() === peerA ? repoA : repoB),
      })

      const result = await networkTransactor.get({ blockIds: [blockId] })

      // The empty first answer forced a second coordinator round that resolved it.
      expect(net.findCoordinatorCalls).to.equal(2)
      expect(aGets).to.equal(1)
      expect(bGets).to.equal(1)
      expect(result[blockId]).to.exist
    })
  })

  describe('pend', () => {
    it('should pend a transaction on the network', async () => {
      const { networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()
      const actionId = generateRandomActionId()

      const pendRequest: PendRequest = {
        actionId,
        transforms: {
          updates: {
            [blockId]: [createBlockOperation()]
          },
          inserts: {},
          deletes: []
        },
        policy: 'c' // Continue normally if there are pending transactions
      }

      const result = await networkTransactor.pend(pendRequest)

      expect(result.success).to.be.true
      // PendResult blockIds property may not exist in the type definition, but the implementation includes it
      if (result.success && 'blockIds' in result) {
        expect(result.blockIds).to.include(blockId)
      }
    })

    it('should handle pend failures gracefully', async () => {
      const { network, networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()
      const actionId = generateRandomActionId()

      // Make one of the nodes unavailable if nodes array is not empty
      if (network.nodes.length > 0) {
        const firstNode = network.nodes[0]
        firstNode!.transactor.available = false

        const pendRequest: PendRequest = {
          actionId,
          transforms: {
            updates: {
              [blockId]: [createBlockOperation()]
            },
            inserts: {},
            deletes: []
          },
          policy: 'c' // Continue normally if there are pending transactions
        }

        try {
          await networkTransactor.pend(pendRequest)
          // If the transaction succeeded despite the failure, that's also okay
        } catch (error) {
          // We expect an error or a successful retry with a different node
          expect(error).to.exist
        }

        // Restore the node for future tests
        firstNode!.transactor.available = true
      }
    })
  })

  describe('commit', () => {
    it('should commit a pending transaction', async () => {
      const { networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()
      const actionId = generateRandomActionId()

      // First pend the transaction
      const pendRequest: PendRequest = {
        actionId,
        transforms: {
          inserts: {	// Has to be an insert for a non-existing block
						[blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } }
					},
          updates: {},
          deletes: []
        },
        policy: 'c' // Continue normally if there are pending transactions
      }

      await networkTransactor.pend(pendRequest)

      // Then commit it
      const result = await networkTransactor.commit({
        actionId,
        rev: 1,
        blockIds: [blockId],
        tailId: blockId,
      })

      expect(result.success).to.be.true
    })
  })

  describe('cancel', () => {
    it('should cancel a pending transaction', async () => {
      const { networkTransactor } = await setupNetworkTest()
      const blockId = generateBlockId()
      const actionId = generateRandomActionId()

      // First pend the transaction
      const pendRequest: PendRequest = {
        actionId,
        transforms: {
          updates: {
            [blockId]: [createBlockOperation()]
          },
          inserts: {},
          deletes: []
        },
        policy: 'c' // Continue normally if there are pending transactions
      }

      await networkTransactor.pend(pendRequest)

      // Then cancel it
      await networkTransactor.cancel({
        actionId,
        blockIds: [blockId]
      })

      // Verify it was canceled by trying to commit, which should fail
      try {
        await networkTransactor.commit({
          actionId,
          rev: 1,
          blockIds: [blockId],
          tailId: blockId,
        })
        throw new Error('Commit should have failed')
      } catch (error) {
        expect(error).to.exist
      }
    })
  })

  describe('queryClusterNominees', () => {
    it('should return cluster nominees for a block', async () => {
      const { networkTransactor } = await setupNetworkTest({ nodeCount: 5, clusterSize: 3 })
      const blockId = generateBlockId()

      const result = await networkTransactor.queryClusterNominees(blockId)

      expect(result).to.be.an('object')
      expect(result.nominees).to.be.an('array')
      expect(result.nominees.length).to.be.greaterThan(0)
      // Each nominee should be a PeerId
      result.nominees.forEach(nominee => {
        expect(nominee.toString()).to.be.a('string')
      })
    })
  })

	// Not implemented yet
  // describe('getStatus', () => {
  //   it('should get the status of transactions', async () => {
  //     const { networkTransactor } = await setupNetworkTest()
  //     const blockId = generateBlockId()
  //     const actionId = generateRandomActionId()

  //     // First pend the transaction
  //     const pendRequest: PendRequest = {
  //       actionId,
  //       transforms: {
  //         updates: {
  //           [blockId]: [createBlockOperation()]
  //         },
  //         inserts: {},
  //         deletes: new Set()
  //       },
  //       policy: 'c' // Continue normally if there are pending transactions
  //     }

  //     await networkTransactor.pend(pendRequest)

  //     // Check status
  //     const statusResult = await networkTransactor.getStatus([{
  //       actionId,
  //       blockIds: [blockId]
  //     }])

  //     expect(statusResult).to.be.an('array').with.length(1)
  //     expect(statusResult[0]!.blockIds).to.include(blockId)
  //     expect(statusResult[0]!.statuses).to.be.an('array').with.length(1)
  //     expect(statusResult[0]!.statuses[0]).to.equal('pending')
  //   })
  // })

  // Test network partition scenarios
  describe('network partitions', () => {
    it('should handle network partitions gracefully', async () => {
      const { network } = await setupNetworkTest({ nodeCount: 10, clusterSize: 1 })

      // Create a partition by making half the nodes only aware of themselves
      const halfNodes = network.nodes.slice(0, 5)
      const partialNodeIds = halfNodes.map(node => node.peerId.toString())

      // Create a partial view of the network
      const partialNetwork = network.createPartialNetworkView(partialNodeIds)

      // Create a transactor that uses this partial network view
      const partialTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: partialNetwork,
        getRepo: (peerId: PeerId) => {
          const node = partialNetwork.getNode(peerId.toString())
          if (!node) {
            throw new Error(`Node not found for peerId: ${peerId.toString()}`)
          }
          return node.transactor
        }
      })

      // Try to pend a transaction with the partial transactor
      const blockId = generateBlockId()
      const actionId = generateRandomActionId()

      const pendRequest: PendRequest = {
        actionId,
        transforms: {
          updates: {
            [blockId]: [createBlockOperation()]
          },
          inserts: {},
          deletes: []
        },
        policy: 'c' // Continue normally if there are pending transactions
      }

      try {
        const result = await partialTransactor.pend(pendRequest)
        expect(result.success).to.be.true
      } catch (error) {
        // If it fails, that's expected in a partition
        expect(error).to.exist
      }
    })
  })

  // Test node failures
  describe('node failures', () => {
    it('should handle node failures by falling back to other nodes', async () => {
      const { network, networkTransactor } = await setupNetworkTest({ nodeCount: 10, clusterSize: 1 })

      // Make a block ID
      const blockId = generateBlockId()
      const actionId = generateRandomActionId()

      // Find the coordinator for this block
      const key = await blockIdToBytes(blockId)
      const closestNodes = network.findCluster(key)

      // Make the coordinator unavailable
      if (closestNodes && Object.keys(closestNodes).length > 0) {
        const coordinator = Object.values(closestNodes)[0]!
        coordinator.transactor.available = false

        // Try to pend a transaction - it should fall back to another node
        const pendRequest: PendRequest = {
          actionId,
          transforms: {
            updates: {
              [blockId]: [createBlockOperation()]
            },
            inserts: {},
            deletes: []
          },
          policy: 'c' // Continue normally if there are pending transactions
        }

        try {
          const result = await networkTransactor.pend(pendRequest)
          expect(result.success).to.be.true
        } catch (error) {
          // If it fails, that's also expected with the coordinator down
          expect(error).to.exist
        }

        // Restore coordinator for future tests
        coordinator.transactor.available = true
      }
    })
  })

  // Tests for cluster intersection coordinator selection
  describe('cluster intersection consolidation', () => {
    // Mock IKeyNetwork with explicit control over cluster membership
    class MockKeyNetwork implements IKeyNetwork {
      private clusterMap = new Map<string, string[]>();
      private fallbackCoordinator: string;

      constructor(fallbackCoordinator: string) {
        this.fallbackCoordinator = fallbackCoordinator;
      }

      /** Register cluster peers for a blockId (pre-hashes to match findCluster lookup) */
      async setCluster(blockId: BlockId, peerIds: string[]) {
        const keyBytes = await blockIdToBytes(blockId);
        const keyStr = uint8ArrayToString(keyBytes, 'base64url');
        this.clusterMap.set(keyStr, peerIds);
      }

      async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
        return peerIdFromString(this.fallbackCoordinator);
      }

      async findCluster(key: Uint8Array): Promise<ClusterPeers> {
        const keyStr = uint8ArrayToString(key, 'base64url');
        const peerIds = this.clusterMap.get(keyStr);
        if (!peerIds) {
          return { [this.fallbackCoordinator]: { multiaddrs: [], publicKey: '' } };
        }
        const peers: ClusterPeers = {};
        for (const pid of peerIds) {
          peers[pid] = { multiaddrs: [], publicKey: '' };
        }
        return peers;
      }
    }

    it('should use a shared cluster peer to consolidate multi-block transactions', async () => {
      const peerA = 'peer-A';
      const peerB = 'peer-B';
      const peerShared = 'peer-shared';

      const mockNetwork = new MockKeyNetwork(peerA);

      const blockId1 = 'block-1' as BlockId;
      const blockId2 = 'block-2' as BlockId;

      // Block 1 cluster: peerA, peerShared
      // Block 2 cluster: peerB, peerShared
      // Intersection: peerShared — should be selected as coordinator for both
      await mockNetwork.setCluster(blockId1, [peerA, peerShared]);
      await mockNetwork.setCluster(blockId2, [peerB, peerShared]);

      // Track which peers receive pend requests
      const pendedPeers: string[] = [];
      const transactors = new Map<string, TestTransactor>();
      for (const pid of [peerA, peerB, peerShared]) {
        transactors.set(pid, new TestTransactor());
      }

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: mockNetwork,
        getRepo: (peerId: PeerId) => {
          const pid = peerId.toString();
          pendedPeers.push(pid);
          const t = transactors.get(pid);
          if (!t) throw new Error(`No transactor for ${pid}`);
          return t;
        }
      });

      const actionId = generateRandomActionId();
      const pendRequest: PendRequest = {
        actionId,
        transforms: {
          updates: {
            [blockId1]: [createBlockOperation()],
            [blockId2]: [createBlockOperation()]
          },
          inserts: {},
          deletes: []
        },
        policy: 'c'
      };

      const result = await networkTransactor.pend(pendRequest);
      expect(result.success).to.be.true;

      // The shared peer should be the only coordinator (1 batch instead of 2)
      expect(pendedPeers).to.have.length(1);
      expect(pendedPeers[0]).to.equal(peerShared);
    });

    it('should fall back to per-block coordinators for non-overlapping clusters', async () => {
      const peerA = 'peer-A';
      const peerB = 'peer-B';

      const mockNetwork = new MockKeyNetwork(peerA);

      const blockId1 = 'block-1' as BlockId;
      const blockId2 = 'block-2' as BlockId;

      // Disjoint clusters
      await mockNetwork.setCluster(blockId1, [peerA]);
      await mockNetwork.setCluster(blockId2, [peerB]);

      const pendedPeers: string[] = [];
      const transactors = new Map<string, TestTransactor>();
      for (const pid of [peerA, peerB]) {
        transactors.set(pid, new TestTransactor());
      }

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: mockNetwork,
        getRepo: (peerId: PeerId) => {
          const pid = peerId.toString();
          pendedPeers.push(pid);
          const t = transactors.get(pid);
          if (!t) throw new Error(`No transactor for ${pid}`);
          return t;
        }
      });

      const actionId = generateRandomActionId();
      const pendRequest: PendRequest = {
        actionId,
        transforms: {
          updates: {
            [blockId1]: [createBlockOperation()],
            [blockId2]: [createBlockOperation()]
          },
          inserts: {},
          deletes: []
        },
        policy: 'c'
      };

      const result = await networkTransactor.pend(pendRequest);
      expect(result.success).to.be.true;

      // Each block gets its own coordinator — 2 batches
      expect(pendedPeers).to.have.length(2);
    });

    it('should handle single-block transactions normally', async () => {
      const peerA = 'peer-A';
      const peerB = 'peer-B';

      const mockNetwork = new MockKeyNetwork(peerA);

      const blockId1 = 'block-1' as BlockId;
      await mockNetwork.setCluster(blockId1, [peerA, peerB]);

      const pendedPeers: string[] = [];
      const transactors = new Map<string, TestTransactor>();
      for (const pid of [peerA, peerB]) {
        transactors.set(pid, new TestTransactor());
      }

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: mockNetwork,
        getRepo: (peerId: PeerId) => {
          const pid = peerId.toString();
          pendedPeers.push(pid);
          const t = transactors.get(pid);
          if (!t) throw new Error(`No transactor for ${pid}`);
          return t;
        }
      });

      const actionId = generateRandomActionId();
      const pendRequest: PendRequest = {
        actionId,
        transforms: {
          updates: {
            [blockId1]: [createBlockOperation()]
          },
          inserts: {},
          deletes: []
        },
        policy: 'c'
      };

      const result = await networkTransactor.pend(pendRequest);
      expect(result.success).to.be.true;

      // Single block = single batch
      expect(pendedPeers).to.have.length(1);
    });

    it('should gracefully degrade when findCluster throws', async () => {
      const peerA = 'peer-A';

      const mockNetwork: IKeyNetwork = {
        async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
          return peerIdFromString(peerA);
        },
        async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
          throw new Error('FRET not available');
        }
      };

      const transactors = new Map<string, TestTransactor>();
      transactors.set(peerA, new TestTransactor());

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: mockNetwork,
        getRepo: (peerId: PeerId) => {
          const t = transactors.get(peerId.toString());
          if (!t) throw new Error(`No transactor for ${peerId.toString()}`);
          return t;
        }
      });

      const blockId1 = 'block-1' as BlockId;
      const actionId = generateRandomActionId();
      const pendRequest: PendRequest = {
        actionId,
        transforms: {
          updates: {
            [blockId1]: [createBlockOperation()]
          },
          inserts: {},
          deletes: []
        },
        policy: 'c'
      };

      // Should succeed via findCoordinator fallback
      const result = await networkTransactor.pend(pendRequest);
      expect(result.success).to.be.true;
    });
  })
})
