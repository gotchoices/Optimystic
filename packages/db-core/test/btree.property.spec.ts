import * as fc from 'fast-check'
import { expect } from 'chai'
import { BTree } from '../src/btree/index.js'
import { KeyBound, KeyRange } from '../src/btree/key-range.js'
import { TreeBranchBlockType } from '../src/btree/nodes.js'
import { TestBlockStore } from './test-block-store.js'

// Model-based property/fuzz suite for BTree.
//
// A random mix of insert/delete/find/range operations is replayed against a
// plain sorted-array "reference model"; after EVERY operation the tree is
// checked for full equivalence with the model (count, both scans, point
// lookups, and range scans from many start keys — including between-entry and
// end-of-leaf-crack keys). The enabling trick is a small per-instance
// nodeCapacity (BTree.create's 5th arg): fan-out 4-8 forces multi-level trees —
// where borrow/merge/cascade actually fire — with only dozens of entries, so
// the property stays fast while still exercising the rare rebalance branches.
//
// The seed is pinned and logged so any CI failure is replayable: paste the
// logged seed (and fast-check's printed counterexample) back to reproduce.
const SEED = 0x0b7ee5   // arbitrary fixed seed; logged below for replay
console.log(`[btree.property] fast-check seed = ${SEED} (pass { seed } to fc.assert to reproduce)`)

// ---------------------------------------------------------------------------
// Tree construction (mirrors btree.spec.ts) with a configurable fan-out.
// ---------------------------------------------------------------------------
function makeTree(capacity: number): { store: TestBlockStore; btree: BTree<number, number> } {
	const store = new TestBlockStore()
	const btree = BTree.create<number, number>(
		store,
		(s, rootId) => {
			let storedRootId = rootId
			return {
				get: async () => (await s.tryGet(storedRootId))!,
				set: async (node) => { storedRootId = node.header.id },
				getId: async () => storedRootId,
			}
		},
		undefined,   // keyFromEntry (default: entry is its own key)
		undefined,   // compare (default numeric)
		capacity,    // nodeCapacity — the enabling change
	)
	return { store, btree }
}

// ---------------------------------------------------------------------------
// Reference model: a sorted number[] mirroring the tree's dup-rejecting set.
// ---------------------------------------------------------------------------
function modelHas(m: number[], k: number): boolean {
	return m.includes(k)
}
function modelInsert(m: number[], k: number): boolean {
	if (m.includes(k)) return false   // BTree rejects duplicate keys → no-op
	m.push(k)
	m.sort((a, b) => a - b)
	return true
}
function modelDelete(m: number[], k: number): boolean {
	const i = m.indexOf(k)
	if (i < 0) return false
	m.splice(i, 1)
	return true
}

// ---------------------------------------------------------------------------
// Read-back scans (all performed BETWEEN mutations — never interleaved, or the
// path-invalidation guard would throw).
// ---------------------------------------------------------------------------
async function scanAscending(btree: BTree<number, number>): Promise<number[]> {
	const out: number[] = []
	const path = await btree.first()
	while (path.on) {
		out.push(btree.at(path)!)
		await btree.moveNext(path)
	}
	return out
}
async function scanDescending(btree: BTree<number, number>): Promise<number[]> {
	const out: number[] = []
	const path = await btree.last()
	while (path.on) {
		out.push(btree.at(path)!)
		await btree.movePrior(path)
	}
	return out
}
async function collectRange(btree: BTree<number, number>, r: KeyRange<number>): Promise<number[]> {
	const out: number[] = []
	for await (const p of btree.range(r)) {
		out.push(btree.at(p)!)
	}
	return out
}

function unique(nums: number[]): number[] {
	return [...new Set(nums)]
}

// Count the number of branch levels above the leaves (0 => root is a leaf).
async function branchLevels(store: TestBlockStore, btree: BTree<number, number>): Promise<number> {
	let levels = 0
	let node: any = await btree.trunk.get()
	while (node && node.header.type === TreeBranchBlockType) {
		levels++
		node = await store.tryGet(node.nodes[0]!)
	}
	return levels
}

// ---------------------------------------------------------------------------
// The full invariant battery, run after every operation.
// `probeKey` is the primary key of the op just applied; it drives extra range
// start keys so delete-driven and between-entry cracks get exercised.
// ---------------------------------------------------------------------------
// NOTE: this battery is ~O(model.length * rangeStarts) per operation (every
// present key is point-looked-up, and each range start walks a model slice). It
// is cheap at current sizes (small fan-out, maxLength <= 60), but if numRuns or
// maxLength are pushed much higher, sample the present-key lookups instead of
// checking all of them.
async function checkInvariants(btree: BTree<number, number>, model: number[], probeKey: number): Promise<void> {
	// Count
	expect(await btree.getCount()).to.equal(model.length, 'getCount mismatch')

	// Full scans (ascending + descending)
	expect(await scanAscending(btree)).to.deep.equal(model, 'ascending scan mismatch')
	expect(await scanDescending(btree)).to.deep.equal([...model].reverse(), 'descending scan mismatch')

	// Point lookups — every present key resolves to itself...
	for (const k of model) {
		expect(await btree.get(k)).to.equal(k, `get(${k}) should be present`)
	}
	// ...and a spread of absent keys resolve to undefined (between-entry + just-outside).
	for (const k of model) {
		expect(await btree.get(k + 0.5)).to.equal(undefined, `get(${k + 0.5}) should be absent (between entries)`)
		expect(await btree.get(k - 0.5)).to.equal(undefined, `get(${k - 0.5}) should be absent (between entries)`)
	}
	if (model.length > 0) {
		expect(await btree.get(model[0]! - 1)).to.equal(undefined, 'get below min should be absent')
		expect(await btree.get(model[model.length - 1]! + 1)).to.equal(undefined, 'get above max should be absent')
	}

	// Range scans from arbitrary start keys, including between-entry and
	// end-of-leaf-crack keys (max + 0.5, the deleted/probed key, ...).
	const mid = model.length ? model[Math.floor(model.length / 2)]! : 0
	const starts = unique([
		...(model.length ? [model[0]!, mid, model[model.length - 1]!] : [0]),
		...(model.length ? [model[0]! - 1, model[model.length - 1]! + 1, model[model.length - 1]! + 0.5, mid + 0.5] : []),
		probeKey,
		probeKey + 0.5,
	])
	for (const s of starts) {
		// Ascending, first-bound only: everything >= s.
		expect(await collectRange(btree, new KeyRange(new KeyBound(s, true), undefined, true)))
			.to.deep.equal(model.filter(k => k >= s), `ascending range from ${s}`)
		// Descending, first-bound only (s as the high bound): everything <= s.
		expect(await collectRange(btree, new KeyRange(new KeyBound(s, true), undefined, false)))
			.to.deep.equal(model.filter(k => k <= s).reverse(), `descending range from ${s}`)
	}

	// Bounded ranges (first + last), one ascending and one descending.
	if (model.length >= 2) {
		const lo = model[0]!
		const hi = model[model.length - 1]!
		expect(await collectRange(btree, new KeyRange(new KeyBound(lo, true), new KeyBound(mid, true), true)))
			.to.deep.equal(model.filter(k => k >= lo && k <= mid), 'ascending bounded range')
		expect(await collectRange(btree, new KeyRange(new KeyBound(hi, true), new KeyBound(mid, true), false)))
			.to.deep.equal(model.filter(k => k >= mid && k <= hi).reverse(), 'descending bounded range')
	}
}

// ---------------------------------------------------------------------------
// Operation model.
// ---------------------------------------------------------------------------
type Op =
	| { kind: 'insert'; key: number }
	| { kind: 'delete'; key: number }
	| { kind: 'find'; key: number }
	| { kind: 'range'; key: number }   // read-only; battery covers the range check via probeKey

async function applyOp(btree: BTree<number, number>, model: number[], op: Op): Promise<void> {
	if (op.kind === 'insert') {
		const wasPresent = modelHas(model, op.key)
		const path = await btree.insert(op.key)
		// insert returns on=true when a NEW entry was added, on=false on duplicate conflict.
		expect(path.on).to.equal(!wasPresent, `insert(${op.key}) on-flag (wasPresent=${wasPresent})`)
		if (!wasPresent) modelInsert(model, op.key)
	} else if (op.kind === 'delete') {
		const path = await btree.find(op.key)
		const wasPresent = modelHas(model, op.key)
		expect(path.on).to.equal(wasPresent, `find(${op.key}) before delete (wasPresent=${wasPresent})`)
		if (path.on) {
			expect(await btree.deleteAt(path)).to.equal(true, `deleteAt(${op.key})`)
			modelDelete(model, op.key)
		}
	} else if (op.kind === 'find') {
		expect(await btree.get(op.key)).to.equal(modelHas(model, op.key) ? op.key : undefined, `find/get(${op.key})`)
	}
	// 'range' is read-only; the invariant battery exercises range from op.key.
}

function arbOp(keyMax: number): fc.Arbitrary<Op> {
	const arbKey = fc.integer({ min: 0, max: keyMax })
	// Weighted toward insert so sequences grow the tree into several internal
	// levels; deletes are frequent enough to trigger borrow/merge/cascade.
	return fc.oneof(
		arbKey.map((key): Op => ({ kind: 'insert', key })),
		arbKey.map((key): Op => ({ kind: 'insert', key })),
		arbKey.map((key): Op => ({ kind: 'insert', key })),
		arbKey.map((key): Op => ({ kind: 'delete', key })),
		arbKey.map((key): Op => ({ kind: 'delete', key })),
		arbKey.map((key): Op => ({ kind: 'find', key })),
		arbKey.map((key): Op => ({ kind: 'range', key })),
	)
}

async function runSequence(capacity: number, ops: Op[]): Promise<void> {
	const { btree } = makeTree(capacity)
	const model: number[] = []
	for (const op of ops) {
		await applyOp(btree, model, op)
		await checkInvariants(btree, model, op.key)
	}
}

// ---------------------------------------------------------------------------
// Suites.
// ---------------------------------------------------------------------------
describe('BTree property/fuzz (model-based)', () => {
	it('agrees with a sorted-array model at small fan-out (4-8), forcing multi-level rebalancing', async function () {
		this.timeout(180000)
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 4, max: 8 }),
				fc.array(arbOp(60), { maxLength: 40 }),
				async (capacity, ops) => {
					await runSequence(capacity, ops)
				},
			),
			{ numRuns: 100, seed: SEED, endOnFailure: true },
		)
	})

	it('agrees with a sorted-array model at default fan-out (64) over larger sequences', async function () {
		this.timeout(180000)
		await fc.assert(
			fc.asyncProperty(
				fc.array(arbOp(300), { maxLength: 60 }),
				async (ops) => {
					await runSequence(64, ops)
				},
			),
			{ numRuns: 20, seed: SEED, endOnFailure: true },
		)
	})

	// Guards the "enabling change": small fan-out really does build multi-level
	// trees (so the property above is exercising borrow/merge/cascade, not just
	// single-leaf inserts), and a large delete sweep cascades merges back down
	// while staying model-equivalent.
	it('reaches a multi-level tree at fan-out 4 and stays consistent through a delete cascade', async function () {
		this.timeout(60000)
		const { store, btree } = makeTree(4)
		const model: number[] = []

		for (let i = 0; i < 200; i++) {
			await btree.insert(i)
			modelInsert(model, i)
		}
		expect(await branchLevels(store, btree)).to.be.at.least(3, 'small fan-out should build a >=4-level tree')

		// Full model equivalence at depth.
		await checkInvariants(btree, model, 100)

		// Delete a large contiguous middle range to force cascading merges.
		for (let k = 40; k < 160; k++) {
			const path = await btree.find(k)
			expect(path.on).to.equal(true, `find(${k}) before cascade delete`)
			await btree.deleteAt(path)
			modelDelete(model, k)
		}
		await checkInvariants(btree, model, 100)

		expect(await scanAscending(btree)).to.deep.equal(model, 'post-cascade ascending scan')
	})
})
