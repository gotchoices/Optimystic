import { expect } from 'chai'
import { Collection } from '../src/collection/index.js'
import { TestTransactor, DelegatingTransactor } from '../src/testing/test-transactor.js'
import type { Action, ActionHandler, BlockStore, IBlock, CommitRequest, CommitResult } from '../src/index.js'

interface TestAction {
  value: string
  timestamp: number
}

/**
 * Commits durably on the inner {@link TestTransactor}, then reports a stale failure anyway —
 * the exact observable shape of `NetworkTransactor.commit`'s torn action: the collection header
 * and log tail are committed BEFORE the sweep of the remaining blocks, so a later sweep block
 * coming back as a confirmed conflict returns a stale failure over an action whose log entry is
 * already durable.
 *
 * Safe against the inner transactor's bookkeeping because `TransactorSource.transact` cancels
 * the pend on the reported failure and `TestTransactor.cancel` only deletes PENDING records —
 * the real commit already promoted them, so the cancel is a no-op.
 */
class CommitLandsButReportsStale extends DelegatingTransactor {
  /** Remaining number of successful commits to mask as stale failures. */
  private injections: number
  /** Commits that actually landed on the inner transactor (masked or not). */
  landedCommits = 0

  constructor(inner: TestTransactor, injections = 1) {
    super(inner)
    this.injections = injections
  }

  override async commit(request: CommitRequest): Promise<CommitResult> {
    const result = await this.inner.commit(request)
    if (result.success) {
      this.landedCommits++
      if (this.injections-- > 0) {
        return { success: false, conflict: true, reason: 'stale commit: injected torn-action conflict' }
      }
    }
    return result
  }
}

describe('Collection: own committed action on retry', () => {
  const collectionId = 'own-action-collection'

  const handlers: Record<string, ActionHandler<TestAction>> = {
    'set': async (_action, store) => {
      const blockId = store.generateId()
      store.insert({
        header: store.createBlockHeader('TEST', blockId)
      })
    }
  }

  const initOptions = {
    modules: handlers,
    createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({
      header: store.createBlockHeader('TEST', id)
    })
  }

  it('consumes its own durably committed entry instead of replaying it', async () => {
    const inner = new TestTransactor()
    const transactor = new CommitLandsButReportsStale(inner)
    const collection = await Collection.createOrOpen<TestAction>(transactor, collectionId, initOptions)

    const action: Action<TestAction> = {
      type: 'set',
      data: { value: 'torn', timestamp: 1 }
    }
    await collection.act(action)

    // Must RESOLVE, not exhaust: the action IS durable, so the writer is owed a success.
    await collection.sync({ maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 })

    const logged: Action<TestAction>[] = []
    for await (const logAction of collection.selectLog()) {
      logged.push(logAction)
    }

    // Pre-fix the retry replays the pending action, re-pends at the next revision and commits a
    // second copy (the injection is spent), so the log holds the action twice.
    expect(logged).to.have.lengthOf(1)
    expect(logged[0]).to.deep.equal(action)

    // Exactly one commit ever landed on the inner transactor — the masked one.
    expect(transactor.landedCommits).to.equal(1)
    expect(collection.hasUnsyncedChanges()).to.equal(false)

    // A second reader sees the same single entry (the durable log, not this instance's view).
    const reader = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
    const readerLog: Action<TestAction>[] = []
    for await (const logAction of reader.selectLog()) {
      readerLog.push(logAction)
    }
    expect(readerLog).to.have.lengthOf(1)
  })

  it('still replays when the committed entry belongs to someone else', async () => {
    // Guard against the consumption branch firing on a foreign entry: a rival's committed action
    // must NOT be treated as this sync's own work, so the local action still lands.
    const inner = new TestTransactor()
    const rival = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
    await rival.act({ type: 'set', data: { value: 'rival', timestamp: 1 } })
    await rival.updateAndSync()

    const local = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
    await local.act({ type: 'set', data: { value: 'local', timestamp: 2 } })
    await local.sync({ maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 })

    const logged: Action<TestAction>[] = []
    for await (const logAction of local.selectLog()) {
      logged.push(logAction)
    }
    expect(logged.map(a => a.data.value)).to.deep.equal(['rival', 'local'])
  })

  it('update() with no in-flight action is unaffected', async () => {
    // The entry loop must behave exactly as before when no in-flight id is threaded: a plain
    // update() over a log entry this instance did not write keeps its pending action.
    const inner = new TestTransactor()
    const writer = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
    await writer.act({ type: 'set', data: { value: 'committed', timestamp: 1 } })
    await writer.updateAndSync()

    const other = await Collection.createOrOpen<TestAction>(inner, collectionId, initOptions)
    await other.act({ type: 'set', data: { value: 'staged', timestamp: 2 } })
    await other.update()
    expect(other.hasUnsyncedChanges()).to.equal(true)

    await other.sync({ maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 })
    const logged: Action<TestAction>[] = []
    for await (const logAction of other.selectLog()) {
      logged.push(logAction)
    }
    expect(logged.map(a => a.data.value)).to.deep.equal(['committed', 'staged'])
  })
})
