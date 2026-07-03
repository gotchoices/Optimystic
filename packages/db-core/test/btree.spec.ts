import { use, expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
use(chaiAsPromised)
import { BTree } from '../src/btree/index.js'
import type { BranchNode } from '../src/btree/nodes.js'
import { TreeBranchBlockType } from '../src/btree/nodes.js'
import { KeyBound, KeyRange } from '../src/btree/key-range.js'
import { createActor } from '../src/utility/actor.js'
import { TestBlockStore } from './test-block-store.js'

describe('BTree', () => {
  let store: TestBlockStore
  let btree: BTree<number, number>

  beforeEach(() => {
    store = new TestBlockStore()
    btree = BTree.create(store, (s, rootId) => {
			let storedRootId = rootId;
      return {
        get: async () => (await s.tryGet(storedRootId))!,
        set: async (node) => { storedRootId = node.header.id },
        getId: async () => storedRootId
      }
    })
  })

  it('should insert and retrieve values', async () => {
    // Insert some values
    await btree.insert(5)
    await btree.insert(3)
    await btree.insert(7)

    // Verify we can retrieve them
    expect(await btree.get(5)).to.equal(5)
    expect(await btree.get(3)).to.equal(3)
    expect(await btree.get(7)).to.equal(7)
    expect(await btree.get(4)).to.be.undefined
  })

  it('should handle sequential inserts', async () => {
    const count = 100
    for (let i = 0; i < count; i++) {
      await btree.insert(i)
    }

    // Verify all values are present
    for (let i = 0; i < count; i++) {
      expect(await btree.get(i)).to.equal(i)
    }
  })

  it('should support iteration', async () => {
    const values = [5, 3, 7, 1, 9]
    for (const value of values) {
      await btree.insert(value)
    }

    const path = await btree.first()
    const results: number[] = []

    while (path.on) {
      const value = btree.at(path)
      if (value !== undefined) {
        results.push(value)
      }
      await btree.moveNext(path)
    }

    expect(results).to.deep.equal([1, 3, 5, 7, 9])
  })

  it('should delete values', async () => {
    await btree.insert(5)
    await btree.insert(3)
    await btree.insert(7)

    const path = await btree.find(3)
    expect(path.on).to.be.true

    await btree.deleteAt(path)
    expect(path.on).to.be.false

    expect(await btree.get(3)).to.be.undefined
    expect(await btree.get(5)).to.equal(5)
    expect(await btree.get(7)).to.equal(7)
  })

  it('should handle empty tree operations', async () => {
    expect(await btree.get(1)).to.be.undefined
    const firstPath = await btree.first()
    expect(firstPath.on).to.be.false
    const lastPath = await btree.last()
    expect(lastPath.on).to.be.false
    const findPath = await btree.find(5)
    expect(findPath.on).to.be.false
  })

  it('should maintain sorted order after multiple insertions', async () => {
    await btree.insert(3)
    await btree.insert(1)
    await btree.insert(2)

    const values: number[] = []
    const path = await btree.first()
    while (path.on) {
      const value = btree.at(path)
      if (value !== undefined) {
        values.push(value)
      }
      await btree.moveNext(path)
    }

    expect(values).to.deep.equal([1, 2, 3])
  })

  it('should handle single-item ranges', async () => {
    await btree.insert(2)

    const path = await btree.find(2)
    expect(path.on).to.be.true
    expect(btree.at(path)).to.equal(2)

    await btree.moveNext(path)
    expect(path.on).to.be.false

    await btree.movePrior(path)
    expect(path.on).to.be.true
    expect(btree.at(path)).to.equal(2)
  })

  it('should handle updates correctly', async () => {
    await btree.insert(1)
    await btree.insert(2)
    await btree.insert(3)

    const path = await btree.find(2)
    expect(path.on).to.be.true

    // Update existing value
    await btree.updateAt(path, 4)
    expect(await btree.get(2)).to.be.undefined
    expect(await btree.get(4)).to.equal(4)

    // Try updating non-existent value
    const notFoundPath = await btree.find(2)
    expect(notFoundPath.on).to.be.false
  })

  it('should handle large sequential deletes', async () => {
    // Insert 100 items
    for (let i = 0; i < 100; i++) {
      await btree.insert(i)
      // Verify each insert worked correctly
      expect(await btree.get(i)).to.equal(i, `Failed to verify insert of ${i}`)
    }

    // Delete from end with better error tracking
    for (let i = 99; i >= 50; i--) {
      const path = await btree.find(i)
      expect(path.on).to.be.true
      try {
        await btree.deleteAt(path)
      } catch (e) {
        console.error(`Failed to delete ${i}:`, e)
        // Log the block store state
				store.logBlockIds();
        throw e
      }

      // Verify deletion worked
      expect(await btree.get(i)).to.be.undefined

      // Verify adjacent values still exist
      if (i > 0) {
        expect(await btree.get(i - 1)).to.equal(i - 1,
          `Adjacent value ${i - 1} missing after deleting ${i}`)
      }
    }

    // Verify remaining items with more granular checks
    for (let i = 0; i < 50; i++) {
      try {
        expect(await btree.get(i)).to.equal(i, `Missing value ${i}`)
      } catch (e) {
        console.error(`Failed to verify value ${i}:`, e)
        throw e
      }
    }
  })

  it('should handle interleaved inserts and deletes', async () => {
    // Insert initial items
    for (let i = 0; i < 10; i++) {
      await btree.insert(i * 2) // Insert evens: 0,2,4,6,8...
    }

    // Interleave inserts and deletes
    for (let i = 0; i < 5; i++) {
      // Delete even
      const delPath = await btree.find(i * 2)
      await btree.deleteAt(delPath)

      // Insert odd
      await btree.insert(i * 2 + 1)
    }

    // Verify final state
    for (let i = 0; i < 5; i++) {
      expect(await btree.get(i * 2)).to.be.undefined // Evens deleted
      expect(await btree.get(i * 2 + 1)).to.equal(i * 2 + 1) // Odds inserted
    }
  })

  it('should handle boundary conditions in node splits', async () => {
    // Insert ascending to force splits
    const count = 100
    for (let i = 0; i < count; i++) {
      await btree.insert(i)
    }

    // Insert between existing values to test split edge cases
    for (let i = 0; i < count - 1; i++) {
      await btree.insert(i + 0.5)
    }

    // Verify all values present
    for (let i = 0; i < count - 1; i++) {
      expect(await btree.get(i)).to.equal(i)
      expect(await btree.get(i + 0.5)).to.equal(i + 0.5)
    }
  })

  it('should maintain consistency during concurrent operations', async () => {
		// The following would fail without an actor proxy because the tree is not thread-safe by design.
		const safeBtree = createActor(btree);
    // Insert initial data
    for (let i = 0; i < 10; i++) {
      await safeBtree.insert(i)
    }

    // Perform concurrent operations
    await Promise.all([
      safeBtree.insert(20),
      safeBtree.insert(30),
      safeBtree.insert(40)
    ])

    // Verify tree is still consistent
    expect(await safeBtree.get(20)).to.equal(20)
    expect(await safeBtree.get(30)).to.equal(30)
    expect(await safeBtree.get(40)).to.equal(40)
  })

  // TEST-3.1.1: B-tree stress tests for large datasets
  describe('stress tests (TEST-3.1.1)', () => {
    it('should handle 500 random-order inserts', async () => {
      const values = Array.from({ length: 500 }, (_, i) => i)
      // Fisher-Yates shuffle
      for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [values[i], values[j]] = [values[j]!, values[i]!]
      }

      for (const v of values) {
        await btree.insert(v!)
      }

      for (let i = 0; i < 500; i++) {
        expect(await btree.get(i)).to.equal(i)
      }

      // Verify sorted iteration
      const collected: number[] = []
      const path = await btree.first()
      while (path.on) {
        collected.push(btree.at(path)!)
        await btree.moveNext(path)
      }
      expect(collected).to.deep.equal(Array.from({ length: 500 }, (_, i) => i))
    })

    it('should handle delete of every other element in a large tree', async () => {
      for (let i = 0; i < 500; i++) {
        await btree.insert(i)
      }

      // Delete all even values
      for (let i = 0; i < 500; i += 2) {
        const path = await btree.find(i)
        expect(path.on).to.be.true
        await btree.deleteAt(path)
      }

      // Verify only odd values remain
      for (let i = 0; i < 500; i++) {
        if (i % 2 === 0) {
          expect(await btree.get(i)).to.be.undefined
        } else {
          expect(await btree.get(i)).to.equal(i)
        }
      }
    })

    it('should maintain correct count across splits and merges', async () => {
      for (let i = 0; i < 300; i++) {
        await btree.insert(i)
      }

      const countAll = await btree.getCount()
      expect(countAll).to.equal(300)

      // Delete half from the middle
      for (let i = 100; i < 200; i++) {
        const path = await btree.find(i)
        await btree.deleteAt(path)
      }

      expect(await btree.getCount()).to.equal(200)
    })

    it('should handle bulk upserts on large dataset', async () => {
      for (let i = 0; i < 200; i++) {
        await btree.insert(i)
      }

      // Upsert all existing and new values
      for (let i = 0; i < 400; i++) {
        await btree.upsert(i)
      }

      expect(await btree.getCount()).to.equal(400)
      for (let i = 0; i < 400; i++) {
        expect(await btree.get(i)).to.equal(i)
      }
    })
  })

  // TEST-3.1.2: Concurrent mutation tests (path invalidation)
  describe('path invalidation (TEST-3.1.2)', () => {
    it('should invalidate path after insert', async () => {
      await btree.insert(10)
      const path = await btree.find(10)
      expect(path.on).to.be.true
      expect(btree.isValid(path)).to.be.true

      await btree.insert(20)
      expect(btree.isValid(path)).to.be.false
    })

    it('should invalidate path after deleteAt', async () => {
      await btree.insert(10)
      await btree.insert(20)
      const pathTo10 = await btree.find(10)
      expect(btree.isValid(pathTo10)).to.be.true

      const pathTo20 = await btree.find(20)
      await btree.deleteAt(pathTo20)

      expect(btree.isValid(pathTo10)).to.be.false
    })

    it('should invalidate path after updateAt', async () => {
      await btree.insert(10)
      await btree.insert(20)
      const pathTo10 = await btree.find(10)

      const pathTo20 = await btree.find(20)
      await btree.updateAt(pathTo20, 25)

      expect(btree.isValid(pathTo10)).to.be.false
    })

    it('should invalidate path after upsert', async () => {
      await btree.insert(10)
      const path = await btree.find(10)

      await btree.upsert(30)
      expect(btree.isValid(path)).to.be.false
    })

    it('should throw on stale path usage', async () => {
      await btree.insert(10)
      await btree.insert(20)
      const path = await btree.find(10)

      await btree.insert(30) // invalidate

      expect(() => btree.at(path)).to.throw('Path is invalid')
      await expect(btree.moveNext(path)).to.be.rejectedWith('Path is invalid')
      await expect(btree.movePrior(path)).to.be.rejectedWith('Path is invalid')
      await expect(btree.deleteAt(path)).to.be.rejectedWith('Path is invalid')
      await expect(btree.updateAt(path, 99)).to.be.rejectedWith('Path is invalid')
    })

    it('should return valid path from mutation operations', async () => {
      await btree.insert(10)
      const insertPath = await btree.insert(20)
      expect(btree.isValid(insertPath)).to.be.true

      const [updatePath] = await btree.updateAt(insertPath, 25)
      expect(btree.isValid(updatePath)).to.be.true

      const upsertPath = await btree.upsert(30)
      expect(btree.isValid(upsertPath)).to.be.true
    })
  })

  describe('atomic rollback', () => {
    async function collectAll(): Promise<number[]> {
      const values: number[] = [];
      const path = await btree.first();
      while (path.on) {
        values.push(btree.at(path)!);
        await btree.moveNext(path);
      }
      return values;
    }

    it('should preserve tree after failed insert', async () => {
      for (let i = 0; i < 100; i++) {
        await btree.insert(i);
      }
      const before = await collectAll();
      expect(before).to.have.length(100);

      // Sabotage reads - insert's find() will fail inside the atomic
      const realTryGet = store.tryGet.bind(store);
      store.tryGet = async () => { throw new Error('Store failure'); };

      await expect(btree.insert(100)).to.be.rejectedWith('Store failure');

      store.tryGet = realTryGet;

      // Tree should be unchanged and fully functional
      const after = await collectAll();
      expect(after).to.deep.equal(before);

      // Should still accept new inserts
      await btree.insert(100);
      expect(await btree.get(100)).to.equal(100);
    })

    it('should preserve tree after failed delete', async () => {
      for (let i = 0; i < 100; i++) {
        await btree.insert(i);
      }
      const before = await collectAll();

      // Get a valid path, then sabotage reads before deleteAt
      const path = await btree.find(50);
      expect(path.on).to.be.true;

      const realTryGet = store.tryGet.bind(store);
      store.tryGet = async () => { throw new Error('Store failure'); };

      // deleteAt applies the entry deletion to the Atomic, then tries to
      // rebalance (which reads siblings via tryGet) - may fail there.
      // If rebalance isn't needed, the delete succeeds through the Atomic.
      let failed = false;
      try {
        await btree.deleteAt(path);
      } catch {
        failed = true;
      }

      store.tryGet = realTryGet;

      if (failed) {
        // Atomic rolled back - all values preserved
        const after = await collectAll();
        expect(after).to.deep.equal(before);
      } else {
        // Delete committed - one fewer value
        expect(await btree.get(50)).to.be.undefined;
        expect(await btree.getCount()).to.equal(99);
      }

      // Tree is functional either way
      await btree.insert(200);
      expect(await btree.get(200)).to.equal(200);
    })

    it('should preserve tree after failed upsert', async () => {
      for (let i = 0; i < 50; i++) {
        await btree.insert(i);
      }
      const before = await collectAll();

      const realTryGet = store.tryGet.bind(store);
      store.tryGet = async () => { throw new Error('Store failure'); };

      await expect(btree.upsert(999)).to.be.rejectedWith('Store failure');

      store.tryGet = realTryGet;

      const after = await collectAll();
      expect(after).to.deep.equal(before);
    })

    it('should find borrowed entry after borrow-from-right rebalance', async () => {
      // NodeCapacity=64, half=32. Insert 65 values → leaf1=[0..31](32), leaf2=[32..64](33).
      // Delete 0 → leaf1 drops to 31 → borrow from right: entry 32 moves to leaf1.
      // Correct new separator: 33. Bug: separator stays 32, making get(32) descend into leaf2.
      for (let i = 0; i < 65; i++) {
        await btree.insert(i);
      }

      const path0 = await btree.find(0);
      await btree.deleteAt(path0);

      // Borrowed entry must be reachable via point lookup
      expect(await btree.get(32)).to.equal(32);

      // Full scan must return every remaining key [1..64]
      const collected: number[] = [];
      const path = await btree.first();
      while (path.on) {
        collected.push(btree.at(path)!);
        await btree.moveNext(path);
      }
      expect(collected).to.deep.equal(Array.from({ length: 64 }, (_, i) => i + 1));
    })

    it('should find borrowed entry after borrow-from-left rebalance', async () => {
      // NodeCapacity=64, half=32. Insert 0..64 → leaf1=[0..31](32), leaf2=[32..64](33).
      // Insert -1 → leaf1=[-1..31](33); leaf2 still [32..64], partition still [32].
      // Delete 64 then 63 → leaf2 drops to 31 → rightmost leaf, no right sibling →
      //   borrow from left: entry 31 moves to front of leaf2.
      // Correct new separator: 31. A wrong separator would misroute get(31)/get(30).
      for (let i = 0; i < 65; i++) {
        await btree.insert(i);
      }
      await btree.insert(-1);

      await btree.deleteAt(await btree.find(64));
      await btree.deleteAt(await btree.find(63));

      // Borrowed entry (now first of right leaf) and its left neighbour must both resolve
      expect(await btree.get(31)).to.equal(31);
      expect(await btree.get(30)).to.equal(30);
      expect(await btree.get(32)).to.equal(32);

      // Full scan must return every remaining key: -1, 0..62
      const collected: number[] = [];
      const path = await btree.first();
      while (path.on) {
        collected.push(btree.at(path)!);
        await btree.moveNext(path);
      }
      expect(collected).to.deep.equal([-1, ...Array.from({ length: 63 }, (_, i) => i)]);
    })

    it('should roll back partial delete when rebalance read fails', async () => {
      // Insert 65 values to force one split:
      //   leaf1: [0..31], leaf2: [32..64], root branch
      for (let i = 0; i < 65; i++) {
        await btree.insert(i);
      }

      // Delete 32 to bring leaf2 to exactly 32 entries [33..64]
      const path32 = await btree.find(32);
      await btree.deleteAt(path32);
      expect(await btree.getCount()).to.equal(64);

      // Now deleting 33 triggers rebalance (leaf2 drops to 31 < 32).
      // Rebalance tries to read sibling via tryGet, which we sabotage.
      const path33 = await btree.find(33);
      expect(path33.on).to.be.true;

      const realTryGet = store.tryGet.bind(store);
      store.tryGet = async () => { throw new Error('Rebalance failure'); };

      // The atomic wrapper: apply() deletes entry 33 (recorded in Atomic),
      // then rebalance reads sibling → tryGet fails → Atomic rolls back.
      await expect(btree.deleteAt(path33)).to.be.rejectedWith('Rebalance failure');

      store.tryGet = realTryGet;

      // Entry 33 should still exist (deletion was rolled back)
      expect(await btree.get(33)).to.equal(33);
      expect(await btree.getCount()).to.equal(64);

      // Tree should still be fully functional
      await btree.insert(100);
      expect(await btree.get(100)).to.equal(100);
    })
  })

  // Regression: range scan stalled when starting key landed on end-of-leaf crack
  // (leafIndex === entries.length after find), producing zero results instead of
  // walking into the next leaf.
  describe('range scan end-of-leaf crack (btree-range-scan-stops-at-leaf-boundary)', () => {
    async function collectRange(r: KeyRange<number>): Promise<number[]> {
      const results: number[] = [];
      for await (const path of btree.range(r)) {
        results.push(btree.at(path)!);
      }
      return results;
    }

    it('should return entries after fractional key on end-of-leaf crack', async () => {
      // Insert 200 values forcing a multi-leaf tree (first leaf holds ~32 entries).
      for (let i = 0; i < 200; i++) {
        await btree.insert(i);
      }
      // Discover first-leaf max by reading the first path's leaf entries.
      const firstPath = await btree.first();
      const leafMax = firstPath.leafNode.entries[firstPath.leafNode.entries.length - 1]!;

      // A key of leafMax + 0.5 lands strictly between leafMax and leafMax+1,
      // placing the cursor at leafIndex === entries.length (end-of-leaf crack).
      const crackKey = leafMax + 0.5;
      const results = await collectRange(new KeyRange(new KeyBound(crackKey, true), undefined, true));

      const expectedFirst = leafMax + 1;
      expect(results.length).to.equal(200 - expectedFirst, `expected ${200 - expectedFirst} results`);
      expect(results[0]).to.equal(expectedFirst, 'first result should be entry right after leaf max');
    });

    it('should return entries after delete-driven end-of-leaf crack', async () => {
      // Insert 65 values → leaf1=[0..31], leaf2=[32..64].
      for (let i = 0; i < 65; i++) {
        await btree.insert(i);
      }
      // Discover first-leaf max.
      const firstPath = await btree.first();
      const leafMax = firstPath.leafNode.entries[firstPath.leafNode.entries.length - 1]!;

      // Delete the first-leaf max. The parent separator becomes stale, so
      // find(leafMax) now routes into leaf1 and lands on end-of-leaf crack.
      await btree.deleteAt(await btree.find(leafMax));

      // range starting at the deleted key must return all subsequent entries.
      const results = await collectRange(new KeyRange(new KeyBound(leafMax, true), undefined, true));

      const expectedFirst = leafMax + 1;
      const expectedCount = 65 - leafMax - 1;  // entries after leafMax in original range [0..64]
      expect(results.length).to.equal(expectedCount, `expected ${expectedCount} results`);
      expect(results[0]).to.equal(expectedFirst, 'first result should be entry right after deleted leaf max');
    });
  });

  // Regression: branchInsert was not persisting newBranch, causing "Missing block"
  // on first lookup after a branch node itself split (3-level tree, ~2081st sequential insert).
  it('should insert 2200 sequential values without Missing block error', async () => {
    const count = 2200;
    for (let i = 0; i < count; i++) {
      await btree.insert(i);
    }

    for (let i = 0; i < count; i++) {
      expect(await btree.get(i)).to.equal(i, `get(${i}) failed`);
    }

    const collected: number[] = [];
    const path = await btree.first();
    while (path.on) {
      collected.push(btree.at(path)!);
      await btree.moveNext(path);
    }
    expect(collected).to.deep.equal(Array.from({ length: count }, (_, i) => i));

    // Symmetric descending scan over the same 3-level tree exercises internalPrior at depth.
    const descending: number[] = [];
    const rpath = await btree.last();
    while (rpath.on) {
      descending.push(btree.at(rpath)!);
      await btree.movePrior(rpath);
    }
    expect(descending).to.deep.equal(Array.from({ length: count }, (_, i) => count - 1 - i));
  })

  // Regression: rebalanceBranch "merge right sibling into self" wrongly overwrote an
  // ancestor separator with pNode.partitions[0] — the separator to the merged child's
  // NEXT sibling, which is strictly greater than the merged subtree's minimum key —
  // corrupting a routing key higher up and making [subtreeMin, corruptedSeparator)
  // unreachable. An internal merge never changes a subtree's minimum, so no ancestor
  // update is needed; the offending block was removed. Only manifests when the merged
  // branch sits at path-depth >= 2 (its parent is a non-root branch), i.e. a 4-level
  // tree, which sequential inserts first reach at ~66k entries. Below that the block
  // was a harmless no-op, which is why smaller specs never caught it.
  it('should not corrupt separators on left-edge internal branch merge (4-level tree)', async function () {
    this.timeout(180000);
    const N = 70000;
    for (let i = 0; i < N; i++) {
      await btree.insert(i);
    }

    // Root of a 4-level tree is a branch; partitions[0] is the boundary B (minimum
    // key of the right mid-subtree). Deleting a contiguous range from B forces a
    // left-edge (pIndex===0) internal merge inside that subtree.
    const root = await btree.trunk.get() as unknown as BranchNode<number>;
    expect(root.partitions.length).to.be.greaterThan(0, 'expected a branch root');
    const B = root.partitions[0]!;

    // The bug only manifests when the merged branch sits at path-depth >= 2, which
    // requires a 4-level tree (>= 3 branch levels above the leaves). Assert we
    // actually reached that depth — otherwise the test would pass trivially without
    // exercising the merge (e.g. if NodeCapacity grows and 70k no longer suffices).
    let branchLevels = 0;
    let node: any = root;
    while (node && node.header.type === TreeBranchBlockType) {
      branchLevels++;
      node = await store.tryGet(node.nodes[0]!);
    }
    expect(branchLevels).to.be.at.least(3, `expected a 4-level tree; got ${branchLevels} branch levels`);

    const deleted = new Set<number>();
    for (let k = B; k < B + 3000; k++) {
      const path = await btree.find(k);
      expect(path.on).to.be.true;
      await btree.deleteAt(path);
      deleted.add(k);
    }

    // Every non-deleted key must remain reachable via point lookup; deleted keys gone.
    for (let i = 0; i < N; i++) {
      if (deleted.has(i)) {
        expect(await btree.get(i)).to.be.undefined;
      } else {
        expect(await btree.get(i)).to.equal(i, `get(${i}) unreachable after merge`);
      }
    }

    // Full scan must return the complete remaining set in order.
    const expected = Array.from({ length: N }, (_, i) => i).filter(i => !deleted.has(i));
    const collected: number[] = [];
    const path = await btree.first();
    while (path.on) {
      collected.push(btree.at(path)!);
      await btree.moveNext(path);
    }
    expect(collected).to.deep.equal(expected);
  })

  // Regression: AtomicProxy concurrency / re-entrancy (transform-merge-and-atomic-concurrency, part b).
  describe('atomic scope concurrency (transform-merge-and-atomic-concurrency)', () => {
    it('serializes overlapping un-awaited inserts instead of sharing one atomic scope', async () => {
      // Fire two mutations without awaiting the first. AtomicProxy must give each its own
      // tracker (serialized), not let the second run against the first's in-flight scope —
      // otherwise the first's commit flushes the second's half-applied state and an insert is
      // lost. Uses the bare btree (no actor wrapper) so this hits AtomicProxy directly.
      const p1 = btree.insert(1)
      const p2 = btree.insert(2)
      await Promise.all([p1, p2])

      expect(await btree.get(1)).to.equal(1, 'first insert must survive')
      expect(await btree.get(2)).to.equal(2, 'second insert must survive')
      expect(await btree.getCount()).to.equal(2, 'both inserts land exactly once')
    })

    it('handles a burst of overlapping un-awaited inserts without losing any', async () => {
      const keys = Array.from({ length: 25 }, (_, i) => i)
      await Promise.all(keys.map(k => btree.insert(k)))   // all fired before any awaited

      expect(await btree.getCount()).to.equal(keys.length)
      for (const k of keys) {
        expect(await btree.get(k)).to.equal(k, `key ${k} lost to a shared/overwritten scope`)
      }
    })

    it('supports genuine nesting: merge -> updateAt joins one scope (no deadlock / double-commit)', async () => {
      // merge() opens an atomic scope and calls updateAt() from inside it; updateAt must reuse
      // the enclosing scope rather than open (and separately commit) a second one, and must not
      // deadlock waiting on the scope it is already inside.
      await btree.insert(5)
      await btree.merge(5, (existing) => existing + 100)   // key 5 updated to 105 via nested updateAt

      expect(await btree.get(5)).to.be.undefined
      expect(await btree.get(105)).to.equal(105)
      expect(await btree.getCount()).to.equal(1)
    })
  })

  // Regression: rebalanceBranch "merge self into left sibling" read leftSib.nodes.length AFTER
  // appending branch.nodes, so the path's branch index overshot the merged child by
  // branch.nodes.length (transform-merge-and-atomic-concurrency, part c).
  //
  // The corrupt index is on the path returned by deleteAt, which the code deliberately treats
  // as invalid (version-bumped, not refreshed) and never re-reads within the same delete — so
  // the defect is latent (no current consumer) and end-to-end scans can't observe it; a
  // post-delete path already carries other intentionally-stale indexes from rebalanceLeaf.
  // We therefore assert the invariant white-box, scoped to rebalanceBranch itself: rebalancing
  // at a given depth must preserve the child block that the path descends into at that depth.
  // The buggy left-merge drives that index out of bounds (child becomes undefined); the fix keeps
  // it pointed at the same child. This guards the invariant for any future path-reuse consumer.
  it('rebalanceBranch left-merge shifts the path index by the sibling original length', async () => {
    const cap = 4   // small fan-out so branch-level (not just leaf) merges fire on a modest tree
    const s = new TestBlockStore()
    const t = BTree.create<number, number>(
      s,
      (st, rootId) => {
        let storedRootId = rootId
        return {
          get: async () => (await st.tryGet(storedRootId))!,
          set: async (node) => { storedRootId = node.header.id },
          getId: async () => storedRootId,
        }
      },
      undefined, undefined, cap,
    )

    // When a branch merges itself into its LEFT sibling, its children are appended AFTER the
    // sibling's original children, so the path index into that branch must shift right by the
    // sibling's ORIGINAL length (leftLen) to keep addressing the same child. The bug shifted by
    // the sibling's POST-append length (leftLen + branch.nodes.length) instead. We check the
    // applied shift (idxOut - idxIn), which is robust to the path index being stale on entry
    // (it always is by the time a branch underflows) — the bug is purely in the shift amount.
    const orig = (t as any).rebalanceBranch.bind(t)
    let leftMerges = 0
    const mismatches: string[] = []
    ;(t as any).rebalanceBranch = async (path: any, depth: number) => {
      const pb = path.branches[depth]
      const nodeBefore = pb ? pb.node : undefined
      const indexIn = pb ? pb.index : undefined
      const branchLenIn = pb ? pb.node.nodes.length : undefined   // children of the (to-be-merged) branch
      const res = await orig(path, depth)
      const pbAfter = path.branches[depth]
      if (pbAfter && nodeBefore && indexIn !== undefined && branchLenIn !== undefined && pbAfter.node !== nodeBefore) {
        leftMerges++   // node reassigned => "merge self into left sibling" fired at this depth
        const mergedLen = pbAfter.node.nodes.length           // leftLen + branchLenIn
        const expectedShift = mergedLen - branchLenIn         // leftLen (sibling's ORIGINAL length)
        const actualShift = pbAfter.index - indexIn
        if (actualShift !== expectedShift) {
          mismatches.push(`depth ${depth}: index shifted by ${actualShift}, expected ${expectedShift} (leftLen); off by ${actualShift - expectedShift}`)
        }
      }
      return res
    }

    const N = 60
    for (let i = 0; i < N; i++) await t.insert(i)

    // Need a >=3-level tree so a *non-root* branch can underflow and merge into its left sibling.
    const heightOf = async () => {
      let h = 1
      let node: any = await t.trunk.get()
      while (node && node.header.type === TreeBranchBlockType) { h++; node = await s.tryGet(node.nodes[0]!) }
      return h
    }
    expect(await heightOf()).to.be.at.least(3, 'expected a 3-level tree to exercise a branch merge')

    // Delete from the high end: the rightmost branch has no right sibling, so its underflow forces
    // a left-merge (rebalanceBranch "merge self into left sibling").
    for (let k = N - 1; k >= 0; k--) {
      const path = await t.find(k)
      expect(path.on).to.be.true
      await t.deleteAt(path)
    }

    expect(leftMerges).to.be.greaterThan(0, 'test did not exercise a branch left-merge; adjust N/capacity')
    expect(mismatches, `branch left-merge shifted the path index by the wrong amount:\n${mismatches.join('\n')}`).to.be.empty
  })
})
