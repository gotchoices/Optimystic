description: A read or write that fails because some machines did not answer now carries a field naming which step failed, instead of only saying so inside an English sentence. Every error message is unchanged, so anything reading the text today keeps working.
architecture: docs/offline-sync.md#classifying-an-attempts-outcome
files: packages/db-core/src/transactor/peers-incomplete-error.ts (new), packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/index.ts, packages/db-core/src/transaction/commit-failure-class.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-core/test/commit-failure-class.spec.ts, docs/offline-sync.md, docs/internals.md
----

# What landed

`NetworkTransactor` built four "not every peer answered" aggregates as plain `Error`s distinguished only by their wording. They are now one typed class carrying the operation that raised them.

**New: `packages/db-core/src/transactor/peers-incomplete-error.ts`** — `TransactorPhase = 'get' | 'pend' | 'commit' | 'cancel'` and `PeersIncompleteError extends Error` with a readonly `phase`. The constructor takes the message already composed at each site, sets `name = 'PeersIncompleteError'`, and sets both `cause` and the `AggregateError`-shaped `errors` array (`cause ? [cause] : []`) for every phase. Exported from `transactor/index.ts`, which the package root barrel already re-exports, so it reaches consumers as `@optimystic/db-core`'s `PeersIncompleteError`. No imports at all, so the barrel-cycle guard is satisfied by construction.

Its doc comment carries the four facts the ticket asked for: the messages are a downstream contract; `phase: 'get'` is a protocol fault and not unreachability; the class is local-only and needs no wire type; and a NOTE-tagged tripwire saying the per-peer detail stays prose until someone needs the peer statuses as data (the four renderers do not share a status vocabulary, so structuring them means agreeing on one first).

**The four sites** in `network-transactor.ts` — the aggregate in `get` (line ~469), `pend` (~836), `commitBlocks` (~1423) and `dischargeCancel` (~1639) — now construct the class instead of a plain `Error`, and the hand-set `(aggregate as any).cause` / `(aggregate as AggregateError).errors` lines are gone. Each carries a one-line `NOTE:`; the one at `dischargeCancel` is the sharp one, saying not to give that aggregate the `Some peers did not complete:` prefix for consistency or anything else, because adopting it would make an undischarged cancel classify as retry-safe downstream. `pendMany` and `commitMany` build no aggregate of their own and were not touched.

**`classifyCommitFailure`** still sorts all four as `unknown`. Its doc comment gained the "could sort on `phase`, deliberately does not" tripwire with the stated condition (if the drain needs to tell a pend-phase transport failure from a commit-phase one, sort on `phase` there rather than widening the "never walk `cause`" rule), and its "the transactor's plain `Some peers did not complete` aggregate" wording — false now that the aggregate is typed — is fixed.

**Docs.** `docs/offline-sync.md` §Classifying an attempt's outcome names the class and its `phase` and says the `unknown` sorting is deliberate; `docs/internals.md` names it at both mentions (the pend-shortfall bullet of §Consensus Execution and the third-producer paragraph of §Read Path). No new section. The offline-sync paragraph I edited was hard-wrapped; I unwrapped that one paragraph to a single line per the project's no-hard-wrapping rule rather than leaving one long line inside a wrapped block. That inflates its diff — the prose change inside it is the two added sentences and the dropped word "plain".

# One thing the ticket got wrong

The ticket's edge-case list predicted a logging change: "`errors` is now set where it was not … the sole reader is db-p2p's `logger.ts` aggregate formatter, which will now print the root cause as a nested line for those two phases as it already does for `pend` and `cancel`."

That is not what happens. `isAggregateError` in `packages/db-p2p/src/logger.ts:115` accepts an error only if it is `instanceof AggregateError` or its `name` is literally `'AggregateError'`. The old aggregates were plain `Error`s (`name === 'Error'`), so the formatter never nested their `errors` for *any* of the four phases, and `PeersIncompleteError` (`name === 'PeersIncompleteError'`) does not qualify either. **Log output is byte-unchanged for all four phases, not changed for two of them.** The `errors` array still has no reader today; I kept it set uniformly because two of the four sites already set it and a duck-typed consumer (`Array.isArray(err.errors)`) is the shape anyone would check. The constructor comment states this accurately rather than repeating the ticket's prediction.

I did **not** change `name` to `'AggregateError'` or make the class extend `AggregateError` to "make the logging work" — that would change log output and is beyond this ticket. Reviewer's call whether nested root-cause logging is worth a separate ticket; the four messages already append `; root: <message>` inline, so the root cause is not actually lost from the log line.

# What a reviewer should check

- **Every message byte-identical.** The three `Some peers did not complete:` templates and the `Cancel of action …` template are unchanged. Confirmed by `git diff packages/db-core/src/transactor/network-transactor.ts | grep -E "^[-+].*(Some peers did not complete|Cancel of action)"` — the added lines carry the same template text, and the cancel aggregate's `; peers:` / `; root:` continuation lines do not appear in the diff at all because they were not touched.
- **`cancel` did not acquire the shared prefix.** `grep -rn "Some peers did not complete" packages/db-core/src` returns the three aggregate sites plus two comment mentions; the cancel sentence still does not match.
- **The `get` phase really is the protocol-fault path, not unreachability.** The aggregate is raised under `omittedIds.length > 0` (some coordinator responded and left a requested block out); the `unansweredIds` path below it flags `'peers-unreachable'` and returns. A reviewer disagreeing with that reading would be disagreeing with the doc comment's second fact, which is the one most likely to mislead a consumer.
- **The `classifyCommitFailure` tripwire is a tripwire, not a deferred defect.** Nothing today reads `phase` to decide drain behaviour, so sorting all four as `unknown` is the same conservative answer as before; it only becomes work if the drain wants the pend/commit distinction.

# Tests

No new test. Two existing ones changed, as the ticket specified:

- `packages/db-core/test/network-transactor.spec.ts`, "fails the whole read when a coordinator responded without a requested block" — keeps the `/^Some peers did not complete/` message assertion (that assertion is the in-repo proof the sentence is unchanged) and adds that the thrown error is a `PeersIncompleteError` with `phase === 'get'`.
- `packages/db-core/test/commit-failure-class.spec.ts`, the "an aggregate whose cause is a shortfall" row — now builds a real `PeersIncompleteError('commit', …, new PromiseShortfallError(shortfall))` instead of a hand-rolled `new Error('Some peers did not complete', { cause })`, still expecting `unknown`. The row exists for the "never walk `cause`" rule, and pinning it against the class the transactor actually throws is what would fail if someone later added a `phase` arm.

The `'pend'`, `'commit'` and `'cancel'` phase values are a constant per site with no branching, so they are verified by inspection rather than by three more specs.

# Commands run

From `packages/db-core`: `yarn build` (clean). From the repo root: `yarn lint` (clean), `yarn lint:docs` (49 documents, 842 anchored citations, 906 file mentions, 814 links — all resolve), `yarn lint:deps` (1281 files across 13 packages — every import declared), `yarn typecheck` (clean).

Specs, by file, from `packages/db-core` via `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/<file>`:

- `test/commit-failure-class.spec.ts` — 11 passing
- `test/network-transactor.spec.ts` — 76 passing
- `test/barrel-import-cycle.spec.ts` — 4 passing (run because this ticket adds a module under `src/`)

No full package suite, per the project testing rules; review runs those. No pre-existing failures surfaced.

# Handoff to the downstream repository

`PeersIncompleteError.phase` is the replacement for sereus `control-write-retry.ts`'s text matching: `'get'` and `'pend'` are the retry-safe arms that its `Some peers did not complete:` + `[block:` conjunction currently selects, `'commit'` is what its `[blocks:` exclusion currently drops, and `'cancel'` is the undischarged cancel its differing-sentence check currently keeps out. Every message is unchanged, so nothing of theirs breaks today; branching on `phase` and dropping the sentence match is theirs to make when they choose.

The garden report's standing note — do not reword the `Some peers did not complete:` aggregates or merge the `[block:` and `[blocks:` forms — still holds after this ticket and should keep holding until that downstream change lands. It is now also recorded at each of the four code sites, which is where the next person to edit them will actually see it.

# Sibling

`debt-an-exhausted-write-names-the-rival-holding-its-blocks` is the other half of the parent ticket and also edits `network-transactor.ts` (in `refusalFrom`) and the same two documents. It had not landed when this ran, so its regions are untouched here; if it runs after this, it should re-read those files rather than assume the regions it saw.
