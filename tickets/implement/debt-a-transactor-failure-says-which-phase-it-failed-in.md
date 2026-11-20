description: When a read or write fails because some of the machines involved did not answer, the error says which step failed only inside an English sentence, so another application has to pattern-match our wording to tell one kind of failure from another. Give the error a field naming the step, and leave every message byte-for-byte as it is so nothing reading the text today breaks.
architecture: docs/offline-sync.md#classifying-an-attempts-outcome
files: packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/peers-incomplete-error.ts (new), packages/db-core/src/transactor/index.ts, packages/db-core/src/transaction/commit-failure-class.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-core/test/commit-failure-class.spec.ts, docs/offline-sync.md, docs/internals.md
----

# Why

`NetworkTransactor` builds four "not every peer answered" aggregate errors, one per operation it performs. Each is a plain `Error` whose only distinguishing feature is its wording:

- `get`, `pend` and `commitBlocks` each raise `Some peers did not complete: <per-peer detail>`, where the per-peer detail renders as `<peer>[block:<id>](<status>)` for `get` and `pend`, and `<peer>[blocks:<count>](<status>)` for `commitBlocks`.
- `dischargeCancel` raises a different sentence entirely: `Cancel of action <id> did not discharge <n> block(s): …; peers: …`, with a `[block:` detail.

A downstream application (`control-write-retry.ts` in the sereus repository, outside this tree) decides which of our failures are safe to re-present by testing `Some peers did not complete:` **and** `[block:` on one message in the cause chain. That conjunction is how it separates a retry-safe `get`/`pend` failure from a commit failure, and the differing cancel sentence is what keeps an undischarged cancel out of the retry-safe bucket.

The coupling fails closed and fails on their side: reword any of these and their classifier silently stops firing — no exception, no log line — and writes that used to be retried are simply lost. Nothing in this repository would turn red, because nothing here knows the wording is load bearing. Two consequences, and this ticket addresses both:

1. Whoever is about to edit these sites has no way to know the hazard. Marking the sites is cheap.
2. A consumer should not have to parse prose at all. The step that failed is a fact we know and do not say. Saying it as a field is the fix.

The plan ticket this comes from established, against the current tree, that nothing **in this repository** reads these sentences except one assertion in `network-transactor.spec.ts`, so the messages are free to carry on unchanged indefinitely.

# What to build

## A typed aggregate carrying the phase

New module `packages/db-core/src/transactor/peers-incomplete-error.ts`, exported from `packages/db-core/src/transactor/index.ts` (which the package root barrel already re-exports):

```ts
/** Which operation of a network transaction the aggregate came from. */
export type TransactorPhase = 'get' | 'pend' | 'commit' | 'cancel';

export class PeersIncompleteError extends Error {
	readonly phase: TransactorPhase;
	constructor(phase: TransactorPhase, message: string, cause?: Error) { … }
}
```

The constructor takes the message already composed at each site, sets `name`, and sets **both** `cause` and the `AggregateError`-shaped `errors` array (`cause ? [cause] : []`) for every phase.

Four things the class's doc comment must say, because each is a fact a reader will otherwise get wrong:

- **The messages are a downstream contract.** `Some peers did not complete:` on the `get`/`pend`/`commit` phases, its absence on `cancel`, and the disjoint `[block:` / `[blocks:` tokens are what sereus's `control-write-retry.ts` classifies on. Keep all four byte-identical; point new consumers at `phase`.
- **`phase: 'get'` is a protocol fault, not unreachability.** That aggregate is raised only when some coordinator responded and left a requested block out. A read that failed because nobody answered is `BlockUnavailableError` with reason `peers-unreachable`, a different error entirely. A consumer that reads `'get'` as "the cohort is away" would be wrong.
- **Local only.** This error is thrown by the writer's own transactor and never crosses the repo protocol, so unlike `PromiseShortfallError` it needs no wire type and no `toFailure`.
- **The per-peer detail stays prose.** NOTE-tagged tripwire: nobody needs the per-batch statuses as data today, and the four renderers do not share a status vocabulary (`response`/`no-response`/`in-flight` at `get`, `non-success` at `pend` and `commitBlocks`, `responded` at `dischargeCancel`), so structuring them means first agreeing on one. If a consumer ever needs the peers as data, unify the vocabulary then rather than exporting four shapes.

## The four sites

In `packages/db-core/src/transactor/network-transactor.ts`, replace `new Error(...)` with `new PeersIncompleteError(<phase>, <same message>, rootCause)` at the aggregate in each of `get` (`phase: 'get'`), `pend` (`'pend'`), `commitBlocks` (`'commit'`) and `dischargeCancel` (`'cancel'`). The composed message string does not change at any of them. The manual `(aggregate as any).cause = …` and `(aggregate as AggregateError).errors = …` lines go away, the constructor doing both.

Add a one-line `NOTE:` at each site. At the three `Some peers did not complete:` sites, that this sentence and the `[block:`/`[blocks:` token are a downstream retry discriminator and must not be reworded — see `PeersIncompleteError`. At `dischargeCancel`, the sharper one: **do not give this aggregate the `Some peers did not complete:` prefix**, for consistency or any other reason — that sentence is the consumer's discriminator, and adopting it here would make an undischarged cancel classify as safe to retry. This is the comment that earns its keep: it is exactly the tidy-up that looks harmless in review.

`pendMany` and `commitMany` build no aggregate of their own (a throw there returns `undefined` so the caller's per-request path retries, and a refusal goes through `refusalFrom`), so there is nothing to change in either. Stated so nobody hunts for a fifth site.

## The classifier stays as it is

`classifyCommitFailure` in `packages/db-core/src/transaction/commit-failure-class.ts` must keep sorting these aggregates as `unknown`. It would now be *able* to sort them by `phase`, and deliberately does not: the arms mean different things for the offline drain (a pend-phase transport failure stored nothing; a commit-phase one is in doubt), and picking that mapping is a decision about drain behaviour, not a rename. Record it as a NOTE-tagged tripwire in the function's doc comment, with the condition: *if* the drain needs to tell a pend-phase transport failure from a commit-phase one, sort on `phase` there rather than widening the "never walk `cause`" rule.

While in that doc comment, fix the wording that this change makes false: it calls the aggregate "the transactor's plain `Some peers did not complete` aggregate", and it is no longer plain.

## Docs

- `docs/offline-sync.md` §Classifying an attempt's outcome has the same "plain … aggregate" phrasing. Name `PeersIncompleteError` and its `phase` field, and say that it still sorts as `unknown` on purpose.
- `docs/internals.md` mentions the aggregate twice — in the pend-shortfall bullet of §Consensus Execution and in the third-producer paragraph of §Read Path. Name the class where it reads naturally. Do not add a section; this is a class, not a subsystem.

# Edge cases & interactions

- **Every message byte-identical.** The one in-repo reader is the `/^Some peers did not complete/` assertion in `network-transactor.spec.ts`; verified by keeping that assertion and by `grep -rn "Some peers did not complete" packages docs` after the change.
- **`cancel` must not acquire the shared prefix.** Verified by the site NOTE plus the grep above (the cancel sentence must still be the only one of the four that does not match).
- **`errors` is now set where it was not.** `get` and `commitBlocks` previously set only `cause`. The sole reader is db-p2p's `logger.ts` aggregate formatter, which will now print the root cause as a nested line for those two phases as it already does for `pend` and `cancel`. A logging change only; by inspection.
- **The classifier must not start walking `cause`.** Its existing rule exists because a commit-phase shortfall arrives nested as `cause`, and walking it would sort an in-doubt write as "nothing sent". Pinned by the existing `commit-failure-class.spec.ts` row (see Tests).
- **Two copies of db-core.** `instanceof PeersIncompleteError` fails across duplicate installs, exactly as every other class the classifier matches does; the hazard is already documented on `classifyCommitFailure`. Nothing new; by inspection.
- **Barrel cycle.** The new module must not import the package root barrel or `transactor/index.js` at runtime — `barrel-import-cycle.spec.ts` enforces it. It needs no imports beyond its own declarations, so this is only a thing not to do.
- **A consumer that catches `Error` and reads `message`** keeps working unchanged; the class is a strict widening. By inspection.

# Tests

No new test. Two existing ones change, both for free:

- `packages/db-core/test/network-transactor.spec.ts`, "fails the whole read when a coordinator responded without a requested block": keep the message assertion, and add that the thrown error is a `PeersIncompleteError` with `phase === 'get'`.
- `packages/db-core/test/commit-failure-class.spec.ts`, the "an aggregate whose cause is a shortfall" row: build a real `PeersIncompleteError` with `phase: 'commit'` instead of a hand-rolled `new Error('Some peers did not complete', { cause })`, still expecting `unknown`. The test's whole point is the "never walk `cause`" rule; pinning it against the real class is what makes it faithful, and it is what would fail if someone later added a phase arm.

The `pend`, `commit` and `cancel` phase values are a constant per site with no branching, so they are verified by inspection rather than by three new specs.

# Handoff must say

That `PeersIncompleteError.phase` now exists and is the replacement for sereus's text matching, that every message is unchanged so nothing of theirs breaks today, and that the sereus-side change (branch on `phase`, stop matching the sentence) is theirs to make when they choose. The garden report's standing note — "do not reword the `Some peers did not complete:` aggregates or merge the `[block:` and `[blocks:` forms" — still holds after this ticket and should keep holding.

# Sibling

`debt-an-exhausted-write-names-the-rival-holding-its-blocks` is the other half of the parent ticket and also edits `network-transactor.ts` (in `refusalFrom`, not in the four aggregates) and the same two documents. No ordering dependency; whichever runs second should re-read those files rather than assume the regions it saw.

# TODO

- Add `packages/db-core/src/transactor/peers-incomplete-error.ts` with `TransactorPhase` and `PeersIncompleteError`, carrying the four doc-comment facts above; export from `transactor/index.ts`.
- Replace the aggregate construction in `get`, `pend`, `commitBlocks` and `dischargeCancel` with the class, messages unchanged, dropping the hand-set `cause`/`errors` lines.
- Add the site `NOTE:`s — three "do not reword", one "do not adopt the prefix" at `dischargeCancel`.
- Add the "could sort on `phase`, deliberately does not" tripwire to `classifyCommitFailure`'s doc comment and fix its "plain aggregate" wording.
- Update `docs/offline-sync.md` §Classifying an attempt's outcome and the two `docs/internals.md` mentions to name the class.
- Extend the `network-transactor.spec.ts` get-aggregate assertion; rebuild the `commit-failure-class.spec.ts` row against the real class.
- `grep -rn "Some peers did not complete" packages docs` and confirm the three sentences are unchanged and the cancel sentence still does not match.
- `yarn build`, `yarn lint`, `yarn lint:docs`, `yarn typecheck`; db-core suite.
