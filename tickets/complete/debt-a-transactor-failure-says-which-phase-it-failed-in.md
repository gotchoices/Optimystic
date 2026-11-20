description: A read or write that fails because some machines did not answer now carries a field naming which step failed, instead of only saying so inside an English sentence. Every error message is unchanged, so anything reading the text today keeps working.
architecture: docs/offline-sync.md#classifying-an-attempts-outcome
files: packages/db-core/src/transactor/peers-incomplete-error.ts (new), packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/index.ts, packages/db-core/src/transaction/commit-failure-class.ts, packages/db-core/src/network/promise-shortfall-error.ts, packages/db-core/test/network-transactor.spec.ts, packages/db-core/test/commit-failure-class.spec.ts, packages/db-core/test/owed-cancel.spec.ts, docs/offline-sync.md, docs/internals.md
----

# What landed

`NetworkTransactor` built four "not every peer answered" aggregates as plain `Error`s distinguished only by their wording. They are now one typed class, `PeersIncompleteError`, carrying a readonly `phase` of `'get' | 'pend' | 'commit' | 'cancel'` — the field a consumer reads instead of the sentence. Every one of the four messages is byte-identical to what the transactor threw before, so nothing that parses them today changes behaviour.

`packages/db-core/src/transactor/peers-incomplete-error.ts` holds `TransactorPhase` and the class, exported through `transactor/index.ts` and so through the package root as `@optimystic/db-core`'s `PeersIncompleteError`. The class also *composes* the messages, through two static factories with a private constructor:

- `PeersIncompleteError.peersDidNotComplete(phase, details, cause?)` builds `Some peers did not complete: <details>` with the shared `; root: <message>` tail. Its `phase` parameter is `Exclude<TransactorPhase, 'cancel'>`, so the shared sentence cannot reach a cancel.
- `PeersIncompleteError.cancelNotDischarged(actionId, outstanding, details, cause?)` builds the cancel's own sentence, then `; peers: …`, then the same root tail.

Callers still render their own per-peer `details`, which is where the `[block:` / `[blocks:` tokens live. The four sites are the aggregate in `get` (~line 465), `pend` (~830), `commitBlocks` (~1415) and `dischargeCancel` (~1630); `pendMany` and `commitMany` build no aggregate of their own and were not touched.

Why the message shapes are pinned at all: a downstream repository outside this tree (sereus `control-write-retry.ts`) decides which of our failures are safe to re-present by pairing the sentence `Some peers did not complete:` with the singular `[block:` token. `'get'` and `'pend'` carry both; `'commit'` carries the sentence but renders the plural `[blocks:`; `'cancel'` renders `[block:` but has a different sentence, so for a cancel the *absence* of the shared sentence is the whole discriminator. That is why the type refuses `'cancel'` on the shared factory, and why each site keeps a one-line `NOTE:` about its own token.

`classifyCommitFailure` still sorts all four as `unknown`, and its doc comment says that is deliberate now that a `phase` exists to sort on, with the condition under which to revisit. `docs/offline-sync.md` §Classifying an attempt's outcome and `docs/internals.md` (the pend-shortfall bullet of §Consensus Execution, the third-producer paragraph of §Read Path) name the class and its `phase`.

# Review findings

**Read first, handoff second.** The implement diff (`ticket(implement): debt-a-transactor-failure-says-which-phase-it-failed-in`) was read before the handoff prose, and its two load-bearing claims were re-verified rather than taken on trust:

- *Every message byte-identical.* Confirmed by running the built factories and comparing the output to the pre-change templates character for character, in all four shapes including the cancel's optional `; peers:` arm: `Some peers did not complete: peer-a[block:b1](no-response); root: boom`, `Cancel of action X did not discharge 2 block(s): b1, b2; peers: …; root: boom`, and both with the root cause absent.
- *Log output unchanged for all four phases.* The handoff corrected its own ticket here, and the correction is right: `isAggregateError` at `packages/db-p2p/src/logger.ts:121` admits only a real `AggregateError` or one whose `name` is literally `'AggregateError'`, and `PeersIncompleteError` is neither, so `printError` never nested the old plain-`Error` aggregates' `errors` and does not nest these. The ticket's prediction that two phases would start printing a nested root cause was wrong; the handoff's version is what the code does.

**Also checked, nothing wrong found.** That the `'get'` aggregate really is the protocol-fault path and not unreachability — it is raised under `omittedIds.length > 0` (a coordinator answered and left a requested block out) while the `unansweredIds` path below flags `'peers-unreachable'` and returns, so the class doc's second fact holds. That no fifth aggregate was missed (`grep -rn "Some peers did not complete\|did not discharge" packages/ docs/` finds the four sites and their documentation, and the only remaining `new Error(` calls in the file are argument guards and an `asError` coercion). That the new module adds no runtime import — its two imports are clause-level `import type`, which `barrel-import-cycle.spec.ts` exempts and which erase under `verbatimModuleSyntax`. That every document the change touches, and `commit-failure-class.ts`'s doc comment, describe the tree as it now is.

**Minor findings, all fixed in this pass:**

- *The pinned sentence was copied at three sites.* The shared sentence and the `; root:` tail were composed inline at `get`, `pend` and `commitBlocks`, each under its own near-identical three-line "do not reword" comment, and the load-bearing *absence* of that sentence on `cancel` was guarded by a comment alone. Composition moved into the two factories above with a private constructor, so the literal exists once and `peersDidNotComplete` cannot be handed `'cancel'` — a type error where there was a comment someone could overrule. The per-site `NOTE:`s now cover only each site's own token, which is still rendered at the site.
- *The class doc overstated the token split.* It described the `[block:` / `[blocks:` tokens as "disjoint", which reads as one token per phase. `dischargeCancel` renders `[block:` too (`network-transactor.ts:1626`), so a reader following that sentence would conclude a cancel is in the retry-safe bucket. Rewritten to say which phase carries which half and that for `'cancel'` the missing sentence is the whole discriminator.
- *A double cast on a public field.* `(this as unknown as AggregateError).errors = …` is now a declared `readonly errors: readonly Error[]` field, with the reasoning (no reader today; set on every phase because two of the four sites set it before the class existed) in its own doc comment rather than inside the constructor body. Keeping the field is right — removing it would take a property away from the two phases that already had it, and this ticket exists to not change what downstream sees.
- *A dead ticket citation in two places.* `docs/offline-sync.md` and `packages/db-core/src/network/promise-shortfall-error.ts` both cited `backlog debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text`. That is the parent ticket that split into this one and `debt-an-exhausted-write-names-the-rival-holding-its-blocks`; it is in no stage folder and has no record in `tickets/.pruned-tickets.jsonl`, so both citations pointed at nothing. Both parentheticals dropped — each sentence's rule ("decide from error types, never from message text"; "test for this class rather than for the text") stands on its own, and offline-sync's next paragraph now names the typed discriminator the parent was asking for.

**Major findings: none.** No ticket was filed. The one structural concern worth having — the pinned-literal duplication — met the top of the ladder (make the bad state unrepresentable) and was cheap enough to fix here, so there was nothing left to file.

**Tripwires: none newly recorded.** The implementer's two were re-read and both still hold as written: the per-peer detail stays prose until a consumer needs the peer statuses as data (the four renderers do not share a status vocabulary), and `classifyCommitFailure` could sort on `phase` and deliberately does not (revisit if the offline drain needs to tell a pend-phase transport failure from a commit-phase one).

**Noticed and deliberately not filed:** `network-transactor.ts` is 1937 lines (`wc -l`), down four from the implement commit. No open ticket claims it as size debt (grep over `tickets/backlog`, `fix`, `plan`, `implement`, `review`), but a split serves no anchor this release names and this change shrank the file rather than growing it, so filing would be queue length without a decision behind it.

**Tests.** None cut: nothing in the diff restated the implementation or asserted against a mock. One assertion pair added and one row rebuilt, no new test file:

- `packages/db-core/test/owed-cancel.spec.ts` — the existing undischarged-cancel case asserted only `instanceOf(Error)`; it now asserts `instanceOf(PeersIncompleteError)` and `phase === 'cancel'`. `'cancel'` is the phase whose distinction is load-bearing downstream and the only one left unverified in-repo (`'get'` is pinned in `network-transactor.spec.ts`, `'commit'` in `commit-failure-class.spec.ts`; `'pend'` is a constant with no branching and stays verified by inspection).
- `packages/db-core/test/commit-failure-class.spec.ts` — the "aggregate whose cause is a shortfall" row builds through `peersDidNotComplete` now that the constructor is private, with a realistic `details` string, and still expects `unknown`. The row exists for the "never walk `cause`" rule and is what would fail if someone gave `classifyCommitFailure` a `phase` arm.

# Commands run

Full suites, after the fixes above, all from the repo root:

- `yarn workspace @optimystic/db-core test:verbose` — 2121 passing
- `yarn workspace @optimystic/db-p2p test:verbose` — 3829 passing, 84 pending
- `yarn workspace @optimystic/quereus-plugin-optimystic test:verbose` — 1429 passing, 14 pending
- `yarn workspace @optimystic/db-p2p test:integration` — 60 passing, 2 pending (run because the change sits in the network write path)
- `yarn lint`, `yarn typecheck`, `yarn lint:docs` (49 documents, 842 anchored citations, 906 file mentions, 814 links — all resolve), `yarn lint:deps` (1281 files across 13 packages), `yarn check:rn` (Metro bundle 17.9s, Hermes compile 11.3s — the `multiformats` subpath warnings are pre-existing and unrelated)
- `yarn build` in `packages/db-core`

No failures, and none pre-existing to report.

# Handoff to the downstream repository

`PeersIncompleteError.phase` replaces sereus `control-write-retry.ts`'s text matching: `'get'` and `'pend'` are the retry-safe arms its `Some peers did not complete:` + `[block:` conjunction selects today, `'commit'` is what its `[blocks:` exclusion drops, and `'cancel'` is the undischarged cancel its differing-sentence check keeps out. Every message is unchanged, so nothing of theirs breaks; branching on `phase` and dropping the sentence match is theirs to do when they choose.

The standing instruction — do not reword the `Some peers did not complete:` aggregates, and do not merge the `[block:` and `[blocks:` forms — still holds until that downstream change lands. It is now recorded at each of the four sites and, for the sentence itself, enforced by the single factory that composes it.

# Sibling

`debt-an-exhausted-write-names-the-rival-holding-its-blocks` is the other half of the parent ticket and was still in `implement/` when this ran. It edits `network-transactor.ts` (`refusalFrom`, a different region) and `docs/offline-sync.md` §Classifying an attempt's outcome — the same section whose dead-slug parenthetical this review dropped, so it should re-read that file rather than work from the text it was planned against.
