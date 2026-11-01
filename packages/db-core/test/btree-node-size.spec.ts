import { expect } from 'chai'
import { BTree } from '../src/btree/index.js'
import type { BranchNode, ITreeNode, LeafNode } from '../src/btree/nodes.js'
import { TreeLeafBlockType } from '../src/btree/nodes.js'
import { Tree } from '../src/collections/tree/index.js'
import type { TreeCollectionHeaderBlock } from '../src/collections/tree/struct.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import { BLOCK_TARGET_BYTES } from '../src/network/block-size.js'
import { jsonEncodedBytes } from '../src/network/transaction-size.js'
import { TestBlockStore } from './test-block-store.js'

// A tree node is a block, and a block that outgrows what one message carries can never be copied to
// another machine. These specs pin the node size rules (see "Node size" in docs/btree.md) at a small
// byte target, so a few hundred small entries exercise every path — leaf and branch division, the
// in-place update, and the borrow/merge refusals on delete — and reproduce the original report over
// `TestTransactor` at the real target.

type Sized = { key: number; pad: string }
const sized = (key: number, padLength: number): Sized => ({ key, pad: 'x'.repeat(padLength) })
/** Entry sizes that vary with the key, so leaves divide at irregular points. */
const variedPad = (key: number) => 40 + (key * 37) % 400

/** Keys 0..count-1 in a fixed pseudo-random order, so a failure replays. */
function shuffledKeys(count: number, seed: number): number[] {
	const keys = Array.from({ length: count }, (_, i) => i)
	let state = seed
	const next = () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff
		return state
	}
	for (let i = keys.length - 1; i > 0; i--) {
		const j = next() % (i + 1)
		;[keys[i], keys[j]] = [keys[j]!, keys[i]!]
	}
	return keys
}

function makeTree<TKey, TEntry>(capacity: number, targetBytes: number | undefined, keyFromEntry?: (entry: TEntry) => TKey) {
	const store = new TestBlockStore()
	const btree = BTree.create<TKey, TEntry>(store, (s, rootId) => {
		let storedRootId = rootId
		return {
			get: async () => (await s.tryGet(storedRootId))!,
			set: async (node) => { storedRootId = node.header.id },
			getId: async () => storedRootId,
		}
	}, keyFromEntry, undefined, capacity, undefined, targetBytes)
	const read = (id: string) => store.tryGet(id)
	return { store, btree, read }
}

async function scanKeys<TKey, TEntry>(btree: BTree<TKey, TEntry>): Promise<TKey[]> {
	const out: TKey[] = []
	const path = await btree.first()
	while (path.on) {
		out.push(btree.keyFromEntry(btree.at(path)!))
		await btree.moveNext(path)
	}
	return out
}

type Shape = { leaves: number; branches: number; levels: number }

/** Walk every node under `root`, asserting the size rules: a node over `target` bytes holds a single
 *  entry or, for a branch, no more than two children; a branch has one more child than key; and no
 *  leaf but the root is empty. */
async function assertNodeRules(root: ITreeNode, read: (id: string) => Promise<ITreeNode | undefined>, target: number): Promise<Shape> {
	const shape: Shape = { leaves: 0, branches: 0, levels: 0 }
	const visit = async (node: ITreeNode, depth: number): Promise<void> => {
		shape.levels = Math.max(shape.levels, depth + 1)
		const bytes = jsonEncodedBytes(node)
		if (node.header.type === TreeLeafBlockType) {
			const leaf = node as LeafNode<unknown>
			shape.leaves++
			expect(bytes <= target || leaf.entries.length === 1, `leaf ${node.header.id}: ${leaf.entries.length} entries in ${bytes} bytes`).to.equal(true)
			expect(depth === 0 || leaf.entries.length > 0, `leaf ${node.header.id} is empty`).to.equal(true)
			return
		}
		const branch = node as BranchNode<unknown>
		shape.branches++
		expect(bytes <= target || branch.nodes.length <= 2, `branch ${node.header.id}: ${branch.nodes.length} children in ${bytes} bytes`).to.equal(true)
		expect(branch.nodes.length, `branch ${node.header.id}: keys against children`).to.equal(branch.partitions.length + 1)
		for (const id of branch.nodes) {
			const child = await read(id)
			expect(child, `missing node ${id}`).to.exist
			await visit(child!, depth + 1)
		}
	}
	await visit(root, 0)
	return shape
}

const ascending = (a: number, b: number) => a - b

describe('BTree node size', () => {
	describe('at a small byte target', () => {
		it('divides a leaf by bytes, and leaves an entry larger than the target alone in its leaf', async () => {
			const target = 2_000
			const { btree, read } = makeTree<number, Sized>(64, target, entry => entry.key)
			const model: number[] = []
			for (const key of shuffledKeys(200, 7)) {
				await btree.insert(sized(key, variedPad(key)))
				model.push(key)
			}
			model.sort(ascending)

			const shape = await assertNodeRules(await btree.trunk.get(), read, target)
			expect(shape.leaves, 'the count rule alone would hold 200 entries in at most 6 leaves').to.be.at.least(20)
			expect(await scanKeys(btree)).to.deep.equal(model)
			for (const key of model) {
				expect((await btree.get(key))?.key).to.equal(key)
			}

			// Larger than the target by itself, and landing between two entries of a leaf.
			const big = 100.5
			await btree.insert(sized(big, 3_000))
			const path = await btree.find(big)
			expect(path.on).to.equal(true)
			expect(path.leafNode.entries).to.have.length(1)
			await assertNodeRules(await btree.trunk.get(), read, target)
			expect(await scanKeys(btree)).to.deep.equal([...model, big].sort(ascending))
		})

		it('divides a leaf when an in-place update grows an entry past the target', async () => {
			const target = 2_000
			const { btree, read } = makeTree<number, Sized>(64, target, entry => entry.key)
			const count = 40
			for (let key = 0; key < count; key++) {
				await btree.insert(sized(key, 10))
			}
			const before = await assertNodeRules(await btree.trunk.get(), read, target)

			for (let key = 0; key < count; key++) {
				// Both in-place paths: upsert, and updateAt through merge. The returned path stays on the
				// entry, which may have moved to a new leaf.
				const grown = sized(key, 300)
				const path = key % 2 === 0
					? await btree.upsert(grown)
					: (await btree.merge(grown, () => grown))[0]
				expect(path.on).to.equal(true)
				expect(btree.at(path)?.key).to.equal(key)
			}

			const after = await assertNodeRules(await btree.trunk.get(), read, target)
			expect(after.leaves).to.be.greaterThan(before.leaves)
			expect(await scanKeys(btree)).to.deep.equal(Array.from({ length: count }, (_, i) => i))
			for (let key = 0; key < count; key++) {
				expect((await btree.get(key))?.pad).to.have.length(300)
			}
		})

		it('divides a branch by bytes when its keys are large', async () => {
			// 300-character keys: four fit a leaf under the target, three fit a branch beside their child
			// ids, so the tree grows several levels where the count rule (64) would give it two.
			const target = 1_200
			const key = (i: number) => i.toString().padStart(4, '0') + 'k'.repeat(296)
			const { btree, read } = makeTree<string, string>(64, target)
			const keys = shuffledKeys(200, 11).map(key)
			for (const k of keys) {
				await btree.insert(k)
			}

			const shape = await assertNodeRules(await btree.trunk.get(), read, target)
			expect(shape.levels).to.be.at.least(4)
			expect(await scanKeys(btree)).to.deep.equal([...keys].sort())
			for (const k of keys) {
				expect(await btree.get(k)).to.equal(k)
			}
		})

		it('keeps every node within the rules through a delete sweep that removes most entries', async function () {
			this.timeout(60_000)
			const cases = [
				{
					name: 'varied entry sizes',
					target: 2_000,
					make: () => makeTree<number, Sized>(64, 2_000, entry => entry.key),
					entry: (key: number) => sized(key, variedPad(key)),
					keyOf: (entry: Sized) => entry.key,
				},
				{
					name: 'large keys',
					target: 1_200,
					make: () => makeTree<number, Sized>(64, 1_200, entry => entry.key),
					entry: (key: number) => sized(key, 290),
					keyOf: (entry: Sized) => entry.key,
				},
			]
			for (const { name, target, make, entry } of cases) {
				const { btree, read } = make()
				const model = new Set<number>()
				for (const key of shuffledKeys(200, 3)) {
					await btree.insert(entry(key))
					model.add(key)
				}
				for (const key of shuffledKeys(200, 5).slice(0, 170)) {
					const path = await btree.find(key)
					expect(path.on, `${name}: find(${key}) before delete`).to.equal(true)
					expect(await btree.deleteAt(path), `${name}: deleteAt(${key})`).to.equal(true)
					model.delete(key)
					await assertNodeRules(await btree.trunk.get(), read, target)
					expect(await scanKeys(btree), `${name}: scan after deleting ${key}`).to.deep.equal([...model].sort(ascending))
				}
				expect(await btree.getCount(), name).to.equal(30)
			}
		})
	})

	it('places a split child correctly when a middle child of a full branch splits toward its right half', async () => {
		// A defect older than the size rule, found while adding it. At fan-out 4 the leaf holding 20..37
		// is the second of four children when 38 splits it, and 38 lands in the new right half. The
		// branch then divides too, and the old code inserted the new leaf into BOTH halves: a scan read
		// 35, 37, 38 twice and a lookup of 50 descended into the wrong child.
		const { btree } = makeTree<number, number>(4, undefined)
		const keys = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 35, 37, 38]
		for (const k of keys) {
			await btree.insert(k)
		}
		expect(await scanKeys(btree)).to.deep.equal([...keys].sort(ascending))
		expect(await btree.get(50)).to.equal(50)
		expect(await btree.get(38)).to.equal(38)
	})

	it('a tree of 140 KB rows over TestTransactor builds no node over BLOCK_TARGET_BYTES unless it holds one entry', async function () {
		this.timeout(120_000)
		// 64 rows of 140 KB used to share one leaf of about 9 MB, past the 8 MiB message limit. Each
		// row is its own transaction, as a SQL insert is, so no transaction limit ever saw the leaf grow.
		const network = new TestTransactor()
		const id = 'sized-rows'
		const tree = await Tree.createOrOpen<number, Sized>(network, id, entry => entry.key)
		const count = 64
		for (let key = 0; key < count; key++) {
			await tree.replace([[key, sized(key, 140_000)]])
		}

		const read = async (blockId: string) => (await network.get({ blockIds: [blockId] }))[blockId]!.block as ITreeNode | undefined
		const header = (await network.get({ blockIds: [id] }))[id]!.block as TreeCollectionHeaderBlock
		const shape = await assertNodeRules((await read(header.rootId))!, read, BLOCK_TARGET_BYTES)
		expect(shape.leaves, 'seven 140 KB rows fit one leaf under 1 MiB; 64 rows need at least ten').to.be.at.least(10)

		const keys: number[] = []
		const path = await tree.first()
		while (path.on) {
			keys.push(tree.at(path)!.key)
			await tree.moveNext(path)
		}
		expect(keys).to.deep.equal(Array.from({ length: count }, (_, i) => i))
	})
})

describe('BTree node size: what a division writes', () => {
	it('records no operation on a leaf that keeps every entry it had when the new entry alone goes right', async () => {
		// A division that leaves the old leaf exactly as it was must not write it: a zero-length splice
		// still marks the block updated and has it re-committed and replicated for nothing.
		const { store, btree } = makeTree<number, Sized>(64, 2_000, entry => entry.key)
		const updated: string[] = []
		const update = store.update.bind(store)
		store.update = (id, op) => { updated.push(id); update(id, op) }
		for (let key = 0; key < 10; key++) {
			await btree.insert(sized(key, 40))
		}
		const leafBefore = (await btree.find(0)).leafNode.header.id
		updated.length = 0
		await btree.insert(sized(10, 1_500))	// larger than the ten together, so only it can go right
		expect((await btree.find(10)).leafNode.header.id).to.not.equal(leafBefore)
		expect(updated.filter(id => id === leafBefore)).to.deep.equal([])
	})
})
