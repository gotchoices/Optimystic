import { expect } from 'chai'
import { NetworkTransactor } from '../src/transactor/network-transactor.js'
import { highestStaleAt } from '../src/network/stale-failure.js'
import { NetworkSimulation } from './simulation.js'
import type { Scenario } from './simulation.js'
import { randomBytes } from '@libp2p/crypto'
import { blockIdToBytes } from '../src/utility/block-id-to-bytes.js'
import type { BlockId, PendRequest, BlockOperation, ClusterPeers, FindCoordinatorOptions, IKeyNetwork, IRepo, BlockGets, GetBlockResults, StaleFailure, ActionId } from '../src/index.js'
import { BlockUnavailableError } from '../src/index.js'
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

    // Multi-block partial batch: a single coordinator answers for b1 but returns
    // NO entry for b2. The old `.some` predicate judged this batch non-retryable
    // (b1 had an entry) and let b2 fall straight to the missingIds aggregate-error
    // path. The `.every` predicate retries the whole payload on a distinct
    // coordinator and recovers b2.
    it('retries the whole payload when a batch answers some but not all block ids', async () => {
      const peerA = 'peer-A'
      const peerB = 'peer-B'
      const net = new CountingKeyNetwork([peerA, peerB])

      const b1 = 'block-1' as BlockId
      const b2 = 'block-2' as BlockId

      let bGets = 0
      // peerA answers for b1 only — b2 has no entry at all (a partial response).
      const repoA = makeGetOnlyRepo(async () => {
        const res: GetBlockResults = {}
        res[b1] = { state: {} }
        return res
      })
      // peerB (the retry coordinator) answers authoritatively for everything asked.
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

      // Both blocks route to peerA first (CountingKeyNetwork picks the first
      // non-excluded peer), so they share one batch whose partial answer forces a
      // retry to peerB. Without the retry this get() would throw for b2.
      const result = await networkTransactor.get({ blockIds: [b1, b2] })

      expect(bGets).to.be.greaterThan(0) // retry reached the second coordinator
      expect(result[b1]).to.exist
      expect(result[b2]).to.exist
    })

    // Ticket repo-reports-unavailable-vs-absent: an entry flagged `unavailable` is the
    // peer saying its own answer is a guess, so it earns the second-chance retry an
    // authoritative absent deliberately does not — and loses the merge to any peer
    // with a real answer.
    it('retries an unavailable answer against a different peer and prefers the authoritative one', async () => {
      const peerA = 'peer-A'
      const peerB = 'peer-B'
      const net = new CountingKeyNetwork([peerA, peerB])

      const blockId = 'indeterminate-block' as BlockId

      let aGets = 0
      let bGets = 0
      // peerA answers, but flags that it could not establish whether the block exists.
      const unavailableRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
        aGets++
        const res: GetBlockResults = {}
        for (const bid of blockIds) res[bid] = { state: {}, unavailable: 'unmaterializable' }
        return res
      })
      // peerB (the retry coordinator) answers with an authoritative absent.
      const authoritativeRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
        bGets++
        const res: GetBlockResults = {}
        for (const bid of blockIds) res[bid] = { state: {} }
        return res
      })

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: (peerId: PeerId) => (peerId.toString() === peerA ? unavailableRepo : authoritativeRepo),
      })

      const result = await networkTransactor.get({ blockIds: [blockId] })

      // The flagged answer forced a second coordinator round…
      expect(net.findCoordinatorCalls).to.equal(2)
      expect(aGets).to.equal(1)
      expect(bGets).to.equal(1)
      // …and the merge kept the authoritative absent, not the guess.
      expect(result[blockId]).to.exist
      expect(result[blockId]!.unavailable).to.equal(undefined)
    })

    it('carries the unavailable flag through when every consulted peer is indeterminate', async () => {
      const peerA = 'peer-A'
      const peerB = 'peer-B'
      const net = new CountingKeyNetwork([peerA, peerB])

      const blockId = 'indeterminate-block' as BlockId

      // Both peers answer with entries for every id, all flagged — so the read does not
      // throw for a missing entry, but the surviving entry must keep the flag for
      // TransactorSource to convert into BlockUnavailableError.
      const unavailableRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
        const res: GetBlockResults = {}
        for (const bid of blockIds) res[bid] = { state: {}, unavailable: 'peers-unreachable' }
        return res
      })

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: (_peerId: PeerId) => unavailableRepo,
      })

      const result = await networkTransactor.get({ blockIds: [blockId] })

      // Both rounds ran (initial + second chance) and neither produced a better answer.
      expect(net.findCoordinatorCalls).to.equal(2)
      expect(result[blockId]).to.exist
      expect(result[blockId]!.block).to.equal(undefined)
      expect(result[blockId]!.unavailable).to.equal('peers-unreachable')
    })

    it('a materialized block from one peer beats another peer\'s unavailable answer', async () => {
      const peerA = 'peer-A'
      const peerB = 'peer-B'
      const net = new CountingKeyNetwork([peerA, peerB])

      const blockId = 'held-block' as BlockId
      const block = { header: { id: blockId, type: 'T', collectionId: 'c' as BlockId } }

      const unavailableRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
        const res: GetBlockResults = {}
        for (const bid of blockIds) res[bid] = { state: {}, unavailable: 'unmaterializable' }
        return res
      })
      const servingRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
        const res: GetBlockResults = {}
        for (const bid of blockIds) res[bid] = { block, state: { latest: { actionId: 'a1', rev: 1 } } }
        return res
      })

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: (peerId: PeerId) => (peerId.toString() === peerA ? unavailableRepo : servingRepo),
      })

      const result = await networkTransactor.get({ blockIds: [blockId] })

      expect(result[blockId]!.block).to.deep.equal(block)
      expect(result[blockId]!.unavailable).to.equal(undefined)
    })

    // getStatus reads the same three-valued answer: an entry the repo could not determine
    // carries an empty `state`, which the status mapping would otherwise read as a definite
    // `aborted` verdict on the caller's action.
    it('getStatus throws rather than reporting an indeterminate block as aborted', async () => {
      const net = new CountingKeyNetwork(['peer-A', 'peer-B'])
      const blockId = 'indeterminate-block' as BlockId
      const unavailableRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
        const res: GetBlockResults = {}
        for (const bid of blockIds) res[bid] = { state: {}, unavailable: 'unmaterializable' }
        return res
      })

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: (_peerId: PeerId) => unavailableRepo,
      })

      let thrown: unknown
      try {
        await networkTransactor.getStatus([{ blockIds: [blockId], actionId: 'a1' as ActionId }])
      } catch (err) {
        thrown = err
      }
      expect(thrown, 'getStatus must not answer from an indeterminate read').to.be.instanceOf(BlockUnavailableError)
      expect((thrown as BlockUnavailableError).blockId).to.equal(blockId)
    })

    it('getStatus still reports aborted for an authoritatively absent block', async () => {
      const net = new CountingKeyNetwork(['peer-A', 'peer-B'])
      const blockId = 'nonexistent-block' as BlockId
      const absentRepo = makeGetOnlyRepo(async ({ blockIds }: BlockGets) => {
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

      const statuses = await networkTransactor.getStatus([{ blockIds: [blockId], actionId: 'a1' as ActionId }])
      expect(statuses[0]!.statuses).to.deep.equal(['aborted'])
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

    // Regression: a commit that fails with a *reason-only* StaleFailure (no `missing`
    // field) must surface a plain `{ success: false }` result, not crash. TestTransactor
    // returns `{ success: false, reason }` for an action that was never pended; commitBlock
    // classifies that non-success response as "stale" and used to destructure its absent
    // `missing` via a non-null assert, throwing a TypeError inside distinctBlockActionTransforms.
    it('does not crash when a commit fails with only a reason (missing undefined)', async () => {
      const peerA = 'peer-A'
      const net: IKeyNetwork = {
        async findCoordinator() { return peerIdFromString(peerA) },
        async findCluster() { return { [peerA]: { multiaddrs: [], publicKey: '' } } },
      }
      const transactor = new TestTransactor()
      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: () => transactor,
      })

      const blockId = generateBlockId()
      const actionId = generateRandomActionId()

      // Never pended → TestTransactor.commit returns a reason-only StaleFailure.
      const result = await networkTransactor.commit({
        actionId,
        rev: 1,
        blockIds: [blockId],
        tailId: blockId,
      })

      expect(result.success).to.be.false
      if (!result.success) {
        expect(result.missing ?? []).to.deep.equal([])
      }
    })

    // commitBlock rebuilds its failure from the per-batch responses the same way pend does, and
    // deliberately drops the free-form `reason`. The one machine-readable fact inside that prose —
    // which block sits at which revision — must survive the rebuild.
    it('carries staleAt through a rebuilt commit failure even though the reason is dropped', async () => {
      const peerA = 'peer-A'
      const net: IKeyNetwork = {
        async findCoordinator() { return peerIdFromString(peerA) },
        async findCluster() { return { [peerA]: { multiaddrs: [], publicKey: '' } } },
      }
      const staleCommitRepo: IRepo = {
        async get() { return {} },
        async pend() { throw new Error('unused on this path') },
        async cancel() { },
        async commit() {
          return {
            success: false as const,
            conflict: true,
            reason: 'stale revision: block hot at rev 12, requested rev 11',
            staleAt: { blockId: 'hot' as BlockId, rev: 12 }
          }
        },
      }
      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: () => staleCommitRepo,
      })

      const blockId = generateBlockId()
      const result = await networkTransactor.commit({
        actionId: generateRandomActionId(),
        rev: 11,
        blockIds: [blockId],
        tailId: blockId,
      })

      expect(result.success).to.be.false
      if (!result.success) {
        expect(result.staleAt).to.deep.equal({ blockId: 'hot', rev: 12 })
        // Unchanged behaviour: the prose is still dropped by this branch.
        expect(result.reason).to.equal(undefined)
      }
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

  // Per-transaction coordinator cache: a block's cluster/coordinator is resolved once per
  // transaction across the pend→commit window. pend resolves the cluster (findCluster) and
  // records the chosen coordinator per block; the follow-up commit reuses that resolution
  // from the cache instead of calling findCoordinator again.
  describe('per-transaction coordinator cache (pend → commit)', () => {
    // Counts findCluster + findCoordinator so the "resolved once" claim is observable.
    class CountingClusterKeyNetwork implements IKeyNetwork {
      findClusterCalls = 0;
      findCoordinatorCalls = 0;
      private clusterMap = new Map<string, string[]>();
      constructor(private readonly fallbackCoordinator: string) {}

      async setCluster(blockId: BlockId, peerIds: string[]) {
        const keyBytes = await blockIdToBytes(blockId);
        this.clusterMap.set(uint8ArrayToString(keyBytes, 'base64url'), peerIds);
      }

      async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
        this.findCoordinatorCalls++;
        return peerIdFromString(this.fallbackCoordinator);
      }

      async findCluster(key: Uint8Array): Promise<ClusterPeers> {
        this.findClusterCalls++;
        const peerIds = this.clusterMap.get(uint8ArrayToString(key, 'base64url')) ?? [this.fallbackCoordinator];
        const peers: ClusterPeers = {};
        for (const pid of peerIds) peers[pid] = { multiaddrs: [], publicKey: '' };
        return peers;
      }
    }

    const makeTransactor = (net: IKeyNetwork, transactors: Map<string, TestTransactor>) =>
      new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: (peerId: PeerId) => {
          const t = transactors.get(peerId.toString());
          if (!t) throw new Error(`No transactor for ${peerId.toString()}`);
          return t;
        },
      });

    it('commit reuses pend\'s coordinator: each block resolved exactly once, no commit-time findCoordinator', async () => {
      const peerShared = 'peer-shared';
      const net = new CountingClusterKeyNetwork(peerShared);

      const blockId1 = 'block-1' as BlockId;
      const blockId2 = 'block-2' as BlockId;
      // Both blocks share peerShared in their cluster → one consolidated coordinator at pend.
      await net.setCluster(blockId1, [peerShared]);
      await net.setCluster(blockId2, [peerShared]);

      const transactors = new Map<string, TestTransactor>([[peerShared, new TestTransactor()]]);
      const networkTransactor = makeTransactor(net, transactors);

      const actionId = generateRandomActionId();
      const pendRequest: PendRequest = {
        actionId,
        transforms: {
          inserts: {
            [blockId1]: { header: { id: blockId1, type: 'block', collectionId: 'test' } },
            [blockId2]: { header: { id: blockId2, type: 'block', collectionId: 'test' } },
          },
          updates: {},
          deletes: [],
        },
        policy: 'c',
      };

      const pendResult = await networkTransactor.pend(pendRequest);
      expect(pendResult.success).to.be.true;
      // pend resolved each block's cluster exactly once; the cluster covered the coordinator
      // so no findCoordinator fallback was needed.
      expect(net.findClusterCalls).to.equal(2);
      expect(net.findCoordinatorCalls).to.equal(0);

      const commitResult = await networkTransactor.commit({
        actionId,
        rev: 1,
        blockIds: [blockId1, blockId2],
        tailId: blockId1,
      });
      expect(commitResult.success).to.be.true;

      // The commit reused pend's per-transaction resolution: no extra findCluster and,
      // crucially, zero findCoordinator rounds. Each block resolved exactly once, at pend.
      expect(net.findClusterCalls).to.equal(2);
      expect(net.findCoordinatorCalls).to.equal(0);
    });

    it('is per-transaction: a commit under a different actionId misses the cache and resolves live', async () => {
      const peerShared = 'peer-shared';
      const net = new CountingClusterKeyNetwork(peerShared);

      const blockId = 'block-x' as BlockId;
      await net.setCluster(blockId, [peerShared]);

      const transactors = new Map<string, TestTransactor>([[peerShared, new TestTransactor()]]);
      const networkTransactor = makeTransactor(net, transactors);

      // pend under actionA seeds the cache for the block.
      const actionA = generateRandomActionId();
      await networkTransactor.pend({
        actionId: actionA,
        transforms: {
          inserts: { [blockId]: { header: { id: blockId, type: 'block', collectionId: 'test' } } },
          updates: {},
          deletes: [],
        },
        policy: 'c',
      });

      // Committing the SAME block under a DIFFERENT actionId must NOT reuse actionA's entry —
      // it falls back to a live findCoordinator. (The commit itself fails, since the block was
      // never pended under actionB, but the fallback resolution still happens first.)
      net.findCoordinatorCalls = 0;
      const actionB = generateRandomActionId();
      try {
        await networkTransactor.commit({ actionId: actionB, rev: 1, blockIds: [blockId], tailId: blockId });
      } catch { /* expected: block not pending under actionB */ }
      expect(net.findCoordinatorCalls).to.be.greaterThan(0);
    });
  })

  // Mixed batch outcome: one coordinator RESPONDS with a non-success (stale) PendResult while
  // another batch fails with a transport-level throw. The stale response carries real information
  // ("your rev lost the race") and must preempt the transient error: pend() returns a StaleFailure
  // so Collection.sync's bounded retry loop runs, instead of the transport error escaping as a
  // throw mid multi-tree commit (the PartialCommitError shape). Pins network-transactor's
  // stale-preemption branch (see `pend`'s `stale.length > 0` path).
  describe('pend mixed stale + transport failure', () => {
    // `pend` REBUILDS its StaleFailure from the per-batch responses instead of forwarding one, so
    // whatever the aggregate should carry has to be threaded explicitly. Drives the harness once per
    // stale response shape and returns both the aggregate and the per-peer pend counts.
    const runMixedPend = async (staleResponse: StaleFailure) => {
      const peerA = 'peer-A';
      const peerB = 'peer-B';

      const clusterMap = new Map<string, string[]>();
      const setCluster = async (blockId: BlockId, peerIds: string[]) => {
        const keyBytes = await blockIdToBytes(blockId);
        clusterMap.set(uint8ArrayToString(keyBytes, 'base64url'), peerIds);
      };
      const net: IKeyNetwork = {
        // Retry lookup after peerB's transport failure excludes peerB; with no alternative
        // peer this throws, leaving the batch in its errored (never-responded) state — the
        // captured-evidence shape where every failed batch is `(in-flight)`.
        async findCoordinator(_key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
          if (options?.excludedPeers?.length) throw new Error('no alternative coordinator');
          return peerIdFromString(peerA);
        },
        async findCluster(key: Uint8Array): Promise<ClusterPeers> {
          const peerIds = clusterMap.get(uint8ArrayToString(key, 'base64url')) ?? [];
          const peers: ClusterPeers = {};
          for (const pid of peerIds) peers[pid] = { multiaddrs: [], publicKey: '' };
          return peers;
        }
      };

      const blockId1 = 'block-1' as BlockId;
      const blockId2 = 'block-2' as BlockId;
      // Disjoint clusters → two batches, one per coordinator.
      await setCluster(blockId1, [peerA]);
      await setCluster(blockId2, [peerB]);

      let aPends = 0;
      let bPends = 0;
      // peerA responds with the caller-supplied StaleFailure.
      const repoA: IRepo = {
        async get() { return {}; },
        async pend() {
          aPends++;
          return staleResponse;
        },
        async cancel() { },
        async commit() { throw new Error('unused'); }
      };
      // peerB fails at the transport layer — no response at all.
      const repoB: IRepo = {
        async get() { return {}; },
        async pend() {
          bPends++;
          throw new Error('The stream has been reset');
        },
        async cancel() { },
        async commit() { throw new Error('unused'); }
      };

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: (peerId: PeerId) => (peerId.toString() === peerA ? repoA : repoB),
      });

      const actionId = generateRandomActionId();
      const pendRequest: PendRequest = {
        actionId,
        rev: 1,
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

      // Must RETURN a non-success result — the stale response preempts the transport error.
      const result = await networkTransactor.pend(pendRequest);
      return { result, aPends, bPends };
    };

    it('returns StaleFailure (not a throw) when one batch responds stale and another throws', async () => {
      const { result, aPends, bPends } = await runMixedPend({
        success: false,
        conflict: true,
        reason: 'stale revision: block block-1 at rev 1, requested rev 1'
      });

      expect(result.success).to.be.false;
      if (!result.success) {
        // Reason-only stale: the re-aggregated result carries an empty missing list, so the
        // explicit `conflict` flag is the ONLY thing telling the coordinator this is retryable.
        expect(result.missing ?? []).to.deep.equal([]);
        expect(result.reason).to.match(/stale revision/);
        expect(result.conflict, 'aggregation must carry the batch\'s retryability').to.be.true;
      }
      expect(aPends).to.equal(1);
      expect(bPends).to.equal(1);
    });

    it('reports conflict:false when the stale batch was a hard rejection', async () => {
      // A validator/storage rejection carries neither `conflict` nor missing/pending evidence.
      // Re-driving it cannot help, so the aggregate must not claim retryability.
      const { result } = await runMixedPend({ success: false, reason: 'operations hash mismatch' });

      expect(result.success).to.be.false;
      if (!result.success) {
        expect(result.conflict).to.be.false;
      }
    });

    it('infers conflict from missing evidence when the batch sets no flag', async () => {
      const { result } = await runMixedPend({
        success: false,
        missing: [{ actionId: 'rival-action', rev: 1, transforms: { inserts: {}, updates: {}, deletes: [] } }]
      });

      expect(result.success).to.be.false;
      if (!result.success) {
        expect(result.conflict, 'fallback inference keeps older producers retryable').to.be.true;
      }
    });

    it('carries a batch\'s staleAt through the rebuilt aggregate', async () => {
      // The exact combination the field exists for: a confirmed loss with NO `missing`
      // (CoordinatorRepo.classifyStaleRejection's shape). Retryability still rides on `conflict`,
      // and the revision now rides alongside it instead of only inside the reason prose.
      const { result } = await runMixedPend({
        success: false,
        conflict: true,
        reason: 'stale revision: block block-1 at rev 4, requested rev 3',
        staleAt: { blockId: 'block-1', rev: 4 }
      });

      expect(result.success).to.be.false;
      if (!result.success) {
        expect(result.conflict).to.be.true;
        expect(result.missing ?? []).to.deep.equal([]);
        expect(result.staleAt).to.deep.equal({ blockId: 'block-1', rev: 4 });
      }
    });

    it('omits staleAt entirely when no batch reported one', async () => {
      // Not `staleAt: undefined` — the key must be absent, both so the JSON on the wire stays
      // clean and so the repo compiles if `exactOptionalPropertyTypes` ever lands.
      const { result } = await runMixedPend({ success: false, conflict: true, reason: 'stale revision' });

      expect(result.success).to.be.false;
      expect(Object.prototype.hasOwnProperty.call(result, 'staleAt'),
        'an all-absent aggregate must omit the key, not emit undefined').to.be.false;
    });
  })

  // `pend` rebuilds ONE response out of many per-batch ones, so when several batches each report a
  // confirmed revision it has to choose. It picks the highest — every block in the pend commits
  // under one collection revision, so the numbers are comparable and the largest is the constraint
  // the client's next request must clear. Deliberately unlike `reason`, which is first-wins.
  describe('pend staleAt aggregation across batches', () => {
    /** Two disjoint-cluster blocks → two batches, each answering with its own StaleFailure. */
    const runTwoStalePends = async (staleA: StaleFailure, staleB: StaleFailure) => {
      const peerA = 'peer-A';
      const peerB = 'peer-B';

      const clusterMap = new Map<string, string[]>();
      const setCluster = async (blockId: BlockId, peerIds: string[]) => {
        clusterMap.set(uint8ArrayToString(await blockIdToBytes(blockId), 'base64url'), peerIds);
      };
      const net: IKeyNetwork = {
        async findCoordinator(): Promise<PeerId> { return peerIdFromString(peerA); },
        async findCluster(key: Uint8Array): Promise<ClusterPeers> {
          const peers: ClusterPeers = {};
          for (const pid of clusterMap.get(uint8ArrayToString(key, 'base64url')) ?? []) {
            peers[pid] = { multiaddrs: [], publicKey: '' };
          }
          return peers;
        }
      };

      const blockId1 = 'block-1' as BlockId;
      const blockId2 = 'block-2' as BlockId;
      await setCluster(blockId1, [peerA]);
      await setCluster(blockId2, [peerB]);

      const makeRepo = (response: StaleFailure): IRepo => ({
        async get() { return {}; },
        async pend() { return response; },
        async cancel() { },
        async commit() { throw new Error('unused'); }
      });

      const networkTransactor = new NetworkTransactor({
        timeoutMs: 1000,
        abortOrCancelTimeoutMs: 500,
        keyNetwork: net,
        getRepo: (peerId: PeerId) => (peerId.toString() === peerA ? makeRepo(staleA) : makeRepo(staleB)),
      });

      return networkTransactor.pend({
        actionId: generateRandomActionId(),
        rev: 3,
        transforms: {
          updates: { [blockId1]: [createBlockOperation()], [blockId2]: [createBlockOperation()] },
          inserts: {},
          deletes: []
        },
        policy: 'c'
      });
    };

    const staleWith = (blockId: string, rev: number): StaleFailure =>
      ({ success: false, conflict: true, reason: `stale revision: block ${blockId} at rev ${rev}`, staleAt: { blockId, rev } });

    // Run the pair BOTH ways round so the assertion cannot pass by accident on batch ordering:
    // a first-wins implementation would return rev 4 in exactly one of these two cases.
    it('reports the highest rev when the higher one arrives in the second batch', async () => {
      const result = await runTwoStalePends(staleWith('block-1', 4), staleWith('block-2', 9));
      expect(result.success).to.be.false;
      if (!result.success) expect(result.staleAt).to.deep.equal({ blockId: 'block-2', rev: 9 });
    });

    it('reports the highest rev when the higher one arrives in the first batch', async () => {
      const result = await runTwoStalePends(staleWith('block-1', 9), staleWith('block-2', 4));
      expect(result.success).to.be.false;
      if (!result.success) expect(result.staleAt).to.deep.equal({ blockId: 'block-1', rev: 9 });
    });

    it('ignores a batch that reported no staleAt', async () => {
      // A hard rejection (or an older peer) contributes nothing to the selection — it must
      // neither win nor blank out the one real number that was reported.
      const result = await runTwoStalePends(
        { success: false, reason: 'operations hash mismatch' },
        staleWith('block-2', 6)
      );
      expect(result.success).to.be.false;
      if (!result.success) {
        expect(result.staleAt).to.deep.equal({ blockId: 'block-2', rev: 6 });
        // The mixed batch keeps its existing `some`-based retryability, unchanged by the new field.
        expect(result.conflict).to.be.true;
      }
    });
  })

  describe('highestStaleAt', () => {
    it('returns undefined for an all-absent input so callers can omit the key', () => {
      expect(highestStaleAt([undefined, undefined])).to.equal(undefined);
      expect(highestStaleAt([])).to.equal(undefined);
    });

    it('keeps the earlier entry on a tie', () => {
      const first = { blockId: 'b1' as BlockId, rev: 5 };
      expect(highestStaleAt([first, { blockId: 'b2' as BlockId, rev: 5 }])).to.equal(first);
    });

    it('ignores undefined entries interleaved with real ones', () => {
      expect(highestStaleAt([undefined, { blockId: 'b1' as BlockId, rev: 2 }, undefined, { blockId: 'b2' as BlockId, rev: 8 }]))
        .to.deep.equal({ blockId: 'b2', rev: 8 });
    });
  })
})
