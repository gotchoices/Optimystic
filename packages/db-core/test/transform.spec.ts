import { expect } from 'aegir/chai'
import type { BlockId, BlockOperation, IBlock, BlockType, BlockSource, Transforms } from '../src/index.js'
import { Tracker } from '../src/transform/tracker.js'
import { applyOperation, withOperation, blockIdsForTransforms, emptyTransforms, mergeTransforms, concatTransforms, transformForBlockId, applyTransformToStore, concatTransform } from '../src/index.js'
import { TestBlockStore } from './test-block-store.js'

interface TestBlock extends IBlock {
  data: string
  items: string[]
}

describe('Transform functionality', () => {
  let mockSource: any
  let testBlock: TestBlock

  beforeEach(() => {
    mockSource = {
      tryGet: async (id: BlockId) => testBlock,
      generateId: () => 'test-id' as BlockId,
      createBlockHeader: (type: BlockType) => ({ id: 'test-id', type })
    }

    testBlock = {
      header: {
        id: 'test-id' as BlockId,
        type: 'test' as BlockType
      },
      data: 'initial',
      items: ['item1', 'item2']
    } as TestBlock
  })

  describe('Tracker', () => {
    it('should track inserts correctly', async () => {
      const tracker = new Tracker(mockSource)
      const newBlock = { ...testBlock, header: { ...testBlock.header, id: 'new-id' as BlockId } }

      tracker.insert(newBlock)
      expect(tracker.transforms.inserts!['new-id']).to.deep.equal(newBlock)
      expect(tracker.transforms.deletes?.includes('new-id') ?? false).to.be.false
    })

    it('should track updates correctly', async () => {
      const tracker = new Tracker(mockSource)
      const operation: BlockOperation = ['data', 0, 0, 'updated']

      tracker.update('test-id' as BlockId, operation)
      expect(tracker.transforms.updates!['test-id']).to.deep.equal([operation])
    })

    it('should track deletes correctly', async () => {
      const tracker = new Tracker(mockSource)

      tracker.delete('test-id' as BlockId)
      expect(tracker.transforms.deletes!.includes('test-id')).to.be.true
      expect(tracker.transforms.inserts?.['test-id']).to.be.undefined
      expect(tracker.transforms.updates?.['test-id']).to.be.undefined
    })

    it('should reset transform correctly', async () => {
      const tracker = new Tracker(mockSource)
      tracker.insert(testBlock)

      const oldTransforms = tracker.reset()
      expect(oldTransforms.inserts!['test-id']).to.deep.equal(testBlock)
      expect(tracker.transforms).to.deep.equal(emptyTransforms())
    })

    it('should not corrupt deletes array when inserting block not in deletes', async () => {
      const tracker = new Tracker(mockSource)
      // Pre-populate deletes with some entries
      tracker.delete('existing-delete-1' as BlockId)
      tracker.delete('existing-delete-2' as BlockId)
      expect(tracker.transforms.deletes).to.have.lengthOf(2)

      // Insert a new block that was never deleted
      const newBlock = { ...testBlock, header: { ...testBlock.header, id: 'new-id' as BlockId } }
      tracker.insert(newBlock)

      // Deletes array should remain unchanged (no corruption from splice(-1, 1))
      expect(tracker.transforms.deletes).to.have.lengthOf(2)
      expect(tracker.transforms.deletes).to.include('existing-delete-1')
      expect(tracker.transforms.deletes).to.include('existing-delete-2')
    })

    it('should remove block from deletes when re-inserting previously deleted block', async () => {
      const tracker = new Tracker(mockSource)
      const blockId = 'reinserted-block' as BlockId
      const block = { ...testBlock, header: { ...testBlock.header, id: blockId } }

      // Delete the block first
      tracker.delete(blockId)
      expect(tracker.transforms.deletes).to.include(blockId)

      // Re-insert the block
      tracker.insert(block)
      expect(tracker.transforms.deletes).to.not.include(blockId)
      expect(tracker.transforms.inserts![blockId]).to.deep.equal(block)
    })
  })

  describe('Transform Helpers', () => {
    it('should apply attribute operations correctly', () => {
      const block = { ...testBlock }
      const operation: BlockOperation = ['data', 0, 0, 'updated']

      applyOperation(block, operation)
      expect(block.data).to.equal('updated')
    })

		it('should apply array operations correctly', () => {
			const block = { ...testBlock }
			const operation: BlockOperation = ['items', 0, 1, ['updated']]

			applyOperation(block, operation)
			expect(block.items).to.deep.equal(['updated', 'item2'])
		})

    it('should create new block with operation applied', () => {
      const operation: BlockOperation = ['data', 0, 0, 'updated']
      const newBlock = withOperation(testBlock, operation) as TestBlock

      expect(newBlock.data).to.equal('updated')
      expect(testBlock.data).to.equal('initial') // Original unchanged
    })

    it('should get block ids for transform', () => {
      const transform: Transforms = {
        inserts: { 'id1': testBlock },
        updates: { 'id2': [] },
        deletes: ['id3']
      }

      const ids = blockIdsForTransforms(transform)
      expect(ids).to.have.members(['id1', 'id2', 'id3'])
    })

    it('should merge transforms correctly', () => {
      const transform1: Transforms = {
        inserts: { 'id1': testBlock },
        updates: {},
        deletes: []
      }

      const transform2: Transforms = {
        inserts: { 'id2': testBlock },
        updates: {},
        deletes: ['id3']
      }

      const merged = mergeTransforms(transform1, transform2)
      expect(merged.inserts).to.have.keys(['id1', 'id2'])
      expect(merged.deletes!.includes('id3')).to.be.true
    })

    it('should concatenate multiple transforms', () => {
      const transforms: Transforms[] = [
        {
          inserts: { 'id1': testBlock },
          updates: {},
          deletes: []
        },
        {
          inserts: { 'id2': testBlock },
          updates: {},
          deletes: ['id3']
        }
      ]

      const concatenated = concatTransforms(...transforms)
      expect(concatenated.inserts).to.have.keys(['id1', 'id2'])
      expect(concatenated.deletes!.includes('id3')).to.be.true
    })

    it('should create transform for specific block id', () => {
      const transform: Transforms = {
        inserts: { 'id1': testBlock, 'id2': testBlock },
        updates: { 'id1': [], 'id3': [] },
        deletes: ['id1', 'id4']
      }

      const blockTransform = transformForBlockId(transform, 'id1' as BlockId)
      expect(blockTransform.insert).to.exist
			expect(blockTransform.insert).to.deep.equal(testBlock)
      expect(blockTransform.updates).to.exist
      expect(blockTransform.delete).to.be.true
    })
  })

  describe('Block ID Collision and Overlap Tests (TEST-1.1.1)', () => {
    const sharedId = 'shared-block' as BlockId

    it('should silently drop updates from first transform when mergeTransforms has overlapping block IDs (BUG: data loss)', () => {
      const op1: BlockOperation = ['data', 0, 0, 'from-a']
      const op2: BlockOperation = ['items', 0, 1, ['replaced']]
      const op3: BlockOperation = ['data', 0, 0, 'from-b']

      const a: Transforms = { inserts: {}, updates: { [sharedId]: [op1, op2] }, deletes: [] }
      const b: Transforms = { inserts: {}, updates: { [sharedId]: [op3] }, deletes: [] }

      const merged = mergeTransforms(a, b)

      // BUG: a's two operations are silently dropped - only b's single operation survives
      expect(merged.updates![sharedId]).to.deep.equal([op3])
      expect(merged.updates![sharedId]).to.not.deep.equal([op1, op2, op3])
    })

    it('should silently drop insert from first transform when mergeTransforms has overlapping block IDs (BUG: data loss)', () => {
      const blockA: TestBlock = { header: { id: sharedId, type: 'test', collectionId: 'c' }, data: 'version-a', items: [] }
      const blockB: TestBlock = { header: { id: sharedId, type: 'test', collectionId: 'c' }, data: 'version-b', items: [] }

      const a: Transforms = { inserts: { [sharedId]: blockA }, updates: {}, deletes: [] }
      const b: Transforms = { inserts: { [sharedId]: blockB }, updates: {}, deletes: [] }

      const merged = mergeTransforms(a, b)

      // BUG: a's insert is silently overwritten by b's insert
      expect((merged.inserts![sharedId] as TestBlock).data).to.equal('version-b')
    })

    it('should accumulate duplicate block IDs in deletes array from mergeTransforms', () => {
      const a: Transforms = { inserts: {}, updates: {}, deletes: [sharedId] }
      const b: Transforms = { inserts: {}, updates: {}, deletes: [sharedId] }

      const merged = mergeTransforms(a, b)

      // Deletes array has the same ID twice - not deduplicated
      expect(merged.deletes!.filter(id => id === sharedId)).to.have.lengthOf(2)
    })

    it('should ignore Tracker insert when source already has block with same ID (BUG: silent shadow)', async () => {
      const sourceBlock: TestBlock = {
        header: { id: sharedId, type: 'test', collectionId: 'c' },
        data: 'from-source', items: ['original']
      }
      const insertedBlock: TestBlock = {
        header: { id: sharedId, type: 'test', collectionId: 'c' },
        data: 'from-insert', items: ['replaced']
      }

      const source: BlockSource<TestBlock> = {
        tryGet: async (id: BlockId) => id === sharedId ? structuredClone(sourceBlock) : undefined,
        generateId: () => 'gen' as BlockId,
        createBlockHeader: (type: BlockType) => ({ id: 'gen' as BlockId, type, collectionId: 'c' as BlockId })
      }

      const tracker = new Tracker(source)
      tracker.insert(insertedBlock)

      // The insert IS stored in transforms
      expect(tracker.transforms.inserts![sharedId]).to.exist

      // BUG: tryGet returns the SOURCE block, not the inserted block
      const result = await tracker.tryGet(sharedId) as TestBlock
      expect(result.data).to.equal('from-source')
      expect(result.data).to.not.equal('from-insert')
    })

    it('should leave block in deletes after double-delete then re-insert (BUG: phantom delete)', async () => {
      const source: BlockSource<TestBlock> = {
        tryGet: async () => undefined,
        generateId: () => 'gen' as BlockId,
        createBlockHeader: (type: BlockType) => ({ id: 'gen' as BlockId, type, collectionId: 'c' as BlockId })
      }

      const tracker = new Tracker(source)

      // Delete the same block twice
      tracker.delete(sharedId)
      tracker.delete(sharedId)
      expect(tracker.transforms.deletes!.filter(id => id === sharedId)).to.have.lengthOf(2)

      // Re-insert - only removes one occurrence from deletes
      const block: TestBlock = {
        header: { id: sharedId, type: 'test', collectionId: 'c' },
        data: 'reinserted', items: []
      }
      tracker.insert(block)

      // BUG: One delete remains even though we re-inserted
      expect(tracker.transforms.deletes!.filter(id => id === sharedId)).to.have.lengthOf(1)
      expect(tracker.transforms.inserts![sharedId]).to.exist

      // Block is both in inserts AND deletes - contradictory state
      const hasInsert = Object.hasOwn(tracker.transforms.inserts!, sharedId)
      const hasDelete = tracker.transforms.deletes!.includes(sharedId)
      expect(hasInsert && hasDelete).to.be.true
    })

    it('should silently overwrite existing block when applyTransformToStore inserts duplicate ID', async () => {
      const store = new TestBlockStore()
      const header = store.createBlockHeader('TL', sharedId)

      // Insert original block
      const original = { header, entries: ['original'] }
      store.insert(original as any)
      const before = await store.tryGet(sharedId)
      expect((before as any).entries).to.deep.equal(['original'])

      // Apply transform that inserts a block with the same ID
      const duplicate = { header, entries: ['overwritten'] }
      const transform: Transforms = { inserts: { [sharedId]: duplicate }, updates: {}, deletes: [] }
      applyTransformToStore(transform, store)

      // BUG: Original is silently overwritten with no warning
      const after = await store.tryGet(sharedId)
      expect((after as any).entries).to.deep.equal(['overwritten'])
    })

    it('should silently drop operations when concatTransform overlaps existing updates (BUG: data loss)', () => {
      const existingOps: BlockOperation[] = [['data', 0, 0, 'first'], ['items', 0, 0, ['a']]]
      const base: Transforms = { inserts: {}, updates: { [sharedId]: existingOps }, deletes: [] }

      const newOps: BlockOperation[] = [['data', 0, 0, 'second']]
      const result = concatTransform(base, sharedId, { updates: newOps })

      // BUG: base's operations for sharedId are silently overwritten
      expect(result.updates![sharedId]).to.deep.equal(newOps)
      expect(result.updates![sharedId]).to.not.include(existingOps[0])
      expect(result.updates![sharedId]).to.not.include(existingOps[1])
    })
  })
})
