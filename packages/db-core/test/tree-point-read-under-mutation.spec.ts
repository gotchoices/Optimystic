import { expect } from 'chai'
import { Tree } from '../src/collections/tree/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import { KeyRange, KeyBound } from '../src/btree/index.js'
import type { BranchNode, LeafNode } from '../src/btree/nodes.js'
import type { BlockGets, GetBlockResults } from '../src/index.js'

interface TestEntry {
  key: number
  value: string
}

/** Runs `run` once, after the transactor has answered the first read of `blockId` and before that
 * answer reaches the reader — so whatever `run` changes lands in the middle of the reader's descent,
 * with the parked block already read as it stood before. */
class ReadGapTransactor extends TestTransactor {
  private gap?: { blockId: string, run: () => Promise<void> }

  inGapAfterRead(blockId: string, run: () => Promise<void>): void {
    this.gap = { blockId, run }
  }

  override async get(gets: BlockGets): Promise<GetBlockResults> {
    const results = await super.get(gets)
    const gap = this.gap
    if (gap && gets.blockIds.includes(gap.blockId)) {
      this.gap = undefined
      await gap.run()
    }
    return results
  }
}

const id = 'point-read-under-mutation'
const capacity = 4
const row = (key: number): TestEntry => ({ key, value: `v${key}` })
const keys = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/**
 * A reader whose descent through the tree is parked on the root while a refresh of the SAME handle
 * adopts a rival commit that splits the leaf the descent is headed for, moving keys 5 and 6 into a
 * new leaf (docs/btree.md §Reads under a concurrent change). The root came back as it was before the
 * commit, naming the old leaf for every key from 3 up; the leaf is read after the refresh, at the
 * commit's revision, where it no longer holds them — a torn descent, which used to answer that a
 * present key was absent.
 */
async function parkedOverASplit(): Promise<Tree<number, TestEntry>> {
  const net = new ReadGapTransactor()
  const writer = await Tree.createOrOpen<number, TestEntry>(net, id, e => e.key, undefined, capacity)
  await writer.replace([1, 2, 3, 4, 5, 6].map(key => [key, row(key)]))

  const { rootId, root } = await storedRoot(net)
  const leafId = root.nodes[1]!
  expect(root.nodes, 'precondition: the root is a branch over two leaves').to.have.length(2)
  expect(await leafKeys(net, leafId), 'precondition: the right leaf is full').to.deep.equal([3, 4, 5, 6])

  // A fresh handle: it holds the header from opening, but not the root, so the descent's read of
  // the root reaches the transactor.
  const reader = (await Tree.open<number, TestEntry>(net, id, e => e.key, undefined, capacity))!
  net.inGapAfterRead(rootId, async () => {
    await writer.replace([[7, row(7)]])
    await reader.update()
    expect(await leafKeys(net, leafId), 'precondition: the rival commit moved key 6 out of the leaf').to.not.include(6)
  })
  return reader
}

/**
 * A reader whose range read has yielded keys 1 and 2 and is parked on its step into the second leaf
 * — a block neither end of the read's setup touched — while a refresh of the same handle adopts a
 * rival commit. The scan's next step validates its path and throws for that change, as a scan that
 * has yielded does.
 */
async function parkedMidScan(): Promise<Tree<number, TestEntry>> {
  const net = new ReadGapTransactor()
  const writer = await Tree.createOrOpen<number, TestEntry>(net, id, e => e.key, undefined, capacity)
  await writer.replace(keys(1, 10).map(key => [key, row(key)]))
  const { root } = await storedRoot(net)
  expect(root.nodes, 'precondition: the root is a branch over four leaves').to.have.length(4)

  const reader = (await Tree.open<number, TestEntry>(net, id, e => e.key, undefined, capacity))!
  net.inGapAfterRead(root.nodes[1]!, async () => {
    await writer.replace([[11, row(11)]])
    await reader.update()
  })
  return reader
}

/** The tree's root as storage holds it now, with its id. */
async function storedRoot(net: TestTransactor): Promise<{ rootId: string, root: BranchNode<number> }> {
  const { rootId } = (await net.get({ blockIds: [id] }))[id]?.block as unknown as { rootId: string }
  const root = (await net.get({ blockIds: [rootId] }))[rootId]?.block as BranchNode<number>
  return { rootId, root }
}

async function leafKeys(net: TestTransactor, leafId: string): Promise<number[]> {
  const leaf = (await net.get({ blockIds: [leafId] }))[leafId]?.block as unknown as LeafNode<TestEntry>
  return leaf.entries.map(entry => entry.key)
}

describe('Tree reads under a concurrent change to the same handle', () => {
  it('a point read whose descent a refresh tore retries and returns the entry', async () => {
    const reader = await parkedOverASplit()
    expect(await reader.get(6)).to.deep.equal(row(6))
  })

  it('a range scan whose setup a refresh tore retries before yielding anything', async () => {
    const reader = await parkedOverASplit()
    const scanned: number[] = []
    for await (const path of reader.range(new KeyRange(new KeyBound(5), new KeyBound(6), true))) {
      scanned.push(reader.at(path)!.key)
    }
    expect(scanned).to.deep.equal([5, 6])
  })

  it('a range read as one value reads the whole range again when a change lands after it has yielded', async () => {
    const reader = await parkedMidScan()
    const entries = await reader.entriesIn(new KeyRange(new KeyBound(1), new KeyBound(11), true))
    expect(entries.map(entry => entry.key)).to.deep.equal(keys(1, 11))
  })
})
