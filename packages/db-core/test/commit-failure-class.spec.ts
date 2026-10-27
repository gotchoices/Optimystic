import { expect } from 'chai'
import {
	BlockUnavailableError, KeyBound, KeyRange, PromiseShortfallError, SyncRevisionStalledError, TornActionError,
	TreeEntryChangedError, TreeKeyTakenError, TreeRangeTakenError, classifyCommitFailure,
} from '../src/index.js'
import type { CommitFailureClass } from '../src/index.js'

/**
 * `classifyCommitFailure` sorts by type alone (docs/offline-sync.md §Classifying an attempt's
 * outcome). One case per row that branches; rows that are a single class with no branching are
 * left to the type. The shortfall case is the control for the two negative cases after it.
 */

/** Flattens a class to the facts a case asserts; the `never` default fails the build when an arm is
 *  added without a consumer handling it. */
function summarize(sorted: CommitFailureClass): string {
	switch (sorted.kind) {
		case 'guard-refused': return `guard-refused/${sorted.refusal}`
		case 'cohort-unreachable':
		case 'contention':
		case 'rejected':
		case 'too-large':
		case 'expired':
		case 'torn-not-saved':
		case 'in-doubt':
		case 'partial':
		case 'unknown':
			return sorted.kind
		default: {
			const unhandled: never = sorted
			return unhandled
		}
	}
}

const shortfall = { approvals: 1, rejections: 0, peerCount: 3, needed: 3, silentPeers: ['peer-b', 'peer-c'] }
const torn = (final: boolean) => new TornActionError('c', 'a1', 4, ['b1'], 'rival-holds-revision', final, 'refused')

const cases: Array<[string, unknown, string]> = [
	['a promise shortfall', new PromiseShortfallError(shortfall), 'cohort-unreachable'],
	['an unreachable cohort on a read', new BlockUnavailableError('b1', 'cohort-unreachable'), 'cohort-unreachable'],
	['a read doubt that is not about reachability', new BlockUnavailableError('b1', 'named-by-log'), 'unknown'],
	['a stalled revision view (subclass of exhaustion)', new SyncRevisionStalledError('c', 2, { blockId: 'b1', rev: 5 }, 5, 4), 'contention'],
	['a lost update', new TreeEntryChangedError('c', 'k', { v: 1 }, { v: 2 }), 'guard-refused/concurrent-modification'],
	['a duplicate key', new TreeKeyTakenError('c', 'k'), 'guard-refused/constraint'],
	['a taken unique range', new TreeRangeTakenError('c', 'k', new KeyRange(new KeyBound('a'), new KeyBound('z')), 'm'), 'guard-refused/constraint'],
	['a torn write proven not saved', torn(true), 'torn-not-saved'],
	['a torn write of unknown outcome', torn(false), 'in-doubt'],
	['a plain error carrying the shortfall sentence', new Error(new PromiseShortfallError(shortfall).message), 'unknown'],
	['an aggregate whose cause is a shortfall', new Error('Some peers did not complete', { cause: new PromiseShortfallError(shortfall) }), 'unknown'],
]

describe('classifyCommitFailure', () => {
	for (const [name, error, expected] of cases) {
		it(`sorts ${name} as ${expected}`, () => {
			const sorted = classifyCommitFailure(error)
			expect(summarize(sorted)).to.equal(expected)
			expect(sorted.error).to.equal(error)
		})
	}
})
