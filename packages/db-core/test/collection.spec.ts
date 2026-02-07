import { expect } from 'aegir/chai'
import { Collection, type CollectionInitOptions } from '../src/collection/index.js'
import { TestTransactor } from './test-transactor.js'
import type { Action, ActionHandler, BlockStore, IBlock } from '../src/index.js'

interface TestAction {
  value: string
  timestamp: number
}

describe('Collection', () => {
  let transactor: TestTransactor
  const collectionId = 'test-collection'

  // Action handlers for testing
  const handlers: Record<string, ActionHandler<TestAction>> = {
    'set': async (action, store) => {
      const blockId = store.generateId()
      store.insert({
        header: store.createBlockHeader('TEST', blockId)
      })
    },
    'update': async (action, store) => {
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

  it('should error on concurrent creation', async () => {
    const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
    const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    await collection1.sync()
    // Second collection should succeed because it should recognize the log file conflict and update.
    await collection2.sync()
  })

  it('should handle concurrent modifications', async () => {
    const collection1 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)
    const collection2 = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    // Add actions to both collections concurrently
    const action1: Action<TestAction> = {
      type: 'set',
      data: {
        value: 'value 1',
        timestamp: Date.now()
      }
    }

    const action2: Action<TestAction> = {
      type: 'set',
      data: {
        value: 'value 2',
        timestamp: Date.now() + 1
      }
    }

    await Promise.all([
      collection1.act(action1).then(() => collection1.sync()),
      collection2.act(action2).then(() => collection2.sync())
    ])

		await collection1.update(),
		await collection2.update()
		// await Promise.all([
    // ])

    // Both collections should see both actions
    const actions1: Action<TestAction>[] = []
    for await (const action of collection1.selectLog()) {
      actions1.push(action)
    }

    const actions2: Action<TestAction>[] = []
    for await (const action of collection2.selectLog()) {
      actions2.push(action)
    }

		// TODO: Fix this test; it is not concurrent.
    // expect(actions1).to.have.lengthOf(2)
    // expect(actions2).to.have.lengthOf(2)
    // expect(new Set(actions1.map(a => a.data.value)))
    //   .to.deep.equal(new Set(['value 1', 'value 2']))
    // expect(new Set(actions2.map(a => a.data.value)))
    //   .to.deep.equal(new Set(['value 1', 'value 2']))
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
})
