description: When the machines responsible for a write have no space left, the offline write queue cannot tell what went wrong — it records the failure as unexplained and counts it on a health number that is documented as staying at zero in a healthy deployment. Give that refusal its own name, and add a test that catches the next write failure someone forgets to name.
architecture: docs/offline-sync.md
files: packages/db-core/src/transaction/commit-failure-class.ts, packages/db-core/src/offline/queue.ts, packages/db-core/src/network/cohort-out-of-space-error.ts, packages/db-core/test/commit-failure-class.spec.ts, packages/db-core/test/source-scan.ts, docs/offline-sync.md
difficulty: medium
repro: verified
----

# A full cohort's refusal reaches the offline drain unclassified

## What was reproduced

`classifyCommitFailure` (`packages/db-core/src/transaction/commit-failure-class.ts`) is the single place a failed write is sorted into what the caller should do about it, so that no caller has to read an error message to decide. It has no arm for `CohortOutOfSpaceError` (`packages/db-core/src/network/cohort-out-of-space-error.ts`), so that error falls through to `unknown`. Confirmed by running it: `classifyCommitFailure(new CohortOutOfSpaceError({ peerIds: ['peer-b', 'peer-c'], approvals: 1, peerCount: 3, needed: 3 }))` returns kind `unknown`.

The offline write queue treats `unknown` as a signal in its own right. `applyFailure` in `packages/db-core/src/offline/queue.ts` increments `unclassifiedFailures`, logs `offline:unclassified-failure`, and retries. `docs/offline-sync.md` states what that counter means — it "is zero in a correct deployment" — and the Quereus plugin surfaces it as a health reading for the same reason (`packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-status.ts`).

It is reachable from the drain, statically traced end to end. The drain submits through `Collection.commitHead` or `TransactionCoordinator.commitEntry` (`OfflineQueue.send`); a pend refused by full members raises the class by name in both paths — `AttemptCycle.recordRefusal` in `packages/db-core/src/collection/write-attempts.ts`, and `cleanFailureError` in `packages/db-core/src/transaction/coordinator.ts` — and whatever escapes a submission reaches `applyFailure`.

Nothing is lost or mis-stored: the write was never accepted by anyone, and `unknown`'s behaviour — keep the entry under its own identity and retry — is the safe answer. What is wrong is the reporting:

- the health counter documented as zero in a correct deployment rises, once per attempt, for an operational fact about the network rather than a defect of the deployment;
- an operator reading `offline:unclassified-failure` is told the classifier could not name the failure, when the failure is in fact named precisely, and is told nothing about *which* members are full even though the error names every one of them;
- the entry reports `waitingFor: 'backoff'` rather than `'cohort'`, the status that means "waiting for the machines to be ready".

Worth knowing about the likelihood: the refusal is not only a multi-machine condition. `CoordinatorRepo`'s solo path raises the same class when *this* node is itself out of storage (the `pend:solo-out-of-space` log in `packages/db-p2p/src/repo/coordinator-repo.ts`), so a single-machine deployment whose disk fills up walks the same unclassified path.

## Arm 1 — give the refusal its own class

Add a `cohort-out-of-space` arm to `CommitFailureClass`, carrying `CohortOutOfSpaceError`, and sort it in `classifyCommitFailure`. In the drain, map it to `queued` with `waitingFor: 'cohort'` and its own log line in place of `offline:unclassified-failure` — naming the full members, since the error carries them: `offline:cohort-out-of-space entry=<id> action=<id> peers=<peerIds> approvals=<n>/<needed>`.

**Why a new class rather than widening `cohort-unreachable`.** The ticket this came from offered widening as the near fit, so here is the argument for not doing it. `cohort-unreachable` means "too few of the cohort *answered*"; a full cohort answers clearly, and the two conditions need different action from whoever is watching — restore connectivity, versus add storage or shed data. Collapsing them would leave the drain unable to say which, and the only way back would be reading the error type at the call site, which is the exact thing this classifier exists to prevent. The cost of the split is small and the compiler finds all of it: `applyFailure`'s `switch` is exhaustive, and the `summarize` helper in `commit-failure-class.spec.ts` has a `never` default, so both fail the build until updated.

**No new `waitingFor` value, and no behaviour change from using `'cohort'`.** `EntryWaitingFor` in `packages/db-core/src/offline/status.ts` already has `'cohort'`, so the plugin's status surface and the state shape in `docs/offline-sync.md` stay as they are. And `'cohort'` cannot stall the entry: the drain loop asks the reachability gate at the top of *every* iteration regardless of `waitingFor`, and both `'cohort'` and `'backoff'` park on the same one timer (`OfflineQueue.drain`, `untilWokenOrTimer`). `waitingFor` is reported status, not retry mechanics.

Docs to update, both in `docs/offline-sync.md`: a row in the table under §Classifying an attempt's outcome, and the `applyFailure` transition table in the doc comment on the method itself. The counter sentence under §Guards that make idempotent writes assured ("zero in a correct deployment") needs no change — it becomes more true.

Finally, delete the `NOTE:` at the end of the class doc on `CohortOutOfSpaceError` that says the classifier has no arm for it and points at this ticket. The condition it describes is what this work removes.

## Arm 2 — the guard that keeps this from recurring

This is the second time the shape has come up. `PeersIncompleteError` carries a `phase` the classifier deliberately does not sort on, and now a whole error class was added to the write path with no arm here. Both were found by someone reading code, not by a failing check. This arm converts "someone must remember" into "the suite says so", and is worth doing even if arm 1's naming is argued over.

Add a guard to `packages/db-core/test/commit-failure-class.spec.ts`: scan the write-path source for error classes it constructs, and require each one to be either sorted or explicitly excused.

There is good precedent for a source-scanning test in this package — `test/no-fret-import.spec.ts` and `test/barrel-import-cycle.spec.ts`, which share the `tsFiles` helper in `test/source-scan.ts`. Follow its shape, including its self-test habit: a scan that silently stops matching becomes a guard that passes forever, so prove the detector still fires.

**Scan construction, not just `throw`.** A `throw new X(...)` scan has three holes, all of them real in this tree: `cleanFailureError` and `pendRefusalError` *return* errors the caller throws, `PeersIncompleteError` is raised through a static factory (`throw PeersIncompleteError.peersDidNotComplete(...)`), and `BlockTooLargeError` is constructed by a refusal helper and never thrown by name. Matching `new <Name>Error(` (plus `RecordAttemptFailed`, the one write-path class not named `*Error`) catches all three. Over-matching is the safe direction: each extra name costs one allow-list line.

**Scope** — the five directories whose throws can escape a submission to `applyFailure`, under `packages/db-core/src`: `collection/`, `collections/`, `transaction/`, `transactor/`, `network/`. Scanning all of db-core would drag in blob, queue-internal and wire errors and drown the allow-list. Excluding built-ins (`Error`, `TypeError`, `RangeError`, `AggregateError`) by name, that scope yields exactly 24 classes today, and every one of them is exported from the package barrel (verified by importing all of them in a throwaway spec), so a factory can construct any that needs one.

**Shape.** Two tables and one scan assertion:

- `SORTED: Record<string, () => unknown>` — a factory per class; assert `classifyCommitFailure(factory()).kind !== 'unknown'`. Only "not unknown" — the *specific* kind each class sorts to is already pinned by the existing `cases` table, and this guard should not duplicate that vocabulary. Note two classes where the factory's arguments matter: `BlockUnavailableError` sorts by its `reason` and only the two reachability reasons are non-`unknown` (an existing `cases` row pins the rest), and `TornActionError` sorts by `final`.
- `UNSORTED: Record<string, string>` — the allow-list, each entry a non-empty sentence saying why a human decided to leave it unsorted. Assert the reasons are non-empty so no one can quiet the guard with a bare name.
- The scan assertion: the set of class names found is equal to `keys(SORTED)` plus `keys(UNSORTED)`, **both directions**. Equality both ways is what makes it a guard — a new class fails until it is sorted or excused, and a class nobody constructs any more fails until its stale table entry is pruned.

The eight classes that belong on the allow-list today, with the reason each one is there:

| class | why it is not sorted |
|---|---|
| `SealedSegmentsError` | a broken queue invariant; `applyFailure` re-throws it before classifying, which stops the drain |
| `PeersIncompleteError` | the deliberate non-sort already documented on `classifyCommitFailure` — sorting on its `phase` is a decision about drain behaviour, not a rename |
| `PendRejectedError` | module-private to `coordinator.ts` and never escapes: `cleanFailureError` turns a clean stale loss into `CoordinatorStaleLossError` and anything else into a plain `Error` |
| `CoordinatorConcurrentStampError` | caller misuse (two writers sharing one coordinator), raised at statement time, never as a commit outcome |
| `CollectionHeaderVanishedError` | storage contradicted itself; a defect, and `unknown`'s retry-in-doubt is the conservative answer |
| `BlockPossiblyStaleError` | a read's doubt about currency, raised during refresh, not a write outcome |
| `TreeUpsertGuardKindError` | a malformed action — a caller bug — raised while staging, deliberately not a refusal |
| `TreeDeleteGuardKindError` | the delete-side mirror of the same check |

Two limits to state in the test's own comment rather than chase:

- A plain `throw new Error(...)` is the documented fail-fast for a hard coordinator failure and sorts as `unknown` on purpose; the scan excludes the built-ins by name, so the guard says nothing about it.
- The scan reads db-core only. db-p2p raises db-core's classes (which the scan sees) and sends everything else across the wire as a failure that the writer rebuilds into a db-core class, so a db-p2p-local error class cannot reach a remote writer's classifier by type. An in-process transactor is the one gap, and db-core's tests cannot import db-p2p without breaking the package layering the other guard specs enforce.

Keep this in `commit-failure-class.spec.ts` rather than its own file, even though the other source-scanning guards have their own: the allow-list reasons are part of the classifier's contract and belong where a reader meets its behaviour cases.

## TODO

### Phase 1 — the arm

- Add `{ kind: 'cohort-out-of-space'; error: CohortOutOfSpaceError }` to `CommitFailureClass` in `packages/db-core/src/transaction/commit-failure-class.ts`, with a bullet in the type's doc comment saying nothing was stored and what clears it is the members shedding data or gaining space.
- Sort it in `classifyCommitFailure` with an `instanceof` arm.
- Add the `cohort-out-of-space` case to `applyFailure` in `packages/db-core/src/offline/queue.ts`: queue it waiting for the cohort, return that it stays queued, and log `offline:cohort-out-of-space` naming the full members.
- Update the transition table in `applyFailure`'s doc comment.
- Delete the stale `NOTE:` at the end of the class doc in `packages/db-core/src/network/cohort-out-of-space-error.ts`.
- Add the row to the §Classifying an attempt's outcome table in `docs/offline-sync.md`, and a sentence in that section's prose saying why this is its own row rather than `cohort-unreachable`.
- Add the behaviour case to the `cases` table in `packages/db-core/test/commit-failure-class.spec.ts` and the arm to `summarize`.

### Phase 2 — the guard

- Add the scan, `SORTED` factories, and the `UNSORTED` allow-list with its eight reasons to `packages/db-core/test/commit-failure-class.spec.ts`, reusing `tsFiles` from `test/source-scan.ts`.
- Assert the found set equals `SORTED` plus `UNSORTED` in both directions, assert the scanned file list is non-empty, and assert every allow-list reason is non-empty.
- Add the detector self-test: snippets proving the matcher fires on the construction forms this tree uses (a plain `new X(`, a multi-line `new X(`, a class constructed in a `return` rather than a `throw`) and does not fire on the excluded built-ins.
- Write the two scope limits above into the test's doc comment.

### Validation

- `yarn workspace @optimystic/db-core exec node --import ./register.mjs node_modules/mocha/bin/mocha.js test/commit-failure-class.spec.ts --reporter spec` — the reproduction and the new guard.
- `yarn workspace @optimystic/db-core typecheck` — the exhaustive `switch` in `applyFailure` and `summarize`'s `never` default are the point of this check.
- `yarn lint:docs` — `docs/offline-sync.md` is edited and the citation checker validates the paths and anchors in it.
