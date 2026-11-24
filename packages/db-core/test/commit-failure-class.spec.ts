import { expect } from 'chai'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tsFiles } from './source-scan.js'
import {
	BlockTooLargeError, BlockUnavailableError, CohortOutOfSpaceError, CoordinatorPartialCommitError,
	CoordinatorRevisionStalledError, CoordinatorStaleLossError, KeyBound, KeyRange, PeersIncompleteError,
	PromiseShortfallError, SyncRetryExhaustedError, SyncRevisionStalledError, TornActionError,
	TransactionExpiredError, TransactionTooLargeError, TreeEntryChangedError, TreeKeyTakenError,
	TreeRangeTakenError, ValidityRejectedError, classifyCommitFailure,
} from '../src/index.js'
import type { CollectionId, CommitFailureClass, WriteDurability } from '../src/index.js'

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
		case 'cohort-out-of-space':
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
const outOfSpace = { peerIds: ['peer-b', 'peer-c'], approvals: 1, peerCount: 3, needed: 3 }
const torn = (final: boolean) => new TornActionError('c', 'a1', 4, ['b1'], 'rival-holds-revision', final, 'refused')

const cases: Array<[string, unknown, string]> = [
	['a promise shortfall', new PromiseShortfallError(shortfall), 'cohort-unreachable'],
	['an unreachable cohort on a read', new BlockUnavailableError('b1', 'cohort-unreachable'), 'cohort-unreachable'],
	['a read doubt that is not about reachability', new BlockUnavailableError('b1', 'named-by-log'), 'unknown'],
	// Its own kind, not `cohort-unreachable`: a full cohort answered, and what clears the wait is
	// storage rather than connectivity (docs/offline-sync.md §Classifying an attempt's outcome).
	['a cohort with no room left', new CohortOutOfSpaceError(outOfSpace), 'cohort-out-of-space'],
	['a stalled revision view (subclass of exhaustion)', new SyncRevisionStalledError('c', 2, { blockId: 'b1', rev: 5 }, 5, 4), 'contention'],
	['a lost update', new TreeEntryChangedError('c', 'k', { v: 1 }, { v: 2 }), 'guard-refused/concurrent-modification'],
	['a duplicate key', new TreeKeyTakenError('c', 'k'), 'guard-refused/constraint'],
	['a taken unique range', new TreeRangeTakenError('c', 'k', new KeyRange(new KeyBound('a'), new KeyBound('z')), 'm'), 'guard-refused/constraint'],
	['a torn write proven not saved', torn(true), 'torn-not-saved'],
	['a torn write of unknown outcome', torn(false), 'in-doubt'],
	['a plain error carrying the shortfall sentence', new Error(new PromiseShortfallError(shortfall).message), 'unknown'],
	// The real class, not a hand-rolled stand-in: this row exists for the "never walk `cause`" rule,
	// and pinning it against the aggregate the transactor actually throws is what would fail if
	// someone later gave `classifyCommitFailure` a `phase` arm.
	['an aggregate whose cause is a shortfall', PeersIncompleteError.peersDidNotComplete('commit', 'peer-a[blocks:2](non-success)', new PromiseShortfallError(shortfall)), 'unknown'],
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

// ── the coverage guard ────────────────────────────────────────────────────────────────────────────

/**
 * Every error class the write path constructs must be either sorted by `classifyCommitFailure` or
 * explicitly excused here. Twice now a class has reached the write path with no arm in the classifier
 * and been found by someone reading code rather than by a failing check, so this converts "someone
 * must remember" into "the suite says so". The allow-list's reasons are part of the classifier's
 * contract, which is why this lives beside its behaviour cases rather than in a guard spec of its own.
 *
 * Two limits of the scan, stated rather than chased:
 *
 * - A plain `throw new Error(...)` is the documented fail-fast for a hard coordinator failure and
 *   sorts as `unknown` on purpose. The scan skips the built-ins ({@link BUILT_INS}) by name, so the
 *   guard says nothing about those throws either way.
 * - The scan reads db-core only. db-p2p raises db-core's classes, which the scan therefore sees, and
 *   sends everything else across the wire as a failure the writer rebuilds into a db-core class — so a
 *   db-p2p-local error class cannot reach a remote writer's classifier BY TYPE. An in-process
 *   transactor is the one gap, and db-core's tests cannot import db-p2p without breaking the package
 *   layering the other source-scanning guards enforce (`no-fret-import.spec.ts`).
 */
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))

/** The directories whose constructions can escape a submission and reach `OfflineQueue.applyFailure`.
 *  Scanning all of db-core instead would drag in blob, queue-internal and wire error classes and
 *  drown the allow-list in entries that have nothing to do with committing a write. */
const SCANNED_DIRS = ['collection', 'collections', 'transaction', 'transactor', 'network']

/** Built-in error classes, skipped by name: they are not this repository's vocabulary, and a bare
 *  `throw new Error(...)` is a deliberate fail-fast rather than a commit outcome. */
const BUILT_INS: ReadonlySet<string> = new Set(['Error', 'TypeError', 'RangeError', 'AggregateError'])

/**
 * Matches a CONSTRUCTION of an error class, not a `throw` of one. A `throw new X(...)` scan would miss
 * three forms this tree actually uses: `cleanFailureError` and `pendRefusalError` RETURN errors their
 * caller throws, `PeersIncompleteError` is raised through a static factory, and `BlockTooLargeError`
 * is built by a refusal helper and never thrown by name. `RecordAttemptFailed` is named explicitly as
 * the one write-path class not suffixed `Error`; it lives in `offline/`, outside {@link SCANNED_DIRS},
 * so it is matched but not expected to be found — were it ever moved into scope, the guard would
 * require a decision about it. Over-matching is the safe direction: an extra name costs one
 * allow-list line, a missed one costs the guard.
 */
const CONSTRUCTION_RE = /\bnew\s+([A-Z][A-Za-z0-9_]*Error|RecordAttemptFailed)\s*\(/g

/** Every error class name constructed in `text`, built-ins aside. */
function constructedClasses(text: string): string[] {
	const names: string[] = []
	for (const m of text.matchAll(CONSTRUCTION_RE)) {
		const name = m[1]
		if (name !== undefined && !BUILT_INS.has(name)) {
			names.push(name)
		}
	}
	return names
}

/**
 * A construction of each class the classifier sorts, with arguments that reach its arm. Asserted only
 * to be sorted at all, never to a particular kind: which kind each class means is pinned by the
 * {@link cases} table above, and duplicating that vocabulary here would make the guard a second place
 * to edit on every rename.
 */
const SORTED: Record<string, () => unknown> = {
	BlockTooLargeError: () => new BlockTooLargeError('b1', 1_000_000),
	// Sorts by `reason`: only the two reachability reasons are non-`unknown`, and the rest are pinned
	// by their own case above.
	BlockUnavailableError: () => new BlockUnavailableError('b1', 'cohort-unreachable'),
	CohortOutOfSpaceError: () => new CohortOutOfSpaceError(outOfSpace),
	CoordinatorPartialCommitError: () => new CoordinatorPartialCommitError(
		new Map<CollectionId, WriteDurability | undefined>([['c1', undefined]]), ['c2']),
	CoordinatorRevisionStalledError: () => new CoordinatorRevisionStalledError('c', { blockId: 'b1', rev: 5 }, 5, 4, 2, ['c']),
	CoordinatorStaleLossError: () => new CoordinatorStaleLossError(['c'], 'rival holds the revision'),
	PromiseShortfallError: () => new PromiseShortfallError(shortfall),
	SyncRetryExhaustedError: () => new SyncRetryExhaustedError('c', 4, 'rival holds the revision'),
	SyncRevisionStalledError: () => new SyncRevisionStalledError('c', 2, { blockId: 'b1', rev: 5 }, 5, 4),
	// Sorts by `final`; both answers are non-`unknown`, so either argument proves coverage.
	TornActionError: () => torn(true),
	TransactionExpiredError: () => new TransactionExpiredError(
		{ expiration: 1_000, memberClocks: { 'peer-a': 2_000 }, coordinatorClock: 2_000 }),
	TransactionTooLargeError: () => new TransactionTooLargeError('a1', 1_000_000),
	TreeEntryChangedError: () => new TreeEntryChangedError('c', 'k', { v: 1 }, { v: 2 }),
	TreeKeyTakenError: () => new TreeKeyTakenError('c', 'k'),
	TreeRangeTakenError: () => new TreeRangeTakenError('c', 'k', new KeyRange(new KeyBound('a'), new KeyBound('z')), 'm'),
	ValidityRejectedError: () => new ValidityRejectedError({ refusals: [{ peerId: 'peer-a', reason: 'operations hash mismatch' }] }),
}

/** Classes a human decided to leave unsorted, each with the reason. Sorting as `unknown` is the
 *  conservative answer — retry under the attempt's own identity — so an entry here is a judgement that
 *  the class is not a commit outcome, not an oversight. */
const UNSORTED: Record<string, string> = {
	SealedSegmentsError: 'a broken queue invariant; `applyFailure` re-throws it before classifying, which stops the drain',
	PeersIncompleteError: 'the deliberate non-sort documented on `classifyCommitFailure` — sorting on its `phase` is a decision about drain behaviour, not a rename',
	PendRejectedError: 'module-private to `coordinator.ts` and never escapes: `cleanFailureError` turns a clean stale loss into `CoordinatorStaleLossError` and anything else into a plain `Error`',
	CoordinatorConcurrentStampError: 'caller misuse (two writers sharing one coordinator), raised at statement time, never as a commit outcome',
	CollectionHeaderVanishedError: 'storage contradicted itself; a defect, and `unknown`\'s retry-in-doubt is the conservative answer',
	BlockPossiblyStaleError: 'a read\'s doubt about currency, raised during refresh, not a write outcome',
	TreeUpsertGuardKindError: 'a malformed action — a caller bug — raised while staging, deliberately not a refusal',
	TreeDeleteGuardKindError: 'the delete-side mirror of the same check',
}

describe('classifyCommitFailure coverage', () => {
	it('sorts every class it claims to sort', () => {
		for (const [name, build] of Object.entries(SORTED)) {
			expect(classifyCommitFailure(build()).kind, `${name} should not sort as unknown`).to.not.equal('unknown')
		}
	})

	it('gives a reason for every class left unsorted', () => {
		for (const [name, reason] of Object.entries(UNSORTED)) {
			expect(reason.trim(), `${name} needs a reason, not a bare name`).to.not.equal('')
		}
	})

	it('accounts for every error class the write path constructs', async () => {
		const found = new Set<string>()
		let scanned = 0
		for (const dir of SCANNED_DIRS) {
			for (const file of await tsFiles(`${SRC_DIR}/${dir}`)) {
				scanned++
				for (const name of constructedClasses(await readFile(file, 'utf8'))) {
					found.add(name)
				}
			}
		}
		expect(scanned, 'the scan found no sources to read').to.be.greaterThan(0)

		const accounted = new Set([...Object.keys(SORTED), ...Object.keys(UNSORTED)])
		// Both directions. Unaccounted: a class was added to the write path and nobody decided whether
		// it is a commit outcome. Stale: a table entry names a class nothing constructs any more, and is
		// holding a decision open for code that is gone.
		const unaccounted = [...found].filter(name => !accounted.has(name)).sort()
		const stale = [...accounted].filter(name => !found.has(name)).sort()
		expect(unaccounted, `sort these in \`classifyCommitFailure\` or excuse them in UNSORTED:\n${unaccounted.join('\n')}`).to.deep.equal([])
		expect(stale, `no longer constructed under ${SCANNED_DIRS.join(', ')}; prune from SORTED/UNSORTED:\n${stale.join('\n')}`).to.deep.equal([])
	})

	// The assertion above only proves "nothing is unaccounted for *today*". These cases prove the
	// matcher still fires on the construction forms this tree uses, so the guard cannot rot into a scan
	// that silently matches nothing and passes forever.
	it('detects every construction form the write path uses', () => {
		const constructions = [
			`throw new PromiseShortfallError(shortfall);`,
			// Arguments across lines, as `write-attempts.ts` and `coordinator.ts` write them.
			`throw new TornActionError(\n\t\t\tcollectionId,\n\t\t\tactionId,\n\t\t);`,
			// Returned for the caller to throw (`cleanFailureError`, `pendRefusalError`).
			`return new CoordinatorStaleLossError(failed, reason);`,
			// What a static factory's body does — the reason a `throw X.factory(...)` call site needs no
			// matching of its own.
			`return new PeersIncompleteError(phase, message, cause);`,
			// Built by a helper and handed back, never thrown by name.
			`const refusal = new BlockTooLargeError(blockId, bytes);`,
			// The one write-path class not suffixed `Error`.
			`throw new RecordAttemptFailed(err);`,
		]
		for (const snippet of constructions) {
			expect(constructedClasses(snippet), `should flag: ${JSON.stringify(snippet)}`).to.have.lengthOf(1)
		}
	})

	it('does not flag built-ins or a static factory call', () => {
		const ignored = [
			'throw new Error(`Log not found for collection ${id}`);',
			`throw new TypeError('not an array');`,
			// A factory CALL constructs nothing; its class is found through the factory's own body.
			`throw PeersIncompleteError.peersDidNotComplete('commit', details, cause);`,
			`const held = PeersIncompleteError;`,
		]
		for (const snippet of ignored) {
			expect(constructedClasses(snippet), `should NOT flag: ${JSON.stringify(snippet)}`).to.deep.equal([])
		}
	})
})
