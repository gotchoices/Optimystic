import { use, expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
use(chaiAsPromised)
import { Collection, SyncRetryExhaustedError, type CollectionInitOptions } from '../src/collection/index.js'
import { TestTransactor, FlakyCommitTransactor } from '../src/testing/test-transactor.js'
import { waitFor } from '../src/testing/async-wait.js'
import type { Action, ActionHandler, BlockStore, IBlock, ITransactor, BlockGets, GetBlockResults, ActionBlocks, BlockActionStatus, PendRequest, PendResult, CommitRequest, CommitResult, StaleFailure } from '../src/index.js'
import { BlockUnavailableError } from '../src/index.js'

interface TestAction {
  value: string
  timestamp: number
}

describe('Collection', () => {
  let transactor: TestTransactor
  const collectionId = 'test-collection'

  // Action handlers for testing
  const handlers: Record<string, ActionHandler<TestAction>> = {
    'set': async (_action, store) => {
      const blockId = store.generateId()
      store.insert({
        header: store.createBlockHeader('TEST', blockId)
      })
    },
    'update': async (_action, _store) => {
      // No-op for testing
    }
  }

  // Collection initialization options
  const initOptions = {
    modules: handlers,
    createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({
      header: store.createBlockHeader('TEST', id)
    })
  }

  beforeEach(() => {
    transactor = new TestTransactor()
  })

  it('should create a new collection', async () => {
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
    expect(collection.id).to.equal(collectionId)
  })

  // Ticket repo-reports-unavailable-vs-absent: the end-to-end assertion for the reported
  // bug — a header this node COULD NOT RETRIEVE must fail the open loudly instead of the
  // collection being invented as empty and served indefinitely.
  describe('unavailable header vs authoritatively absent header', () => {
    /** Delegates everything to the inner TestTransactor, but answers reads of any id in
     *  `unavailableIds` with a blockless entry flagged `unavailable` — modelling a repo that
     *  holds records for a block it cannot reconstruct. The set is live, so a test can wedge
     *  a block after the collection is already open. */
    const makeUnavailableBlockTransactor = (inner: TestTransactor, unavailableIds: Set<string>): ITransactor => ({
      async get(gets: BlockGets): Promise<GetBlockResults> {
        const res = await inner.get(gets)
        for (const id of gets.blockIds) {
          if (unavailableIds.has(id)) {
            res[id] = { state: {}, unavailable: 'unmaterializable' }
          }
        }
        return res
      },
      getStatus: (refs: ActionBlocks[]) => inner.getStatus(refs),
      pend: (req: PendRequest) => inner.pend(req),
      cancel: (ref: ActionBlocks) => inner.cancel(ref),
      commit: (req: CommitRequest) => inner.commit(req),
    })

    /** The tail block id the synced header points at — the block `bootstrapContext` reads. */
    const syncedTailId = async (collection: Collection<TestAction>): Promise<string> => {
      await collection.updateAndSync()
      const headerEntry = (await transactor.get({ blockIds: [collectionId] }))[collectionId]
      const tailId = (headerEntry?.block as { tailId?: string } | undefined)?.tailId
      expect(tailId, 'a synced header names its log tail block').to.be.a('string')
      return tailId!
    }

    it('createOrOpen throws BlockUnavailableError instead of inventing an empty collection', async () => {
      const flaky = makeUnavailableBlockTransactor(transactor, new Set([collectionId]))
      const attempt = Collection.createOrOpen<TestAction>(flaky, collectionId, initOptions)
      await expect(attempt).to.be.rejectedWith(BlockUnavailableError)
    })

    it('open throws BlockUnavailableError rather than resolving undefined', async () => {
      const flaky = makeUnavailableBlockTransactor(transactor, new Set([collectionId]))
      const attempt = Collection.open<TestAction>(flaky, collectionId, initOptions)
      await expect(attempt).to.be.rejectedWith(BlockUnavailableError)
    })

    it('open throws when the LOG TAIL is unavailable, not just the header', async () => {
      // The tail is read straight off the transactor (bootstrapContext), bypassing
      // TransactorSource — so it needs its own flag check. Losing it means opening with no
      // ActionContext: the chain walk cannot see pending non-tail blocks and the collection
      // reads as though they were never written.
      const created = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      const tailId = await syncedTailId(created)

      const flaky = makeUnavailableBlockTransactor(transactor, new Set([tailId]))
      await expect(Collection.open<TestAction>(flaky, collectionId, initOptions)).to.be.rejectedWith(BlockUnavailableError)
    })

    it('update() throws when the header goes unavailable after the collection is open', async () => {
      // The mid-life read path: not a StaleFailure, so sync's retry loop cannot absorb it.
      const wedged = new Set<string>()
      const flaky = makeUnavailableBlockTransactor(transactor, wedged)
      const collection = await Collection.createOrOpen<TestAction>(flaky, collectionId, initOptions)
      await collection.updateAndSync()

      wedged.add(collectionId)
      await expect(collection.update()).to.be.rejectedWith(BlockUnavailableError)
    })

    it('createOrOpen against an authoritative absent still creates (the common new-collection probe)', async () => {
      // The single most important regression to guard: the first createOrOpen of EVERY
      // collection probes a header that has never existed. That answer is an unflagged
      // { state: {} } and must keep creating — were it ever flagged, creating any
      // collection would become impossible.
      const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      expect(collection.id).to.equal(collectionId)
      await collection.updateAndSync()
      const reopened = await Collection.open<TestAction>(transactor, collectionId, initOptions)
      expect(reopened, 'a synced collection reopens').to.not.equal(undefined)
    })
  })

  it('should open an existing collection', async () => {
    // Create first instance and sync it to transactor
    const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
    await collection1.updateAndSync() // Sync to transactor so collection2 can see it

    // Open existing collection
    const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
    const actions: Action<TestAction>[] = []
    for await (const logAction of collection2.selectLog()) {
      actions.push(logAction)
    }
    expect(actions).to.have.lengthOf(0)
    expect(collection2.id).to.equal(collection1.id)

    // Verify they share state by adding an action to collection1 and reading from collection2
    const action: Action<TestAction> = {
      type: 'set',
      data: {
        value: 'test value',
        timestamp: Date.now()
      }
    }
    await collection1.act(action)
    await collection1.updateAndSync()

    // collection2 should be able to see the action after updating
    await collection2.update()
    actions.length = 0
    for await (const logAction of collection2.selectLog()) {
      actions.push(logAction)
    }
    expect(actions).to.have.lengthOf(1)
    expect(actions[0]).to.deep.equal(action)
  })

  it('should handle single action transaction', async () => {
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const action: Action<TestAction> = {
      type: 'set',
      data: {
        value: 'test value',
        timestamp: Date.now()
      }
    }

    await collection.act(action)
    await collection.updateAndSync()

    // Verify action is in the log
    const actions: Action<TestAction>[] = []
    for await (const logAction of collection.selectLog()) {
      actions.push(logAction)
    }

    expect(actions).to.have.lengthOf(1)
    expect(actions[0]).to.deep.equal(action)
  })

  it('should handle multiple action transactions', async () => {
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const actions: Action<TestAction>[] = Array(3).fill(0).map((_, i) => ({
      type: 'set',
      data: {
        value: `value ${i + 1}`,
        timestamp: Date.now() + i
      }
    }))

    await collection.act(...actions)
    await collection.updateAndSync()

    // Verify actions are in the log
    const logActions: Action<TestAction>[] = []
    for await (const action of collection.selectLog()) {
      logActions.push(action)
    }

    expect(logActions).to.have.lengthOf(actions.length)
    expect(logActions).to.deep.equal(actions)
  })

  it('should handle reverse log iteration', async () => {
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const actions: Action<TestAction>[] = Array(3).fill(0).map((_, i) => ({
      type: 'set',
      data: {
        value: `value ${i + 1}`,
        timestamp: Date.now() + i
      }
    }))

		for (const action of actions) {
			await collection.act(action)
		}
    await collection.updateAndSync()


    // Verify reverse order
    const logActions: Action<TestAction>[] = []
    for await (const action of collection.selectLog(false)) {
      logActions.push(action)
    }

    expect(logActions).to.have.lengthOf(actions.length)
    expect(logActions).to.deep.equal([...actions].reverse())
  })

  it('should not mutate the stored log across repeated reverse iteration', async () => {
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const actions: Action<TestAction>[] = Array(3).fill(0).map((_, i) => ({
      type: 'set',
      data: {
        value: `value ${i + 1}`,
        timestamp: Date.now() + i
      }
    }))

    for (const action of actions) {
      await collection.act(action)
    }
    await collection.updateAndSync()

    const readReverse = async () => {
      const out: Action<TestAction>[] = []
      for await (const action of collection.selectLog(false)) {
        out.push(action)
      }
      return out
    }

    // selectLog previously reversed the stored entry array in place; a second pass
    // would then see the already-reversed order. Both passes must be identical.
    const first = await readReverse()
    const second = await readReverse()
    expect(first).to.deep.equal([...actions].reverse())
    expect(second).to.deep.equal(first)
  })

  it('should handle reverse synced log iteration', async () => {
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const actions: Action<TestAction>[] = Array(3).fill(0).map((_, i) => ({
      type: 'set',
      data: {
        value: `value ${i + 1}`,
        timestamp: Date.now() + i
      }
    }))

		for (const action of actions) {
			await collection.act(action)
			await collection.sync()
		}

    // Verify reverse order
    const logActions: Action<TestAction>[] = []
    for await (const action of collection.selectLog(false)) {
      logActions.push(action)
    }

    expect(logActions).to.have.lengthOf(actions.length)
    expect(logActions).to.deep.equal([...actions].reverse())
  })

  it('should resolve concurrent creation (first synced wins)', async () => {
    const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
    const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    await collection1.sync()
    // Second collection should succeed because it should recognize the log file conflict and update.
    await collection2.sync()
  })

  it('should allow operations on losing collection after concurrent creation', async () => {
    const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
    const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    // collection1 wins the creation race
    await collection1.sync()
    // collection2 loses, recovers
    await collection2.sync()

    // collection2 should be usable after recovery
    const action: Action<TestAction> = {
      type: 'set',
      data: { value: 'post-recovery', timestamp: Date.now() }
    }
    await collection2.act(action)
    await collection2.sync()

    // collection1 should see collection2's action after updating
    await collection1.update()
    const actions: Action<TestAction>[] = []
    for await (const a of collection1.selectLog()) {
      actions.push(a)
    }
    expect(actions).to.have.lengthOf(1)
    expect(actions[0]!.data.value).to.equal('post-recovery')
  })

  it('should resolve concurrent creation with pending data on both peers', async () => {
    const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
    const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    // Both peers add data before either syncs
    const action1: Action<TestAction> = {
      type: 'set',
      data: { value: 'peer1-data', timestamp: 1 }
    }
    const action2: Action<TestAction> = {
      type: 'set',
      data: { value: 'peer2-data', timestamp: 2 }
    }

    await collection1.act(action1)
    await collection2.act(action2)

    // collection1 syncs first (wins creation, commits action1)
    await collection1.sync()

    // collection2 syncs (loses creation, should recover and commit action2)
    await collection2.updateAndSync()

    // Both should converge
    await collection1.update()
    await collection2.update()

    const actions1: Action<TestAction>[] = []
    for await (const a of collection1.selectLog()) {
      actions1.push(a)
    }

    const actions2: Action<TestAction>[] = []
    for await (const a of collection2.selectLog()) {
      actions2.push(a)
    }

    expect(actions1).to.have.lengthOf(2)
    expect(actions2).to.have.lengthOf(2)
    expect(new Set(actions1.map(a => a.data.value)))
      .to.deep.equal(new Set(['peer1-data', 'peer2-data']))
    expect(new Set(actions2.map(a => a.data.value)))
      .to.deep.equal(new Set(['peer1-data', 'peer2-data']))
  })

  it('should handle latch-serialized concurrent sync after concurrent creation', async () => {
    const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
    const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const action1: Action<TestAction> = {
      type: 'set',
      data: { value: 'value 1', timestamp: Date.now() }
    }

    const action2: Action<TestAction> = {
      type: 'set',
      data: { value: 'value 2', timestamp: Date.now() + 1 }
    }

    await collection1.act(action1)
    await collection2.act(action2)

    // Both sync via Promise.all - serialized by shared latch
    await Promise.all([
      collection1.updateAndSync(),
      collection2.updateAndSync()
    ])

    await collection1.update()
    await collection2.update()

    const actions1: Action<TestAction>[] = []
    for await (const action of collection1.selectLog()) {
      actions1.push(action)
    }

    const actions2: Action<TestAction>[] = []
    for await (const action of collection2.selectLog()) {
      actions2.push(action)
    }

    // Both collections should see both actions
    expect(actions1).to.have.lengthOf(2)
    expect(actions2).to.have.lengthOf(2)
    expect(new Set(actions1.map(a => a.data.value)))
      .to.deep.equal(new Set(['value 1', 'value 2']))
    expect(new Set(actions2.map(a => a.data.value)))
      .to.deep.equal(new Set(['value 1', 'value 2']))
  })

  it('should handle multiple action types', async () => {
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const actions: Action<TestAction>[] = [
      {
        type: 'set',
        data: {
          value: 'initial value',
          timestamp: Date.now()
        }
      },
      {
        type: 'update',
        data: {
          value: 'updated value',
          timestamp: Date.now() + 1
        }
      }
    ]

    await collection.act(...actions)
    await collection.updateAndSync()

    const logActions: Action<TestAction>[] = []
    for await (const action of collection.selectLog()) {
      logActions.push(action)
    }

    expect(logActions).to.have.lengthOf(2)
    expect(logActions.map(a => a.type)).to.deep.equal(['set', 'update'])
  })

  it('should handle large number of actions', async () => {
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const actionCount = 100
    const actions: Action<TestAction>[] = Array(actionCount).fill(0).map((_, i) => ({
      type: 'set',
      data: {
        value: `value ${i + 1}`,
        timestamp: Date.now() + i
      }
    }))

    // Add actions in batches
    const batchSize = 10
    for (let i = 0; i < actions.length; i += batchSize) {
      const batch = actions.slice(i, i + batchSize)
      await collection.act(...batch)
      await collection.updateAndSync()
    }

    // Verify all actions are present
    const logActions: Action<TestAction>[] = []
    for await (const action of collection.selectLog()) {
      logActions.push(action)
    }

    expect(logActions).to.have.lengthOf(actionCount)
    expect(logActions.map(a => a.data.value))
      .to.deep.equal(actions.map(a => a.data.value))
  })

  it('should handle state recovery after failed sync', async () => {
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const action: Action<TestAction> = {
      type: 'set',
      data: {
        value: 'test value',
        timestamp: Date.now()
      }
    }

    // Add action but don't sync
    await collection.act(action)

    // Simulate failed sync by making transactor temporarily unavailable
    transactor.setAvailable(false)
    const updatePromise = collection.updateAndSync()
    updatePromise.catch(() => { /* expected rejection - prevent unhandled rejection in browser */ })
    await expect(updatePromise).to.be.rejected

    // Restore transactor and retry
    transactor.setAvailable(true)
    await collection.updateAndSync()

    // Verify action was eventually synced
    const actions: Action<TestAction>[] = []
    for await (const logAction of collection.selectLog()) {
      actions.push(logAction)
    }
    expect(actions).to.have.lengthOf(1)
    expect(actions[0]).to.deep.equal(action)
  })

  // TEST-3.3.1: Collection conflict resolution tests (filterConflict callback behavior)
  describe('conflict resolution (TEST-3.3.1)', () => {
    it('should discard pending action when filterConflict returns undefined', async () => {
      const optionsWithFilter: CollectionInitOptions<TestAction> = {
        ...initOptions,
        filterConflict: (_action, _potential) => undefined
      }

      const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, optionsWithFilter)
      const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, optionsWithFilter)

      // Sync collection1 first to establish the log
      await collection1.updateAndSync()
      await collection2.update()

      // Add remote action via collection1
      const remoteAction: Action<TestAction> = {
        type: 'set',
        data: { value: 'remote', timestamp: 1 }
      }
      await collection1.act(remoteAction)
      await collection1.sync()

      // Add local pending action to collection2
      const localAction: Action<TestAction> = {
        type: 'set',
        data: { value: 'local', timestamp: 2 }
      }
      await collection2.act(localAction)

      // Update collection2 - should trigger filterConflict and discard the local action
      await collection2.updateAndSync()

      // Should only have the remote action (local was discarded)
      const actions: Action<TestAction>[] = []
      for await (const a of collection2.selectLog()) {
        actions.push(a)
      }
      expect(actions).to.have.lengthOf(1)
      expect(actions[0]?.data.value).to.equal('remote')
    })

    it('should keep pending action when filterConflict returns original action', async () => {
      const optionsWithFilter: CollectionInitOptions<TestAction> = {
        ...initOptions,
        filterConflict: (action, _potential) => action
      }

      const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, optionsWithFilter)
      const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, optionsWithFilter)

      await collection1.updateAndSync()
      await collection2.update()

      const remoteAction: Action<TestAction> = {
        type: 'set',
        data: { value: 'remote', timestamp: 1 }
      }
      await collection1.act(remoteAction)
      await collection1.sync()

      const localAction: Action<TestAction> = {
        type: 'set',
        data: { value: 'local', timestamp: 2 }
      }
      await collection2.act(localAction)

      // Update and sync collection2 - filterConflict keeps local action
      await collection2.updateAndSync()

      const actions: Action<TestAction>[] = []
      for await (const a of collection2.selectLog()) {
        actions.push(a)
      }
      // Remote + local both present
      expect(actions).to.have.lengthOf(2)
      expect(actions.map(a => a.data.value)).to.include('remote')
      expect(actions.map(a => a.data.value)).to.include('local')
    })

    it('should apply the replacement action when filterConflict returns a rewritten action', async () => {
      // filterConflict rewrites the local 'local' action into a 'merged' action.
      // The rewritten action must end up in pending (and thus the committed log),
      // replacing the original — not be silently dropped.
      const optionsWithFilter: CollectionInitOptions<TestAction> = {
        ...initOptions,
        filterConflict: (action, _potential) =>
          action.data.value === 'local'
            ? { type: 'set', data: { value: 'merged', timestamp: action.data.timestamp } }
            : action
      }

      const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, optionsWithFilter)
      const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, optionsWithFilter)

      await collection1.updateAndSync()
      await collection2.update()

      const remoteAction: Action<TestAction> = {
        type: 'set',
        data: { value: 'remote', timestamp: 1 }
      }
      await collection1.act(remoteAction)
      await collection1.sync()

      const localAction: Action<TestAction> = {
        type: 'set',
        data: { value: 'local', timestamp: 2 }
      }
      await collection2.act(localAction)

      // Update+sync collection2 - filterConflict rewrites 'local' -> 'merged'
      await collection2.updateAndSync()

      const actions: Action<TestAction>[] = []
      for await (const a of collection2.selectLog()) {
        actions.push(a)
      }
      const values = actions.map(a => a.data.value)
      // Remote survives; the rewritten action replaces the original local action
      expect(values).to.include('remote')
      expect(values).to.include('merged')
      expect(values).to.not.include('local')
    })

    it('should commit the replacement block effects, not the original', async () => {
      // Regression guard for the load-bearing replay. The plain-log replacement test above
      // passes even without the forced replay, because the map assigns the replacement into
      // `pending` directly. The real bug is block-level: without a replay the tracker still
      // holds the ORIGINAL action's block transform while `pending` reflects the replacement,
      // so the committed blocks diverge from the committed log. This handler embeds the action
      // value into the inserted block so committed block content is observable; the assertions
      // fail if `mutated`-forced replay is removed (committed blocks would carry 'local', and
      // never 'merged').
      const valueModules: Record<string, ActionHandler<TestAction>> = {
        'set': async (action, store) => {
          const blockId = store.generateId()
          store.insert({
            header: store.createBlockHeader('TEST', blockId),
            value: action.data.value
          } as IBlock)
        },
        'update': async () => { /* no-op */ }
      }
      const optionsWithFilter: CollectionInitOptions<TestAction> = {
        ...initOptions,
        modules: valueModules,
        filterConflict: (action, _potential) =>
          action.data.value === 'local'
            ? { type: 'set', data: { value: 'merged', timestamp: action.data.timestamp } }
            : action
      }

      const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, optionsWithFilter)
      const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, optionsWithFilter)

      await collection1.updateAndSync()
      await collection2.update()

      await collection1.act({ type: 'set', data: { value: 'remote', timestamp: 1 } })
      await collection1.sync()

      await collection2.act({ type: 'set', data: { value: 'local', timestamp: 2 } })
      await collection2.updateAndSync()

      // Collect the `value` of every committed inserted block.
      const committedValues = new Set<string>()
      for (const [, at] of transactor.getCommittedActions()) {
        for (const block of Object.values(at.transforms.inserts ?? {})) {
          const value = (block as { value?: string }).value
          if (value !== undefined) committedValues.add(value)
        }
      }
      // The rewritten action's block effect is committed; the original's is not.
      expect(committedValues.has('merged'), 'replacement block effect must be committed').to.equal(true)
      expect(committedValues.has('local'), 'original block effect must not survive the rewrite').to.equal(false)
    })

    it('should keep pending when no filterConflict provided', async () => {
      const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

      await collection1.updateAndSync()
      await collection2.update()

      await collection1.act({ type: 'set', data: { value: 'remote', timestamp: 1 } })
      await collection1.sync()

      await collection2.act({ type: 'set', data: { value: 'local', timestamp: 2 } })
      await collection2.updateAndSync()

      const actions: Action<TestAction>[] = []
      for await (const a of collection2.selectLog()) {
        actions.push(a)
      }
      expect(actions).to.have.lengthOf(2)
    })
  })

  // TEST-3.3.2: Concurrent sync() tests
  describe('concurrent sync (TEST-3.3.2)', () => {
    it('should serialize concurrent sync calls via latch', async () => {
      const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

      for (let i = 0; i < 5; i++) {
        await collection.act({
          type: 'set',
          data: { value: `value-${i}`, timestamp: Date.now() + i }
        })
      }

      // Trigger multiple syncs concurrently - they should serialize
      await Promise.all([
        collection.updateAndSync(),
        collection.updateAndSync(),
        collection.updateAndSync()
      ])

      const actions: Action<TestAction>[] = []
      for await (const a of collection.selectLog()) {
        actions.push(a)
      }
      expect(actions).to.have.lengthOf(5)
    })

    it('should handle act during sync', async () => {
      const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

      await collection.act({ type: 'set', data: { value: 'before-sync', timestamp: 1 } })

      // Start sync
      const syncPromise = collection.updateAndSync()

      // Add action during sync (will be queued due to latch)
      const actPromise = collection.act({ type: 'set', data: { value: 'during-sync', timestamp: 2 } })

      await syncPromise
      await actPromise
      await collection.updateAndSync()

      const actions: Action<TestAction>[] = []
      for await (const a of collection.selectLog()) {
        actions.push(a)
      }
      expect(actions).to.have.lengthOf(2)
    })
  })

  describe('context bootstrap on collection open', () => {
    /**
     * PartialCommitTransactor wraps a TestTransactor to simulate partial commits:
     * when partialMode is ON, commit() only commits the header and tail blocks,
     * leaving the rest as pending. This reproduces the scenario where a commit
     * completed its tail but non-tail blocks are still in-flight.
     */
    class PartialCommitTransactor implements ITransactor {
      partialMode = false
      constructor(private inner: TestTransactor) {}

      get(b: BlockGets): Promise<GetBlockResults> { return this.inner.get(b) }
      getStatus(a: ActionBlocks[]): Promise<BlockActionStatus[]> { return this.inner.getStatus(a) }
      pend(r: PendRequest): Promise<PendResult> { return this.inner.pend(r) }
      cancel(a: ActionBlocks): Promise<void> { return this.inner.cancel(a) }

      async commit(request: CommitRequest): Promise<CommitResult> {
        if (this.partialMode) {
          // Only commit header + tail blocks, leaving the rest as pending
          const committed = request.blockIds.filter(id =>
            id === request.tailId || id === request.headerId
          )
          return this.inner.commit({ ...request, blockIds: committed })
        }
        return this.inner.commit(request)
      }
    }

    it('should bootstrap context and open collection with pending non-tail blocks', async () => {
      const inner = new TestTransactor()
      const partial = new PartialCommitTransactor(inner)

      // Create and sync collection normally (partialMode OFF)
      const c1 = await Collection.createOrOpen<TestAction>(partial, collectionId, initOptions)
      await c1.updateAndSync()

      // Add enough entries in separate syncs to fill the first chain block (32 entries)
      // and overflow to a second, creating non-tail chain data blocks
      for (let i = 0; i < 34; i++) {
        await c1.act({ type: 'set', data: { value: `entry-${i}`, timestamp: i } })
        await c1.sync()
      }

      // Now enable partial commit mode: next sync only commits header + tail
      partial.partialMode = true
      await c1.act({ type: 'set', data: { value: 'partial-entry', timestamp: 100 } })
      await c1.sync()

      // Open a fresh collection handle — without bootstrap fix this would fail
      // because chain walk reads non-tail blocks with context=undefined
      const c2 = await Collection.createOrOpen<TestAction>(partial, collectionId, initOptions)

      // Verify collection opened successfully and can read the log
      const actions: Action<TestAction>[] = []
      for await (const a of c2.selectLog()) {
        actions.push(a)
      }
      expect(actions.length).to.be.greaterThanOrEqual(35)
    })

    it('should bootstrap context in updateInternal with pending non-tail blocks', async () => {
      const inner = new TestTransactor()
      const partial = new PartialCommitTransactor(inner)

      // Create collection and sync normally
      const c1 = await Collection.createOrOpen<TestAction>(partial, collectionId, initOptions)
      await c1.updateAndSync()

      // Fill chain to overflow
      for (let i = 0; i < 34; i++) {
        await c1.act({ type: 'set', data: { value: `entry-${i}`, timestamp: i } })
        await c1.sync()
      }

      // Open a second handle while everything is committed
      const c2 = await Collection.createOrOpen<TestAction>(partial, collectionId, initOptions)

      // Now partial-commit a new entry on c1
      partial.partialMode = true
      await c1.act({ type: 'set', data: { value: 'partial-entry', timestamp: 100 } })
      await c1.sync()

      // c2.update() should succeed — updateInternal bootstraps context from tail
      await c2.update()

      const actions: Action<TestAction>[] = []
      for await (const a of c2.selectLog()) {
        actions.push(a)
      }
      expect(actions.length).to.be.greaterThanOrEqual(35)
    })

    it('should handle createOrOpen with no prior commits (no bootstrap needed)', async () => {
      // Fresh collection with no prior commits should work fine — no tailId to bootstrap from
      const c = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      expect(c.id).to.equal(collectionId)

      // Should be able to add actions and sync
      await c.act({ type: 'set', data: { value: 'first', timestamp: 1 } })
      await c.updateAndSync()

      const actions: Action<TestAction>[] = []
      for await (const a of c.selectLog()) {
        actions.push(a)
      }
      expect(actions).to.have.lengthOf(1)
    })
  })

  // Bounded sync retry (collection-sync-infinite-retry)
  describe('bounded sync retry', () => {
    it('should give up with SyncRetryExhaustedError after maxAttempts consecutive stale failures', async () => {
      // A transactor whose commit ALWAYS fails would spin sync() forever before the fix.
      const inner = new TestTransactor()
      const flaky = new FlakyCommitTransactor(inner, Infinity, 'always stale')
      const collection = await Collection.createOrOpen<TestAction>(flaky, collectionId, initOptions)

      await collection.act({ type: 'set', data: { value: 'never-commits', timestamp: 1 } })

      const maxAttempts = 3
      const syncPromise = collection.sync({ maxAttempts, baseBackoffMs: 1, maxBackoffMs: 5 })
      syncPromise.catch(() => { /* asserted below - avoid unhandled rejection */ })

      await expect(syncPromise).to.be.rejectedWith(SyncRetryExhaustedError)
      const err = await syncPromise.catch(e => e) as SyncRetryExhaustedError
      expect(err.collectionId).to.equal(collectionId)
      expect(err.attempts).to.equal(maxAttempts)
      expect(err.lastReason).to.equal('always stale')

      // Bounded: the transactor saw exactly maxAttempts commit attempts, not an unbounded number.
      expect(flaky.commitAttempts).to.equal(maxAttempts)

      // Latch was released by sync()'s finally — a subsequent latched op must not hang.
      await collection.update()
    })

    // `staleAt` is the responder's own confirmed revision, carried as data rather than only inside
    // the reject prose. A stuck writer that burns its whole budget should be told the number it is
    // up against; a responder that reports none must leave today's message byte-identical.
    describe('staleAt on exhaustion', () => {
      /** Always fails commit with the caller-supplied StaleFailure. Deliberately local rather than
       *  a change to FlakyCommitTransactor: the shared harness must keep never setting `staleAt`. */
      class StaleAtCommitTransactor implements ITransactor {
        commitAttempts = 0
        constructor(private readonly inner: TestTransactor, private readonly failure: StaleFailure) {}
        get(b: BlockGets) { return this.inner.get(b) }
        getStatus(a: ActionBlocks[]) { return this.inner.getStatus(a) }
        pend(r: PendRequest) { return this.inner.pend(r) }
        cancel(a: ActionBlocks) { return this.inner.cancel(a) }
        async commit(_request: CommitRequest): Promise<CommitResult> {
          this.commitAttempts++
          return this.failure
        }
      }

      const exhaust = async (failure: StaleFailure) => {
        const transactorUnderTest = new StaleAtCommitTransactor(new TestTransactor(), failure)
        const collection = await Collection.createOrOpen<TestAction>(transactorUnderTest, collectionId, initOptions)
        await collection.act({ type: 'set', data: { value: 'never-commits', timestamp: 1 } })
        const syncPromise = collection.sync({ maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 5 })
        syncPromise.catch(() => { /* asserted by the caller */ })
        return await syncPromise.catch(e => e) as SyncRetryExhaustedError
      }

      it('surfaces the reported revision on the error and names it in the message', async () => {
        const err = await exhaust({
          success: false,
          conflict: true,
          reason: 'stale revision: block hot-block at rev 42, requested rev 41',
          staleAt: { blockId: 'hot-block', rev: 42 }
        })

        expect(err).to.be.instanceOf(SyncRetryExhaustedError)
        expect(err.staleAt).to.deep.equal({ blockId: 'hot-block', rev: 42 })
        expect(err.message).to.contain('last seen block hot-block at rev 42')
        // The prefix every existing assertion reads is untouched by the appended clause.
        expect(err.message).to.contain(`sync for collection ${collectionId} exhausted 3 retries`)
      })

      it('produces today\'s message verbatim when no responder reported a revision', async () => {
        const err = await exhaust({ success: false, conflict: true, reason: 'always stale' })

        expect(err).to.be.instanceOf(SyncRetryExhaustedError)
        expect(err.staleAt).to.equal(undefined)
        expect(err.message).to.equal(`sync for collection ${collectionId} exhausted 3 retries: always stale`)
      })

      it('keeps the last reported revision when a later failure reports none', async () => {
        // `lastStaleAt` follows `lastReason`'s rule: a failure that defines it overwrites, one that
        // does not leaves the previous value standing — so the number survives to the throw.
        const transactorUnderTest = new (class implements ITransactor {
          attempts = 0
          constructor(readonly inner = new TestTransactor()) {}
          get(b: BlockGets) { return this.inner.get(b) }
          getStatus(a: ActionBlocks[]) { return this.inner.getStatus(a) }
          pend(r: PendRequest) { return this.inner.pend(r) }
          cancel(a: ActionBlocks) { return this.inner.cancel(a) }
          async commit(_request: CommitRequest): Promise<CommitResult> {
            this.attempts++
            return this.attempts === 1
              ? { success: false, conflict: true, reason: 'first', staleAt: { blockId: 'hot-block', rev: 7 } }
              : { success: false, conflict: true, reason: 'later, unconfirmed' }
          }
        })()

        const collection = await Collection.createOrOpen<TestAction>(transactorUnderTest, collectionId, initOptions)
        await collection.act({ type: 'set', data: { value: 'never-commits', timestamp: 1 } })
        const syncPromise = collection.sync({ maxAttempts: 3, baseBackoffMs: 1, maxBackoffMs: 5 })
        syncPromise.catch(() => { /* asserted below */ })
        const err = await syncPromise.catch(e => e) as SyncRetryExhaustedError

        expect(err.staleAt).to.deep.equal({ blockId: 'hot-block', rev: 7 })
        expect(err.lastReason).to.equal('later, unconfirmed')
      })
    })

    it('should reject promptly with an AbortError when the signal aborts mid-retry', async () => {
      const inner = new TestTransactor()
      const flaky = new FlakyCommitTransactor(inner, Infinity)
      const collection = await Collection.createOrOpen<TestAction>(flaky, collectionId, initOptions)

      await collection.act({ type: 'set', data: { value: 'aborted', timestamp: 1 } })

      const controller = new AbortController()
      // Large backoff + high attempt budget: without abort this would sit in the backoff sleep.
      const syncPromise = collection.sync({
        signal: controller.signal,
        maxAttempts: 1000,
        baseBackoffMs: 60_000,
        maxBackoffMs: 60_000,
      })
      syncPromise.catch(() => { /* asserted below */ })

      // Poll until the first commit attempt has been made (sync is now in backoff), then abort.
      await waitFor(() => flaky.commitAttempts >= 1, { description: 'sync should attempt first commit before abort' })
      controller.abort()

      const err = await syncPromise.catch(e => e) as Error
      expect(err).to.be.instanceOf(Error)
      expect(err).to.not.be.instanceOf(SyncRetryExhaustedError)
      expect(err.name).to.equal('AbortError')

      // Latch released despite the abort.
      await collection.update()
    })

    it('should recover from transient stale failures within the attempt budget', async () => {
      // Fails the first two commits, then delegates — proves the counter resets on progress and
      // that a transient failure recovers rather than exhausting a modest budget.
      const inner = new TestTransactor()
      const flaky = new FlakyCommitTransactor(inner, 2)
      const collection = await Collection.createOrOpen<TestAction>(flaky, collectionId, initOptions)

      await collection.act({ type: 'set', data: { value: 'eventually-commits', timestamp: 1 } })
      await collection.sync({ maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 })

      const actions: Action<TestAction>[] = []
      for await (const a of collection.selectLog()) {
        actions.push(a)
      }
      expect(actions).to.have.lengthOf(1)
      expect(actions[0]?.data.value).to.equal('eventually-commits')
    })

    it('should give up with SyncRetryExhaustedError when the wall-clock deadline is exceeded', async () => {
      // Always-fail transactor with a fast backoff and a huge attempt budget: the ONLY thing that
      // can stop this loop is the deadline, so reaching SyncRetryExhaustedError proves deadlineMs works
      // independently of maxAttempts.
      const inner = new TestTransactor()
      const flaky = new FlakyCommitTransactor(inner, Infinity, 'deadline test stale')
      const collection = await Collection.createOrOpen<TestAction>(flaky, collectionId, initOptions)

      await collection.act({ type: 'set', data: { value: 'deadline', timestamp: 1 } })

      const syncPromise = collection.sync({
        deadlineMs: 30,
        maxAttempts: 1_000_000, // effectively unreachable within the deadline window
        baseBackoffMs: 1,
        maxBackoffMs: 1,
      })
      syncPromise.catch(() => { /* asserted below */ })

      const err = await syncPromise.catch(e => e) as SyncRetryExhaustedError
      expect(err).to.be.instanceOf(SyncRetryExhaustedError)
      expect(err.collectionId).to.equal(collectionId)
      // Stopped by the deadline, not the (unreachable) attempt cap.
      expect(err.attempts).to.be.lessThan(1_000_000)
      expect(flaky.commitAttempts).to.be.lessThan(1_000_000)

      // Latch released by sync()'s finally.
      await collection.update()
    })

    it('should complete a healthy multi-batch sync under a tiny maxAttempts (cap is on consecutive failures)', async () => {
      // A naive "max N loop iterations" cap would trip on a large sync; the real cap counts only
      // consecutive no-progress failures, so a healthy multi-batch sync passes with maxAttempts: 2.
      const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

      const actionCount = 100
      const actions: Action<TestAction>[] = Array(actionCount).fill(0).map((_, i) => ({
        type: 'set',
        data: { value: `value ${i + 1}`, timestamp: Date.now() + i }
      }))

      const batchSize = 10
      for (let i = 0; i < actions.length; i += batchSize) {
        await collection.act(...actions.slice(i, i + batchSize))
        await collection.updateAndSync({ maxAttempts: 2, baseBackoffMs: 1 })
      }

      const logActions: Action<TestAction>[] = []
      for await (const a of collection.selectLog()) {
        logActions.push(a)
      }
      expect(logActions).to.have.lengthOf(actionCount)
      expect(logActions.map(a => a.data.value)).to.deep.equal(actions.map(a => a.data.value))
    })
  })

  describe('open vs createOrOpen', () => {
    it('should resolve undefined when opening a collection with no committed header', async () => {
      const opened = await Collection.open<TestAction>(transactor, 'never-created', initOptions)
      expect(opened).to.be.undefined
    })

    it('should stage nothing when open misses, so no phantom collection can be synced', async () => {
      // A caller that ignores the undefined must not be able to bring the collection into
      // existence anyway: nothing was inserted into any tracker, so the transactor stays empty.
      await Collection.open<TestAction>(transactor, 'never-created', initOptions)

      // Nothing was committed under that id, so a subsequent open still misses...
      expect(await Collection.open<TestAction>(transactor, 'never-created', initOptions)).to.be.undefined
      // ...and no blocks landed in storage for it.
      const result = await transactor.get({ blockIds: ['never-created'] })
      expect(result['never-created']?.block).to.be.undefined
    })

    it('should open a collection that createOrOpen created and synced', async () => {
      const created = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await created.act({ type: 'set', data: { value: 'first', timestamp: 1 } })
      await created.updateAndSync()

      const opened = await Collection.open<TestAction>(transactor, collectionId, initOptions)
      expect(opened).to.exist
      expect(opened!.id).to.equal(collectionId)

      const actions: Action<TestAction>[] = []
      for await (const a of opened!.selectLog()) {
        actions.push(a)
      }
      expect(actions.map(a => a.data.value)).to.deep.equal(['first'])
    })

    it('should give open and createOrOpen identical contents for an existing collection', async () => {
      const created = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await created.act({ type: 'set', data: { value: 'a', timestamp: 1 } })
      await created.act({ type: 'set', data: { value: 'b', timestamp: 2 } })
      await created.updateAndSync()

      const viaOpen = (await Collection.open<TestAction>(transactor, collectionId, initOptions))!
      const viaCreateOrOpen = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

      const readLog = async (c: Collection<TestAction>) => {
        const out: string[] = []
        for await (const a of c.selectLog()) {
          out.push(a.data.value)
        }
        return out
      }
      expect(await readLog(viaOpen)).to.deep.equal(['a', 'b'])
      expect(await readLog(viaOpen)).to.deep.equal(await readLog(viaCreateOrOpen))
    })

    it('should let a collection opened read-only accept and sync writes', async () => {
      // `open` is about resolution semantics, not read-only-ness: the returned collection is a
      // fully live Collection over the existing header.
      const created = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await created.updateAndSync()

      const opened = (await Collection.open<TestAction>(transactor, collectionId, initOptions))!
      await opened.act({ type: 'set', data: { value: 'from-open', timestamp: 1 } })
      await opened.updateAndSync()

      const reader = (await Collection.open<TestAction>(transactor, collectionId, initOptions))!
      const actions: Action<TestAction>[] = []
      for await (const a of reader.selectLog()) {
        actions.push(a)
      }
      expect(actions.map(a => a.data.value)).to.deep.equal(['from-open'])
    })

    it('should pick up another instance\'s committed actions on update()', async () => {
      const writer = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await writer.act({ type: 'set', data: { value: 'one', timestamp: 1 } })
      await writer.updateAndSync()

      // `open` must leave the source's action context where an incremental refresh can
      // resume from it — not just where a full re-read happens to work.
      const opened = (await Collection.open<TestAction>(transactor, collectionId, initOptions))!

      await writer.act({ type: 'set', data: { value: 'two', timestamp: 2 } })
      await writer.updateAndSync()

      await opened.update()
      const values: string[] = []
      for await (const a of opened.selectLog()) {
        values.push(a.data.value)
      }
      expect(values).to.deep.equal(['one', 'two'])
    })

    /**
     * Serves the header block on the first read and hides it from every read afterwards.
     * `open` probes the header directly, then re-reads it through the tracker/cache to open
     * the log — so this reproduces storage that goes unavailable between those two reads.
     */
    class VanishingHeaderTransactor implements ITransactor {
      private headerReads = 0
      constructor(private readonly inner: TestTransactor, private readonly headerId: string) {}

      async get(blockGets: BlockGets): Promise<GetBlockResults> {
        const results = await this.inner.get(blockGets)
        if (blockGets.blockIds.includes(this.headerId) && this.headerReads++ > 0) {
          delete results[this.headerId]
        }
        return results
      }
      getStatus(a: ActionBlocks[]): Promise<BlockActionStatus[]> { return this.inner.getStatus(a) }
      pend(r: PendRequest): Promise<PendResult> { return this.inner.pend(r) }
      commit(r: CommitRequest): Promise<CommitResult> { return this.inner.commit(r) }
      cancel(a: ActionBlocks): Promise<void> { return this.inner.cancel(a) }
    }

    it('should throw, not read empty, when a probed header\'s log will not open', async () => {
      const created = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await created.act({ type: 'set', data: { value: 'committed', timestamp: 1 } })
      await created.updateAndSync()

      const vanishing = new VanishingHeaderTransactor(transactor, collectionId)
      await expect(Collection.open<TestAction>(vanishing, collectionId, initOptions))
        .to.be.rejectedWith(`Log not found for collection ${collectionId}`)
    })
  })
})
