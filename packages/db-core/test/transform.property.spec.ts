import * as fc from 'fast-check'
import { expect } from 'chai'
import { Tracker } from '../src/transform/tracker.js'
import { Atomic } from '../src/transform/atomic.js'
import { CacheSource } from '../src/transform/cache-source.js'
import {
  copyTransforms,
  isTransformsEmpty,
  applyTransformToStore,
  transformForBlockId,
  applyTransform,
  applyOperation,
} from '../src/transform/helpers.js'
import type {
  BlockId,
  BlockSource,
  BlockStore,
  IBlock,
  BlockOperation,
} from '../src/index.js'
import { apply } from '../src/blocks/helpers.js'

interface TestBlock extends IBlock {
  data: string
  items: string[]
}

const BLOCK_IDS = ['b1', 'b2', 'b3', 'b4', 'b5'] as const
const VALUES = ['x', 'y', 'z'] as const

function makeBlock(id: string, data = '', items: string[] = []): TestBlock {
  return {
    header: { id, type: 'T', collectionId: 'c' },
    data,
    items: [...items],
  }
}

function makeMapSource<T extends IBlock>(initial: Iterable<T> = []): BlockSource<T> {
  const map = new Map<string, T>()
  for (const b of initial) map.set(b.header.id, structuredClone(b))
  let counter = 0
  return {
    async tryGet(id) {
      const v = map.get(id)
      return v ? structuredClone(v) : undefined
    },
    generateId() {
      return `gen-${++counter}`
    },
    createBlockHeader(type, newId) {
      return { id: newId ?? `gen-${++counter}`, type, collectionId: 'c' }
    },
  }
}

type LenientStore<T extends IBlock> = BlockStore<T> & {
  snapshot(): Record<string, T>
}

// Lenient in-memory store: silently ignores update/delete of missing blocks.
// Pragmatic choice for property tests since tracker-generated transforms may
// reference ids that never existed (e.g. delete(b1); update(b1, op)).
function makeLenientStore<T extends IBlock>(initial: Iterable<T> = []): LenientStore<T> {
  const map = new Map<string, T>()
  for (const b of initial) map.set(b.header.id, structuredClone(b))
  let counter = 0
  return {
    createBlockHeader(type, newId) {
      return { id: newId ?? `gen-${++counter}`, type, collectionId: 'c' }
    },
    generateId() {
      return `gen-${++counter}`
    },
    async tryGet(id) {
      const v = map.get(id)
      return v ? structuredClone(v) : undefined
    },
    insert(block) {
      map.set(block.header.id, structuredClone(block))
    },
    update(id, op) {
      const v = map.get(id)
      if (v) applyOperation(v, op)
    },
    delete(id) {
      map.delete(id)
    },
    snapshot() {
      const out: Record<string, T> = {}
      for (const [k, v] of map) out[k] = structuredClone(v)
      return out
    },
  }
}

const arbBlockId = fc.constantFrom<BlockId>(...BLOCK_IDS)
const arbValue = fc.constantFrom(...VALUES)

const arbBlock: fc.Arbitrary<TestBlock> = fc.record({
  id: arbBlockId,
  data: arbValue,
  items: fc.array(arbValue, { maxLength: 3 }),
}).map((r) => makeBlock(r.id, r.data, [...r.items]))

const arbAttrOp: fc.Arbitrary<BlockOperation> =
  arbValue.map((v) => ['data', 0, 0, v] as BlockOperation)

const arbArrayOp: fc.Arbitrary<BlockOperation> = fc.tuple(
  fc.nat({ max: 3 }),
  fc.nat({ max: 2 }),
  fc.array(arbValue, { maxLength: 2 }),
).map(([idx, del, ins]) => ['items', idx, del, [...ins]] as BlockOperation)

const arbOp: fc.Arbitrary<BlockOperation> = fc.oneof(arbAttrOp, arbArrayOp)

type Action =
  | { kind: 'insert'; block: TestBlock }
  | { kind: 'update'; id: BlockId; op: BlockOperation }
  | { kind: 'delete'; id: BlockId }
  | { kind: 'applyIfPresent'; id: BlockId; op: BlockOperation }

const arbAction: fc.Arbitrary<Action> = fc.oneof(
  arbBlock.map((block): Action => ({ kind: 'insert', block })),
  fc.tuple(arbBlockId, arbOp).map(([id, op]): Action => ({ kind: 'update', id, op })),
  arbBlockId.map((id): Action => ({ kind: 'delete', id })),
  fc.tuple(arbBlockId, arbOp).map(([id, op]): Action => ({ kind: 'applyIfPresent', id, op })),
)

const arbActionSequence = fc.array(arbAction, { maxLength: 12 })

const arbInitialSubset: fc.Arbitrary<TestBlock[]> = fc
  .subarray([...BLOCK_IDS])
  .map((ids) => ids.map((id) => makeBlock(id, 'src', ['seed'])))

async function runActions(
  tracker: Tracker<TestBlock>,
  actions: Action[],
): Promise<void> {
  for (const a of actions) {
    if (a.kind === 'insert') tracker.insert(a.block)
    else if (a.kind === 'update') tracker.update(a.id, a.op)
    else if (a.kind === 'delete') tracker.delete(a.id)
    else {
      const block = await tracker.tryGet(a.id)
      if (block) apply(tracker, block, a.op)
    }
  }
}

async function replay(
  actions: Action[],
  source: BlockSource<TestBlock>,
): Promise<Tracker<TestBlock>> {
  const tracker = new Tracker<TestBlock>(source)
  await runActions(tracker, actions)
  return tracker
}

describe('Transform property-based tests', () => {
  describe('helpers.ts round-trip invariants', () => {
    it('isTransformsEmpty is preserved under copyTransforms', async () => {
      await fc.assert(
        fc.asyncProperty(arbActionSequence, async (actions) => {
          const src = makeMapSource<TestBlock>()
          const t = await replay(actions, src)
          const snap = copyTransforms(t.transforms)
          expect(isTransformsEmpty(snap)).to.equal(isTransformsEmpty(t.transforms))
        }),
        { numRuns: 100 },
      )
    })

    it('copyTransforms yields a deep-equal, independent clone', async () => {
      await fc.assert(
        fc.asyncProperty(arbActionSequence, async (actions) => {
          const src = makeMapSource<TestBlock>()
          const t = await replay(actions, src)
          const original = t.transforms
          const snap = copyTransforms(original)
          expect(snap).to.deep.equal(original)

          // Compare original against a second independent snapshot before mutation
          const baseline = copyTransforms(original)

          // Mutate every reachable corner of the copy
          if (snap.deletes) snap.deletes.push('phantom-delete')
          if (snap.updates) {
            for (const key of Object.keys(snap.updates)) {
              snap.updates[key]!.push(['data', 0, 0, '__mutated__'])
            }
          }
          if (snap.inserts) {
            for (const key of Object.keys(snap.inserts)) {
              const block = snap.inserts[key] as TestBlock
              block.data = '__mutated__'
              block.items.push('__mutated__')
            }
          }

          // Original must still deep-equal the pre-mutation baseline
          expect(original).to.deep.equal(baseline)
        }),
        { numRuns: 100 },
      )
    })

    it('applyTransformToStore yields equal state when sourced from original vs copy', async () => {
      await fc.assert(
        fc.asyncProperty(arbActionSequence, async (actions) => {
          const src = makeMapSource<TestBlock>()
          const t = await replay(actions, src)
          const s1 = makeLenientStore<TestBlock>()
          const s2 = makeLenientStore<TestBlock>()
          applyTransformToStore(t.transforms, s1)
          applyTransformToStore(copyTransforms(t.transforms), s2)
          expect(s1.snapshot()).to.deep.equal(s2.snapshot())
        }),
        { numRuns: 50 },
      )
    })
  })

  describe('tracker.ts merge invariants', () => {
    it('replay is deterministic: identical action sequences produce deep-equal transforms', async () => {
      await fc.assert(
        fc.asyncProperty(arbInitialSubset, arbActionSequence, async (initial, actions) => {
          const src = makeMapSource<TestBlock>(initial)
          const a = await replay(actions, src)
          const b = await replay(actions, src)
          expect(a.transforms).to.deep.equal(b.transforms)
        }),
        { numRuns: 100 },
      )
    })

    it('snapshot + fresh Tracker observes the same tryGet for every id', async () => {
      await fc.assert(
        fc.asyncProperty(arbInitialSubset, arbActionSequence, async (initial, actions) => {
          const src = makeMapSource<TestBlock>(initial)
          const original = await replay(actions, src)
          const snap = copyTransforms(original.transforms)
          const fresh = new Tracker<TestBlock>(src, snap)
          for (const id of BLOCK_IDS) {
            const originalValue = await original.tryGet(id)
            const freshValue = await fresh.tryGet(id)
            expect(freshValue).to.deep.equal(originalValue)
          }
        }),
        { numRuns: 50 },
      )
    })

    it('insert(B) followed by any updates folds into inserts in place (no updates entry)', () => {
      const arbInsertThenOps = fc.tuple(arbBlock, fc.array(arbOp, { maxLength: 6 }))
      fc.assert(
        fc.property(arbInsertThenOps, ([block, ops]) => {
          const src = makeMapSource<TestBlock>()
          const t = new Tracker<TestBlock>(src)
          t.insert(block)
          for (const op of ops) t.update(block.header.id, op)

          expect(t.transforms.updates?.[block.header.id]).to.equal(undefined)
          expect(t.transforms.inserts?.[block.header.id]).to.exist

          const expected = structuredClone(block)
          for (const op of ops) applyOperation(expected, op)
          expect(t.transforms.inserts![block.header.id]).to.deep.equal(expected)
        }),
        { numRuns: 100 },
      )
    })

    it('insert(B) followed by applyIfPresent ops folds into the inserted block', async () => {
      // Mirrors the ticket-5-chain Collection.syncInternal + Chain.open pattern.
      const arbInsertThenApplies = fc.tuple(arbBlock, fc.array(arbOp, { maxLength: 6 }))
      await fc.assert(
        fc.asyncProperty(arbInsertThenApplies, async ([block, ops]) => {
          const src = makeMapSource<TestBlock>()
          const t = new Tracker<TestBlock>(src)
          t.insert(block)
          for (const op of ops) {
            const fetched = await t.tryGet(block.header.id)
            expect(fetched, 'inserted block must be reachable via tryGet').to.exist
            apply(t, fetched!, op)
          }
          expect(t.transforms.updates?.[block.header.id]).to.equal(undefined)

          const snap = copyTransforms(t.transforms)
          const fresh = new Tracker<TestBlock>(src, snap)
          const finalFromFresh = await fresh.tryGet(block.header.id)
          const finalFromOriginal = await t.tryGet(block.header.id)
          expect(finalFromFresh).to.deep.equal(finalFromOriginal)
        }),
        { numRuns: 50 },
      )
    })
  })

  describe('tracker.ts deletion-after-insert edges', () => {
    it('insert(B); delete(B) — snapshot fresh tracker tryGet is undefined', async () => {
      const src = makeMapSource<TestBlock>()
      const t = new Tracker<TestBlock>(src)
      const block = makeBlock('b1', 'v')
      t.insert(block)
      t.delete('b1')
      const snap = copyTransforms(t.transforms)
      const fresh = new Tracker<TestBlock>(src, snap)
      expect(await fresh.tryGet('b1')).to.equal(undefined)
    })

    it('source-backed: update(B); delete(B) — snapshot fresh tracker tryGet is undefined', async () => {
      const src = makeMapSource<TestBlock>([makeBlock('b1', 'src-data')])
      const t = new Tracker<TestBlock>(src)
      t.update('b1', ['data', 0, 0, 'updated'])
      t.delete('b1')
      const snap = copyTransforms(t.transforms)
      const fresh = new Tracker<TestBlock>(src, snap)
      expect(await fresh.tryGet('b1')).to.equal(undefined)
    })

    it('insert + apply + delete — delete wins', async () => {
      const src = makeMapSource<TestBlock>()
      const t = new Tracker<TestBlock>(src)
      const block = makeBlock('b1', 'init')
      t.insert(block)
      apply(t, block, ['data', 0, 0, 'modified'])
      t.delete('b1')
      expect(await t.tryGet('b1')).to.equal(undefined)
    })
  })

  describe('atomic.ts wrapper invariants', () => {
    it('commit matches applyTransformToStore against an equivalent twin store', async () => {
      await fc.assert(
        fc.asyncProperty(arbActionSequence, async (actions) => {
          const initial = [...BLOCK_IDS].map((id) => makeBlock(id, 'i', ['seed']))
          const storeA = makeLenientStore<TestBlock>(initial)
          const storeB = makeLenientStore<TestBlock>(initial)

          const atomic = new Atomic<TestBlock>(storeA)
          await runActions(atomic, actions)
          atomic.commit()

          const src = makeMapSource<TestBlock>(initial)
          const trk = await replay(actions, src)
          applyTransformToStore(trk.transforms, storeB)

          expect(storeA.snapshot()).to.deep.equal(storeB.snapshot())
        }),
        { numRuns: 30 },
      )
    })

    it('reset (rollback) leaves the underlying store pristine', async () => {
      await fc.assert(
        fc.asyncProperty(arbActionSequence, async (actions) => {
          const initial = [...BLOCK_IDS].map((id) => makeBlock(id, 'i', ['seed']))
          const storeA = makeLenientStore<TestBlock>(initial)
          const storeB = makeLenientStore<TestBlock>(initial)

          const atomic = new Atomic<TestBlock>(storeA)
          await runActions(atomic, actions)
          atomic.reset()

          expect(storeA.snapshot()).to.deep.equal(storeB.snapshot())
          expect(isTransformsEmpty(atomic.transforms)).to.equal(true)
        }),
        { numRuns: 30 },
      )
    })

    it('commit clears atomic transforms', () => {
      const store = makeLenientStore<TestBlock>()
      const atomic = new Atomic<TestBlock>(store)
      atomic.insert(makeBlock('b1', 'x'))
      atomic.update('b2', ['data', 0, 0, 'v'])
      atomic.commit()
      expect(isTransformsEmpty(atomic.transforms)).to.equal(true)
    })
  })

  describe('cache-source.ts', () => {
    it('tryGet after transformCache matches applyTransform for insert/update transforms', async () => {
      // Deletes intentionally excluded: CacheSource.tryGet on a delete falls back to
      // the source after cache eviction, whereas applyTransform returns undefined for
      // a delete. That divergence is by design (the cache is not a source of truth
      // for tombstones) and is outside this property's scope.
      const arbNonDeleteAction: fc.Arbitrary<Action> = fc.oneof(
        arbBlock.map((block): Action => ({ kind: 'insert', block })),
        fc.tuple(arbBlockId, arbOp).map(([id, op]): Action => ({ kind: 'update', id, op })),
      )
      const arbSeq = fc.array(arbNonDeleteAction, { maxLength: 8 })

      await fc.assert(
        fc.asyncProperty(arbSeq, async (actions) => {
          const initial = [...BLOCK_IDS].map((id) => makeBlock(id, 'src', ['seed']))
          const src = makeMapSource<TestBlock>(initial)
          const trk = await replay(actions, src)
          const transforms = trk.transforms

          const cache = new CacheSource<TestBlock>(src)
          // Pre-populate so updates have a cache target
          for (const id of BLOCK_IDS) await cache.tryGet(id)
          cache.transformCache(transforms)

          for (const id of BLOCK_IDS) {
            const fromCache = await cache.tryGet(id)
            const srcBlock = await src.tryGet(id)
            const expected = applyTransform(srcBlock, transformForBlockId(transforms, id))
            expect(fromCache).to.deep.equal(expected)
          }
        }),
        { numRuns: 30 },
      )
    })
  })
})
