import { expect } from 'chai'
import { BlockFloors, type BelowFloorAnswer } from '../src/transactor/block-floors.js'
import type { ActionContext, ActionId, BlockId } from '../src/index.js'

const block = 'block-x' as BlockId
const action = (name: string) => name as ActionId
const pinnedAt = (rev: number): ActionContext => ({ committed: [], rev })

describe('BlockFloors', () => {
	it('judges nothing for a block no walked entry named', () => {
		const floors = new BlockFloors()
		expect(floors.applicableTo(block, undefined)).to.equal(undefined)
		expect(floors.answeredBelowFloor(block, undefined, 0)).to.equal(false)
	})

	it('keeps the highest floor, in whatever order entries are walked', () => {
		const floors = new BlockFloors()
		floors.raise([block], { rev: 7, actionId: action('seven') })
		floors.raise([block], { rev: 5, actionId: action('five') })
		expect(floors.applicableTo(block, undefined)).to.deep.equal({ rev: 7, actionId: 'seven' })
		floors.raise([block], { rev: 9, actionId: action('nine') })
		expect(floors.applicableTo(block, undefined)).to.deep.equal({ rev: 9, actionId: 'nine' })
		expect(floors.size).to.equal(1)
	})

	describe('which reads a floor applies to', () => {
		const floors = new BlockFloors()
		floors.raise([block], { rev: 7, actionId: action('seven') })

		it('an unpinned read', () => expect(floors.applicableTo(block, undefined)?.rev).to.equal(7))
		it('a read pinned at the floor', () => expect(floors.applicableTo(block, pinnedAt(7))?.rev).to.equal(7))
		it('a read pinned above the floor', () => expect(floors.applicableTo(block, pinnedAt(12))?.rev).to.equal(7))
		it('but not a read pinned below it, which asked for an older view', () => {
			expect(floors.applicableTo(block, pinnedAt(6))).to.equal(undefined)
			expect(floors.answeredBelowFloor(block, pinnedAt(6), 6)).to.equal(false)
			expect(floors.size, 'and such a read settles nothing').to.equal(1)
		})
	})

	it('reports an answer under the floor and leaves the floor standing', () => {
		const reported: BelowFloorAnswer[] = []
		const floors = new BlockFloors(answer => reported.push(answer))
		floors.raise([block], { rev: 7, actionId: action('seven') })

		expect(floors.answeredBelowFloor(block, pinnedAt(8), 6)).to.equal(true)
		expect(reported).to.deep.equal([{ blockId: block, floor: { rev: 7, actionId: 'seven' }, servedRev: 6 }])
		expect(floors.size).to.equal(1)
	})

	it('retires a floor on an answer at or above it, silently', () => {
		const reported: BelowFloorAnswer[] = []
		const floors = new BlockFloors(answer => reported.push(answer))
		floors.raise([block, 'other' as BlockId], { rev: 7, actionId: action('seven') })

		expect(floors.answeredBelowFloor(block, pinnedAt(8), 7)).to.equal(false)
		expect(floors.applicableTo(block, undefined)).to.equal(undefined)
		expect(floors.size, "the other block's floor is its own").to.equal(1)
		expect(reported).to.deep.equal([])
	})

	describe('checkOnly', () => {
		it('judges and reports exactly as the floors do', () => {
			const reported: BelowFloorAnswer[] = []
			const floors = new BlockFloors(answer => reported.push(answer))
			floors.raise([block], { rev: 7, actionId: action('seven') })
			const view = floors.checkOnly()

			expect(view.applicableTo(block, pinnedAt(7))?.rev).to.equal(7)
			expect(view.applicableTo(block, pinnedAt(6))).to.equal(undefined)
			expect(view.answeredBelowFloor(block, pinnedAt(7), 6)).to.equal(true)
			expect(reported).to.have.length(1)
		})

		it('never retires a floor, and sees floors raised after it was made', () => {
			const floors = new BlockFloors()
			const view = floors.checkOnly()
			floors.raise([block], { rev: 7, actionId: action('seven') })

			expect(view.answeredBelowFloor(block, pinnedAt(7), 7), 'met').to.equal(false)
			expect(floors.applicableTo(block, undefined)?.rev, 'and still standing').to.equal(7)
		})
	})
})
