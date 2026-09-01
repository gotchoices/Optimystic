description: The rule deciding which of two competing writes to a shared block wins was buried in a 2600-line file; it now lives in its own small module with its own tests. No behaviour changes.
files: packages/db-p2p/src/cluster/race-resolution.ts, packages/db-p2p/src/cluster/record-operations.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-repo.spec.ts, docs/optimystic.md
difficulty: medium
----

# Review: extract race resolution out of `ClusterMember`

Pure code move, implemented as specified. Two new sibling modules under
`packages/db-p2p/src/cluster/`; `cluster-repo.ts` keeps `findConflict` and now imports the free
functions.

## What landed

**New `record-operations.ts` (55 lines)** — `getAffectedBlockIds` and `getActionId`, bodies moved
verbatim. Imports only `blockIdsForTransforms` and the `RepoMessage` type from `@optimystic/db-core`.

**New `race-resolution.ts` (151 lines)** — `approvalCount`, `resolveRace`, `recordPriority`,
`operationsConflict`. Bodies moved verbatim; the ~70-line safety comment on `resolveRace` came across
intact (only re-wrapped at two points where the `{@link}`→prose substitution pushed lines past ~110
columns). `const log = createLogger('cluster-member')` — same sub-namespace as `cluster-repo.ts`, so
the `cluster-member:conflict-detected` tag is byte-identical.

**`cluster-repo.ts` 2614 → 2439 lines** (`wc -l`, measured after the change). Six methods deleted;
`findConflict`'s body otherwise untouched (self-skip, 2000 ms staleness sweep, `Array.from` snapshot,
`clearTransaction`+`continue` on a loser, `{ blockedBy }` return, all log lines). `deriveExpectedClusterView`'s
call now uses the imported `getAffectedBlockIds`. **One extra change beyond the ticket:** `clampPriority`
became unused in `cluster-repo.ts` once `recordPriority` moved out, so it was dropped from the
`@optimystic/db-core` import list — otherwise the build would carry a dead import. Nothing else in that
import line changed.

**`test/cluster-repo.spec.ts`** — `raceOf` helper and its `as unknown as` cast deleted; `resolveRace`
imported from `../src/cluster/race-resolution.js`; all 15 call sites substituted. Assertions and their
messages untouched. `clusterMemberInstance` left in place (still used at 68 other sites in the file).

**`docs/optimystic.md:288`** — `cluster-repo.ts` → `race-resolution.ts`, one line, nothing else in the
file touched. `docs/correctness.md` needed no change (names the symbols without a path).

Neither module was added to `src/index.ts` or `src/rn.ts`, per the ticket.

## Verification run

- `grep -rn "function getAffectedBlockIds" packages/` → **exactly one hit**
  (`record-operations.ts:17`).
- `grep -rn "raceOf" packages/db-p2p/test/cluster-repo.spec.ts` → no hits.
- `grep -rnE "ClusterMember\.approvalCount|this\.resolveRace|this\.operationsConflict|this\.getActionId|this\.getAffectedBlockIds" packages/db-p2p/src/` → no hits.
- No import cycle: neither new module imports from `cluster-repo.ts` (only prose mentions of the
  filename in comments).
- `yarn workspace @optimystic/db-p2p build` → exit 0, both modules emitted to `dist/`.
- `yarn workspace @optimystic/db-p2p test` → **2444 passing, 49 pending, 0 failing** (57s). Log at
  `tickets/.logs/debt-cluster-member-race-logic-has-no-home.test.log`. Note the package's mocha
  reporter is `min`, so that log shows only the summary — targeted runs below confirm the specific
  files.
- Targeted: `--grep "priority-aged race resolution"` on `cluster-repo.spec.ts` → **9 passing**
  (the ticket said "a dozen-odd"; the actual count in that describe block is 9 tests / 15 assertions).
- Targeted: `cluster-membership-admission.spec.ts` + `mesh-partition-admission.spec.ts` → **47 passing**,
  confirming the `cluster-member:*` log namespace still matches their capture assertions.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## What a reviewer should check hardest

- **Is it actually verbatim?** The high-value check is `git diff` on the deleted block in
  `cluster-repo.ts` against the two new files — the bodies were extracted with `sed` and de-indented
  one tab, then patched only at the declaration lines and the `this.`/`ClusterMember.` call prefixes.
  Worth eyeballing that no logic line drifted, particularly `recordPriority`'s fail-closed
  `op.pend.validation?.transaction?.priority ?? op.pend.priority` chain and `getAffectedBlockIds`'s
  five operation arms (`get` / `pend` / `commit` / `cancel` / `invalidate`).
- **Doc-comment substance.** `getAffectedBlockIds`'s comment kept its two-consumers-one-definition
  argument and now names the admission gate in prose rather than via a `{@link}` that would no longer
  resolve. The ticket predicted `{@link findConflict}` appeared **twice** in `resolveRace`'s comment;
  it appeared **once** (`recordPriority`'s comment already referenced `findConflict` in prose, and that
  prose reference was given the `cluster-repo.ts` filename too). `{@link recordPriority}` was left as a
  link — it still resolves, both symbols now being in the same module.
- **Module-level doc placement.** Each new file opens with a `/** ... */` block above its imports as a
  file header. That is a deliberate choice so it does not attach to the first exported symbol; if the
  repo has a different convention for file-level docs, this is the spot to say so.

## Known gaps — deliberately not done

- **No new tests.** The ticket scoped them out. The value claimed is only that the existing 9 race
  tests stop depending on a private-method cast. So the new modules have no test of their own for
  `approvalCount`, `recordPriority`, `operationsConflict`, `getAffectedBlockIds` or `getActionId`
  in isolation — those are still only exercised transitively (`operationsConflict` and
  `getAffectedBlockIds` through `findConflict`/admission specs; `getActionId` only through
  `operationsConflict`). Now that they are directly importable, adding direct unit tests is cheap;
  that would be a follow-up ticket, not a finding against this one.
- **Integration specs not run** — env-gated, out of scope per the ticket.
- **`findConflict` is still untested directly** for its side-effect ordering (stale sweep before
  conflict test; clear-and-continue on a loser). That was true before this change and is unchanged by
  it; the move did not make it easier or harder to test, since `findConflict` stayed private.
