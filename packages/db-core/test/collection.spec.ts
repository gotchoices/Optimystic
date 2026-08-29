import { use, expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
use(chaiAsPromised)
import { Collection, SyncRetryExhaustedError, type CollectionInitOptions } from '../src/collection/index.js'
import { TestTransactor, FlakyCommitTransactor } from '../src/testing/test-transactor.js'
import { waitFor } from '../src/testing/async-wait.js'
import type { Action, ActionHandler, BlockStore, IBlock, ITransactor, BlockGets, GetBlockResults, ActionBlocks, BlockActionStatus, PendRequest, PendResult, CommitRequest, CommitResult, StaleFailure } from '../src/index.js'
import { BlockUnavailableError, BlockPossiblyStaleError } from '../src/index.js'
import debug from 'debug'
import { format } from 'node:util'

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

    // Ticket coordinator-serves-stale-data-as-if-confirmed: the tail read that seeds a
    // collection's context is UNPINNED — it is the one read where a lagging node can learn a
    // newer revision exists. A tail served with `unconfirmedAheadRev` (the repo could not
    // confirm it is current and a cohort peer claimed a strictly higher revision) must fail
    // the open loudly; seeding the context from it silently is exactly how a collection view
    // froze at a stale revision in the field, with every later read pinned to that frozen
    // context and nothing ever reporting a problem.
    it('open throws BlockPossiblyStaleError when the LOG TAIL is served as possibly behind a cohort claim', async () => {
      const created = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      const tailId = await syncedTailId(created)

      const doubted: ITransactor = {
        async get(gets: BlockGets): Promise<GetBlockResults> {
          const res = await transactor.get(gets)
          for (const id of gets.blockIds) {
            // Only stamp the UNPINNED read — mirroring the coordinator, which never stamps
            // a read pinned below the claim. The pinned re-reads during the log walk must
            // keep working.
            if (id === tailId && gets.context === undefined && res[id]) {
              const held = res[id]!.state.latest?.rev ?? 0
              res[id] = { ...res[id]!, unconfirmedAheadRev: held + 1 }
            }
          }
          return res
        },
        getStatus: (refs: ActionBlocks[]) => transactor.getStatus(refs),
        pend: (req: PendRequest) => transactor.pend(req),
        cancel: (ref: ActionBlocks) => transactor.cancel(ref),
        commit: (req: CommitRequest) => transactor.commit(req),
      }

      await expect(Collection.open<TestAction>(doubted, collectionId, initOptions)).to.be.rejectedWith(BlockPossiblyStaleError)
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

  // Regression for bug-external-commit-invisible-after-staged-txn: Collection.updateInternal
  // used to replay conflicting pending actions BEFORE advancing its revision cursor, so the
  // replay's block reads landed at the revision it was about to leave rather than the one it
  // was adopting. Because the log entry that would have invalidated those blocks had already
  // been consumed, nothing ever re-cleared them — the stale content stuck permanently.
  describe('external commit visibility after conflict replay', () => {
    const sharedBlockId = 'shared-block'

    const sharedModules: Record<string, ActionHandler<TestAction>> = {
      'setShared': async (action, store) => {
        const existing = await store.tryGet(sharedBlockId)
        if (existing) {
          store.update(sharedBlockId, ['value', 0, 0, action.data.value])
        } else {
          store.insert({
            header: store.createBlockHeader('TEST', sharedBlockId),
            value: action.data.value
          } as IBlock & { value: string })
        }
      },
      // Depends on the CURRENT content of the block (an append), unlike 'setShared' above which
      // always overwrites — this is what lets a test distinguish "computed against stale content"
      // from "computed against the newly adopted revision".
      'appendShared': async (action, store) => {
        const existing = await store.tryGet(sharedBlockId) as ({ value?: string } | undefined)
        store.update(sharedBlockId, ['value', 0, 0, `${existing?.value ?? ''}+${action.data.value}`])
      },
      'update': async () => { /* no-op */ }
    }

    const sharedOptions: CollectionInitOptions<TestAction> = {
      ...initOptions,
      modules: sharedModules
    }

    const readShared = async (collection: Collection<TestAction>): Promise<string | undefined> =>
      (await collection.tracker.tryGet(sharedBlockId) as { value?: string } | undefined)?.value

    it('a rolled-back transaction must see the external commit that conflicted with it, not the pre-commit content', async () => {
      const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, sharedOptions)
      await collection1.act({ type: 'setShared', data: { value: 'v1', timestamp: 1 } })
      await collection1.updateAndSync() // rev1: shared = v1

      const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, sharedOptions)
      // Snapshot BEFORE staging anything, so restoring it later mimics a cancelled transaction.
      const preTransactionSnapshot = collection2.snapshotPending()

      // Stage a local, unsynced pending action touching the same block — this is what forces
      // update() below to replay rather than just advancing quietly. It also reads (and caches)
      // 'shared' = v1 into collection2's read cache, which is the content the bug re-serves.
      await collection2.act({ type: 'setShared', data: { value: 'local-pending', timestamp: 2 } })

      // An external commit lands on the SAME block while collection2's transaction is open.
      await collection1.act({ type: 'setShared', data: { value: 'v2-committed', timestamp: 3 } })
      await collection1.updateAndSync() // rev2: shared = v2-committed

      // Collection2 discovers the external commit; its pending action conflicts on the shared
      // block id, so update() must force Collection.updateInternal's replay branch.
      await collection2.update()

      // Roll back collection2's own pending transaction.
      collection2.restorePending(preTransactionSnapshot)

      // With the local pending action gone, a read of the shared block must show collection1's
      // committed value — not stale pre-commit content the conflict replay re-cached.
      expect(await readShared(collection2)).to.equal('v2-committed')
    })

    it('a losing sync() retry rebuilds its transform against the adopted revision, not the stale one', async () => {
      // Write-path corollary from the ticket: syncInternal's retry loop calls updateInternal()
      // after a stale pend/commit failure and then resubmits at the new revision. Under the old
      // ordering, that resubmission's transform was computed by a replay that read at the STALE
      // revision, even though it gets submitted at the new one.
      const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, sharedOptions)
      await collection1.act({ type: 'setShared', data: { value: 'v1', timestamp: 1 } })
      await collection1.updateAndSync() // rev1: shared = v1

      const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, sharedOptions)
      // Reads (and caches) 'shared' = v1, then stages a pending append on top of it — WITHOUT
      // first calling update(), so collection2 still believes it is at rev1.
      await collection2.act({ type: 'appendShared', data: { value: 'local', timestamp: 2 } })

      // An external commit lands on the same block before collection2 syncs.
      await collection1.act({ type: 'setShared', data: { value: 'v2-committed', timestamp: 3 } })
      await collection1.updateAndSync() // rev2: shared = v2-committed

      // collection2's sync() now pends at rev2 (its stale rev1+1), the transactor rejects it as
      // stale (real conflict — collection1 already committed rev2), and syncInternal's retry path
      // calls updateInternal() (replay) before resubmitting.
      await collection2.sync({ maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 })

      // The resubmitted append must have been computed against the ADOPTED revision's content
      // (v2-committed), not the stale content (v1) the collection held when it first staged the
      // pending action.
      expect(await readShared(collection2)).to.equal('v2-committed+local')
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

  // Ticket a-refresh-that-fails-to-close-a-known-gap-says-nothing: update() reads the
  // authoritative "latest committed under this id" revision off the log tail, then decides how
  // far to advance by a SEPARATE chain walk. A walk that lands short of what the tail claimed
  // means the refresh provably closed nothing — which used to be indistinguishable, from
  // outside the class, from "there was nothing newer to adopt".
  describe('a refresh that lands short of the tail it just read', () => {
    const shortfallTag = 'collection:context-short-of-tail'

    /** Capture what the `db-core:collection` namespace emits while `fn` runs, fully substituted
     *  (`debug` leaves `%s`/`%d` for the downstream sink, so the raw args are not the text). */
    const captureCollectionLog = async (fn: () => Promise<void>): Promise<string[]> => {
      const lines: string[] = []
      const previousNamespaces = debug.disable()
      const previousLog = debug.log
      debug.enable('optimystic:db-core:collection')
      debug.log = (...args: unknown[]): void => { lines.push(format(...args)) }
      try {
        await fn()
      } finally {
        debug.log = previousLog
        debug.disable()
        if (previousNamespaces) debug.enable(previousNamespaces)
      }
      return lines
    }

    /** The tail block id the synced header points at, and the revision its state claims —
     *  exactly the block and field `bootstrapContext` reads. */
    const syncedTail = async (): Promise<{ tailId: string, rev: number }> => {
      const headerEntry = (await transactor.get({ blockIds: [collectionId] }))[collectionId]
      const tailId = (headerEntry?.block as { tailId?: string } | undefined)?.tailId
      expect(tailId, 'a synced header names its log tail block').to.be.a('string')
      const tailEntry = (await transactor.get({ blockIds: [tailId!] }))[tailId!]
      const rev = tailEntry?.state.latest?.rev
      expect(rev, 'a committed tail block carries the latest committed revision').to.be.a('number')
      return { tailId: tailId!, rev: rev! }
    }

    /** Inflates `state.latest.rev` on the UNPINNED read of the tail block — the one read
     *  `bootstrapContext` makes — so the tail claims a revision no chain walk can reach.
     *  Every pinned read (the walk itself) is passed through untouched.
     *
     *  Armed separately from construction on purpose: `Collection.open` bootstraps from the very
     *  same unpinned tail read, so inflating from the start would simply pin the OPENED
     *  collection at the inflated revision (and `advanceContext` would then log
     *  `context-not-lowered` instead). Open clean, arm, then refresh. */
    const inflatedTailTransactor = (inner: TestTransactor, tailId: string, by: number) => {
      let armed = false
      const transactor: ITransactor = {
        async get(gets: BlockGets): Promise<GetBlockResults> {
          const res = await inner.get(gets)
          const entry = res[tailId]
          if (armed && gets.context === undefined && entry?.state.latest) {
            res[tailId] = {
              ...entry,
              state: { ...entry.state, latest: { ...entry.state.latest, rev: entry.state.latest.rev + by } },
            }
          }
          return res
        },
        getStatus: (refs: ActionBlocks[]) => inner.getStatus(refs),
        pend: (req: PendRequest) => inner.pend(req),
        cancel: (ref: ActionBlocks) => inner.cancel(ref),
        commit: (req: CommitRequest) => inner.commit(req),
      }
      return { transactor, arm: () => { armed = true } }
    }

    // The healthy path is the assertion that matters most: a shortfall line on an ordinary
    // refresh would be noise in every log this diagnostic is meant to be read in.
    it('an ordinary refresh of an already-current collection says nothing', async () => {
      const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await collection.act({ type: 'set', data: { value: 'one', timestamp: 1 } })
      await collection.updateAndSync()
      await syncedTail()   // asserts there IS a committed tail, so the check is really exercised

      const lines = await captureCollectionLog(() => collection.update())
      expect(lines.filter(l => l.includes(shortfallTag)), 'a current collection reports no shortfall').to.deep.equal([])
    })

    it('a refresh that actually catches up says nothing', async () => {
      const writer = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await writer.act({ type: 'set', data: { value: 'one', timestamp: 1 } })
      await writer.updateAndSync()

      const reader = await Collection.open<TestAction>(transactor, collectionId, initOptions)
      expect(reader, 'the committed collection reopens').to.not.equal(undefined)

      await writer.act({ type: 'set', data: { value: 'two', timestamp: 2 } })
      await writer.updateAndSync()

      const lines = await captureCollectionLog(() => reader!.update())
      expect(lines.filter(l => l.includes(shortfallTag)), 'a refresh that closed the gap reports no shortfall').to.deep.equal([])
      const values: string[] = []
      for await (const a of reader!.selectLog()) { values.push(a.data.value) }
      expect(values, 'the catch-up refresh really did adopt the newer action').to.deep.equal(['one', 'two'])
    })

    it('a collection with nothing committed under its id says nothing', async () => {
      // No tail, so no claimed revision — a legitimate "nothing committed yet", not a shortfall.
      const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      const lines = await captureCollectionLog(() => collection.update())
      expect(lines.filter(l => l.includes(shortfallTag)), 'an uncommitted collection reports no shortfall').to.deep.equal([])
    })

    it('a refresh whose walk falls short of the tail logs the gap and still returns normally', async () => {
      const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await collection.act({ type: 'set', data: { value: 'one', timestamp: 1 } })
      await collection.updateAndSync()
      const { tailId, rev } = await syncedTail()

      // Open honestly (the collection adopts the real committed revision), then make the tail
      // claim five revisions more than the log holds. The walk cannot reach that number, so the
      // refresh below provably closes nothing.
      const inflated = inflatedTailTransactor(transactor, tailId, 5)
      const lagging = await Collection.open<TestAction>(inflated.transactor, collectionId, initOptions)
      expect(lagging, 'the collection opens against the honest tail').to.not.equal(undefined)
      inflated.arm()

      const lines = await captureCollectionLog(() => lagging!.update())   // must NOT throw
      const shortfall = lines.filter(l => l.includes(shortfallTag))
      expect(shortfall.length, `exactly one shortfall line, got: ${lines.join(' | ')}`).to.equal(1)
      const parsed = /id=(\S+) before=(\S+) after=(\S+) tail=(\d+)/.exec(shortfall[0]!)
      expect(parsed, `the line names id, before, after and tail: ${shortfall[0]}`).to.not.equal(null)
      const [, id, before, after, tail] = parsed!
      expect(id, 'the line names the collection').to.equal(collectionId)
      expect(Number(tail), 'the tail revision reported is the one the tail claimed').to.equal(rev + 5)
      expect(Number(after), 'the collection ended below the revision the tail claimed').to.be.lessThan(rev + 5)
      expect(before, 'the refresh moved the collection nowhere').to.equal(after)
    })

    // The originating field case was a collection that stayed short across ~100 refreshes over
    // 30 seconds. An operator reads the line by seeing it keep coming, so it must be a per-call
    // report and not a once-per-collection latch, and the shortfall must not degrade the
    // collection into something that stops answering reads.
    it('keeps reporting on every later refresh, and the collection still reads', async () => {
      const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await collection.act({ type: 'set', data: { value: 'one', timestamp: 1 } })
      await collection.updateAndSync()
      const { tailId } = await syncedTail()

      const inflated = inflatedTailTransactor(transactor, tailId, 5)
      const lagging = await Collection.open<TestAction>(inflated.transactor, collectionId, initOptions)
      inflated.arm()

      const lines = await captureCollectionLog(async () => {
        await lagging!.update()
        await lagging!.update()
        await lagging!.update()
      })
      expect(lines.filter(l => l.includes(shortfallTag)).length,
        `three refreshes report three times, got: ${lines.join(' | ')}`).to.equal(3)

      const values: string[] = []
      for await (const a of lagging!.selectLog()) { values.push(a.data.value) }
      expect(values, 'a collection that fell short still serves what it does hold').to.deep.equal(['one'])
    })
  })

  // Ticket make-a-refresh-able-to-say-the-two-copies-disagree: revision numbers are counted per
  // collection, so two separately-built copies under one id can each hold the SAME revision under
  // DIFFERENT actions while each stays internally self-consistent — the shortfall line above
  // structurally cannot fire on that (both of its numbers come from one chain). The lineage check
  // in advanceContext compares the action id held at the collection's current revision against
  // the action id the freshly-read log names at that same revision; a mismatch means the local
  // copy and the stored log are provably different lineages.
  describe('a refresh whose log names a different action at the held revision', () => {
    const divergenceTag = 'collection:lineage-divergence'

    /** Capture what the `db-core:collection` namespace emits while `fn` runs, fully substituted
     *  (`debug` leaves `%s`/`%d` for the downstream sink, so the raw args are not the text). */
    const captureCollectionLog = async (fn: () => Promise<void>): Promise<string[]> => {
      const lines: string[] = []
      const previousNamespaces = debug.disable()
      const previousLog = debug.log
      debug.enable('optimystic:db-core:collection')
      debug.log = (...args: unknown[]): void => { lines.push(format(...args)) }
      try {
        await fn()
      } finally {
        debug.log = previousLog
        debug.disable()
        if (previousNamespaces) debug.enable(previousNamespaces)
      }
      return lines
    }

    /** The tail block id the synced header points at, and the action id its state claims produced
     *  the latest committed revision — the collection's lineage marker in storage. */
    const syncedTail = async (): Promise<{ tailId: string, actionId: string }> => {
      const headerEntry = (await transactor.get({ blockIds: [collectionId] }))[collectionId]
      const tailId = (headerEntry?.block as { tailId?: string } | undefined)?.tailId
      expect(tailId, 'a synced header names its log tail block').to.be.a('string')
      const tailEntry = (await transactor.get({ blockIds: [tailId!] }))[tailId!]
      const actionId = tailEntry?.state.latest?.actionId
      expect(actionId, 'a committed tail block carries the action id of the latest revision').to.be.a('string')
      return { tailId: tailId!, actionId: actionId! }
    }

    /** While armed, rewrites every read of the tail block so the whole stored lineage appears to
     *  have been produced by `fakeId`: `state.latest.actionId` (what bootstrapContext adopts) and
     *  every log entry's `action.actionId` (what the chain walk adopts). Opening a collection
     *  through this while armed yields a handle that HOLDS revision N under `fakeId` — exactly
     *  the state of a replica built from a different lineage. Disarming then makes the next
     *  refresh read the honest lineage, so held and read disagree at the same revision. */
    const rewrittenLineageTransactor = (inner: TestTransactor, tailId: string, fakeId: string) => {
      let armed = false
      const rewrite = (entry: GetBlockResults[string]): GetBlockResults[string] => {
        let out = entry
        if (out.state.latest) {
          out = { ...out, state: { ...out.state, latest: { ...out.state.latest, actionId: fakeId } } }
        }
        const block = out.block as (IBlock & { entries?: { action?: { actionId: string } }[] }) | undefined
        if (block?.entries) {
          out = {
            ...out,
            block: {
              ...block,
              entries: block.entries.map(e => e.action ? { ...e, action: { ...e.action, actionId: fakeId } } : e),
            } as IBlock,
          }
        }
        return out
      }
      const transactor: ITransactor = {
        async get(gets: BlockGets): Promise<GetBlockResults> {
          const res = await inner.get(gets)
          const entry = res[tailId]
          if (armed && entry) {
            res[tailId] = rewrite(entry)
          }
          return res
        },
        getStatus: (refs: ActionBlocks[]) => inner.getStatus(refs),
        pend: (req: PendRequest) => inner.pend(req),
        cancel: (ref: ActionBlocks) => inner.cancel(ref),
        commit: (req: CommitRequest) => inner.commit(req),
      }
      return { transactor, arm: () => { armed = true }, disarm: () => { armed = false } }
    }

    /** A committed collection plus a second handle opened while the tail reads were rewritten to
     *  `fakeId` — a handle holding the stored revision under a different lineage marker. */
    const openDivergedHandle = async (fakeId: string) => {
      const writer = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await writer.act({ type: 'set', data: { value: 'one', timestamp: 1 } })
      await writer.updateAndSync()
      const { tailId, actionId } = await syncedTail()

      const rewritten = rewrittenLineageTransactor(transactor, tailId, fakeId)
      rewritten.arm()
      const diverged = await Collection.open<TestAction>(rewritten.transactor, collectionId, initOptions)
      expect(diverged, 'the collection opens against the rewritten lineage').to.not.equal(undefined)
      rewritten.disarm()
      return { diverged: diverged!, storedActionId: actionId }
    }

    // The healthy paths are the assertions that matter most: a divergence line on an ordinary
    // refresh would be noise in every log this diagnostic is meant to be read in.
    it('an ordinary refresh of an already-current collection says nothing', async () => {
      const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await collection.act({ type: 'set', data: { value: 'one', timestamp: 1 } })
      await collection.updateAndSync()

      const lines = await captureCollectionLog(() => collection.update())
      expect(lines.filter(l => l.includes(divergenceTag)), 'a current collection reports no divergence').to.deep.equal([])
    })

    it('a refresh that catches up on a same-lineage commit says nothing', async () => {
      // Exercises the overlap when the log has moved PAST the held revision: the walk's committed
      // list still names the held revision's action, and it is the same action — one lineage.
      const writer = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
      await writer.act({ type: 'set', data: { value: 'one', timestamp: 1 } })
      await writer.updateAndSync()

      const reader = await Collection.open<TestAction>(transactor, collectionId, initOptions)
      expect(reader, 'the committed collection reopens').to.not.equal(undefined)

      await writer.act({ type: 'set', data: { value: 'two', timestamp: 2 } })
      await writer.updateAndSync()

      const lines = await captureCollectionLog(() => reader!.update())
      expect(lines.filter(l => l.includes(divergenceTag)), 'a lagging same-lineage reader reports no divergence').to.deep.equal([])
    })

    it('a refresh that finds a different action at its held revision logs both ids and still returns normally', async () => {
      const fakeId = 'divergent-lineage-action-id'
      const { diverged, storedActionId } = await openDivergedHandle(fakeId)
      expect(storedActionId, 'the rewritten id really differs from the stored one').to.not.equal(fakeId)

      const lines = await captureCollectionLog(() => diverged.update())   // must NOT throw
      const divergence = lines.filter(l => l.includes(divergenceTag))
      expect(divergence.length, `exactly one divergence line, got: ${lines.join(' | ')}`).to.equal(1)
      const parsed = /id=(\S+) rev=(\d+) held=(\S+) read=(\S+)/.exec(divergence[0]!)
      expect(parsed, `the line names id, rev, held and read: ${divergence[0]}`).to.not.equal(null)
      const [, id, rev, held, read] = parsed!
      expect(id, 'the line names the collection').to.equal(collectionId)
      expect(Number(rev), 'the disagreement is at the held revision').to.equal(1)
      expect(held, 'held is the lineage marker this handle carried in').to.equal(fakeId)
      expect(read, 'read is the action the stored log actually names').to.equal(storedActionId)
      // The shortfall line must stay silent here: a forked copy is internally self-consistent,
      // which is exactly why that diagnostic could never catch this case.
      expect(lines.filter(l => l.includes('collection:context-short-of-tail')), 'no shortfall on a fork').to.deep.equal([])

      const values: string[] = []
      for await (const a of diverged.selectLog()) { values.push(a.data.value) }
      expect(values, 'a diverged collection still serves reads after the report').to.deep.equal(['one'])
    })

    it('reports once per discovery, not once per refresh — adoption heals the held context', async () => {
      // advanceContext adopts the log's context after reporting (equal revisions adopt; see its
      // doc comment), so the held lineage marker now matches the log and a second refresh
      // compares log-to-log. The line marks the refresh that DISCOVERED the divergence. This is
      // deliberately weaker than the shortfall line's per-call reporting: the context disagreement
      // genuinely is resolved by adoption, even though block content materialized under the old
      // lineage may still be cached.
      const { diverged } = await openDivergedHandle('divergent-lineage-action-id')

      const lines = await captureCollectionLog(async () => {
        await diverged.update()
        await diverged.update()
        await diverged.update()
      })
      expect(lines.filter(l => l.includes(divergenceTag)).length,
        `only the discovering refresh reports, got: ${lines.join(' | ')}`).to.equal(1)
    })
  })
})
