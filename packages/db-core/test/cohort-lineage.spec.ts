/**
 * `judgeCohortLineage`: one block's cohort answer to "is this committed write part of what the block
 * holds now?", folded from what each member's own records could say (see `BlockLineage`).
 *
 * The rule has to get two things right at once. A member that took a later revision as a replica
 * cannot vouch for or against the write and answers `unknown` — it must neither veto a member that
 * can vouch (the "restored past the revision" member) nor be believed on the strength of its
 * revision index (the fork). And `contains` is an acknowledgement, so it meets the same bar a
 * commit does: a strict majority of the cohort.
 */

import { expect } from 'chai'
import { judgeCohortLineage, type MemberLineage } from '../src/network/lineage.js'
import type { ActionRev, BlockLineage } from '../src/index.js'

const rev3 = (actionId: string): ActionRev => ({ actionId, rev: 3 })
const rev5 = (actionId: string): ActionRev => ({ actionId, rev: 5 })

const member = (peerId: string, lineage: BlockLineage, latest?: ActionRev): MemberLineage =>
	({ peerId, lineage, ...(latest === undefined ? {} : { latest }) })

describe('judgeCohortLineage', () => {
	it('an empty cohort establishes nothing', () => {
		expect(judgeCohortLineage([])).to.deep.equal({ lineage: 'unknown' })
	})

	it('contains, held in full, when every member vouches', () => {
		const answer = judgeCohortLineage([member('a', 'contains', rev3('rival')), member('b', 'contains', rev3('rival'))])
		expect(answer.lineage).to.equal('contains')
		expect(answer.durability).to.deep.equal({
			quorum: 'full', confirmed: 2, cohort: 2, unconfirmed: [], cohortPeerIds: ['a', 'b']
		})
	})

	it('a member restored past the revision — unknown, holding the same latest as a voucher — counts as holding it', () => {
		// Node B applied the write and the rival's revision on top of it; node A missed the write and
		// took the rival's revision from B as a replica. A's records say nothing, and its content is
		// B's content.
		const answer = judgeCohortLineage([member('a', 'unknown', rev3('rival')), member('b', 'contains', rev3('rival'))])
		expect(answer.lineage).to.equal('contains')
		expect(answer.durability).to.deep.equal({
			quorum: 'full', confirmed: 2, cohort: 2, unconfirmed: [], cohortPeerIds: ['a', 'b']
		})
	})

	it('an unknown member holding a DIFFERENT latest is not inferred to hold it', () => {
		const answer = judgeCohortLineage([
			member('a', 'contains', rev3('rival')),
			member('b', 'contains', rev3('rival')),
			member('c', 'unknown', rev5('later'))
		])
		expect(answer.lineage).to.equal('contains')
		expect(answer.durability).to.deep.equal({
			quorum: 'majority', confirmed: 2, cohort: 3, unconfirmed: ['c'], cohortPeerIds: ['a', 'b', 'c']
		})
	})

	it('fewer than a strict majority holding it is not established, whatever the rest say', () => {
		// One holder of two, one of three: the write may yet spread from the holder or be overwritten.
		expect(judgeCohortLineage([member('a', 'contains', rev3('r')), member('b', 'behind', { actionId: 'seed', rev: 1 })]))
			.to.deep.equal({ lineage: 'unknown' })
		expect(judgeCohortLineage([member('a', 'contains', rev3('r')), member('b', 'unknown', rev5('x')), member('c', 'unknown')]))
			.to.deep.equal({ lineage: 'unknown' })
	})

	it('members that contradict each other establish nothing — the content has forked', () => {
		expect(judgeCohortLineage([member('a', 'contains', rev3('r')), member('b', 'excludes', rev3('r'))]))
			.to.deep.equal({ lineage: 'unknown' })
	})

	it('excludes when one member proves it and every other member is accounted for', () => {
		// The fork: A built the rival's revision on the base below the write; B, which held the write,
		// took A's result as a replica — its index still names the write, and it cannot say either
		// way. Same latest as the refuter, so it holds the refuter's content.
		expect(judgeCohortLineage([member('a', 'excludes', rev3('r')), member('b', 'unknown', rev3('r'))]))
			.to.deep.equal({ lineage: 'excludes' })
		// A member that has not reached the revision is accounted for too.
		expect(judgeCohortLineage([member('a', 'excludes', rev3('r')), member('b', 'behind', { actionId: 'seed', rev: 1 })]))
			.to.deep.equal({ lineage: 'excludes' })
	})

	it('an unaccounted member keeps excludes from being final', () => {
		// B holds something newer from somewhere; it could be where the write survives.
		expect(judgeCohortLineage([member('a', 'excludes', rev3('r')), member('b', 'unknown', rev5('x'))]))
			.to.deep.equal({ lineage: 'unknown' })
		expect(judgeCohortLineage([member('a', 'excludes', rev3('r')), member('b', 'unknown')]))
			.to.deep.equal({ lineage: 'unknown' })
	})

	it('behind only when every member says so', () => {
		expect(judgeCohortLineage([member('a', 'behind'), member('b', 'behind', { actionId: 'seed', rev: 1 })]))
			.to.deep.equal({ lineage: 'behind' })
		expect(judgeCohortLineage([member('a', 'behind'), member('b', 'unknown')]))
			.to.deep.equal({ lineage: 'unknown' })
	})
})
