description: The rule deciding which of two competing writes to a shared block wins was buried in a 2600-line file; it now lives in its own small module with its own tests. No behaviour changes.
files: packages/db-p2p/src/cluster/race-resolution.ts, packages/db-p2p/src/cluster/record-operations.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/race-resolution.spec.ts, packages/db-p2p/test/record-operations.spec.ts, packages/db-p2p/test/cluster-repo.spec.ts, docs/optimystic.md
----

# Complete: extract race resolution out of `ClusterMember`

A pure code move plus, from the review pass, direct unit tests for the extracted functions.

## What landed

**`packages/db-p2p/src/cluster/record-operations.ts`** — `getAffectedBlockIds` (every block id a
message's operations name) and `getActionId` (the action a message names, if any). Free functions,
no member state.

**`packages/db-p2p/src/cluster/race-resolution.ts`** — `approvalCount`, `resolveRace`,
`recordPriority`, `operationsConflict`: the deterministic rule picking a winner between two writes
that want the same block, with the ~70-line safety argument that justifies its ordering carried
across intact.

**`packages/db-p2p/src/cluster/cluster-repo.ts`** — 2614 → 2439 lines (`wc -l`). Six methods
deleted; `findConflict`, the stateful scan that consults them, stays. `clampPriority` was dropped
from the `@optimystic/db-core` import list, having become unused there.

**Tests** — `cluster-repo.spec.ts`'s 9 race tests dropped the `as unknown as` cast into a private
method and now import `resolveRace` directly. The review pass added `test/race-resolution.spec.ts`
and `test/record-operations.spec.ts` (27 tests).

**`docs/optimystic.md:288`** — the `resolveRace` path now cites `race-resolution.ts`.

Neither new module is exported from `src/index.ts` / `src/rn.ts` — both are internal to the package.

## Review findings

### Verified — the move is faithful

The high-risk claim was "verbatim". Checked mechanically, not by eye: every deleted code line from
`cluster-repo.ts` and every code line in the two new files were normalized (leading indentation,
`this.` / `ClusterMember.` prefixes, `private` / `static` / `export` modifiers stripped), sorted, and
diffed. **Identical** — no logic line drifted, including `recordPriority`'s fail-closed
`op.pend.validation?.transaction?.priority ?? op.pend.priority` chain and `getAffectedBlockIds`'s
five operation arms. Only ordering changed (`getActionId` now follows `getAffectedBlockIds`).

Also confirmed: the log namespace is byte-identical — both files construct
`const log = createLogger('cluster-member')`, and `createLogger` adds a suffix only when passed a
peer id, which neither does. `findConflict`'s body is unchanged (self-skip, 2000 ms stale sweep,
`Array.from` snapshot, clear-and-`continue` on a loser, `{ blockedBy }` return). No import cycle:
`race-resolution` → `record-operations` → `db-core`, and `logger.ts` imports only `debug`. The
`clampPriority` import removal is correct and `blockIdsForTransforms` was correctly *kept* in
`cluster-repo.ts` (still used at line 1368).

### Fixed in this pass (minor)

- **`getActionId`'s new doc comment described semantics the type forbids.** It claimed the function
  "returns the FIRST match and stops, with `pend` / `commit` / `cancel` precedence within a single
  operation" — but `RepoMessage.operations` is a **one-element tuple** of a single-key union, so
  neither the multi-operation scan nor the within-operation precedence can ever be observed. A
  reader would have taken it as evidence that multi-operation messages are supported and ordered.
  Rewritten to state the contract that is actually load-bearing: `pend` / `commit` / `cancel` carry
  an id, `get` and `invalidate` do not — and an `invalidate` deliberately does **not** surface its
  `invalidatedActionId`, because that names the action being *reversed*, so surfacing it would tell
  `operationsConflict` that an invalidation and the pend it reverses are "the same action" and need
  not serialize. That is now pinned by a test.
- **`operationsConflict` became an exported symbol with no doc comment.** Added one covering the
  non-obvious part — the same-action escape exists so a commit can follow its own pend, since both
  name every block the action writes and a bare overlap test would have each transaction block its
  own next phase.
- **The module header over-claimed purity.** It said "every function here is pure and total";
  `operationsConflict` emits a `debug` line. Reworded to "a total function of its arguments, with no
  member state and no effect beyond a debug log", and pointed at the new spec.
- **No direct tests for the newly-importable functions.** The implement handoff flagged this
  honestly and scoped it out; it is cheap now that the functions are importable, so it was done here
  rather than deferred. 27 tests added across two files: every `getAffectedBlockIds` arm
  (get / pend / commit / cancel / invalidate), dedup, and empty transforms; every `getActionId` arm
  including the two that yield `undefined`; `approvalCount` ignoring both `reject` **and** `conflict`
  votes; `recordPriority`'s two carriers, their precedence, over-cap clamping, and negative/`NaN`
  collapse; `operationsConflict`'s overlap, disjoint, same-action-escape and symmetry cases; and one
  `resolveRace` case the existing suite lacked — a record holding only a **conflict** vote must not
  outrank a fresh rival (the existing suite covered the `reject` variant only, and `conflict` is the
  third variant that occupies a `promises` key).

### Filed as a new ticket (one)

`tickets/backlog/debt-conflict-scan-side-effects-are-untested.md` — `ClusterMember.findConflict`
has no direct test of its side-effect ordering (stale sweep before the contest; clear-and-`continue`
rather than `break` on a loser; returning the blocking record's identity, which becomes the vote's
`conflictWith`). Pre-existing and untouched by this change, but this ticket is what made the
distinction visible: the *pure* half of that path now has direct tests and the *stateful* half still
has none. Filed at the "generalized test" rung rather than as a point bug — there is no bad state to
make unrepresentable here, only an untested effect ordering. It is not trivially fixable inline: the
method is private and its expiry threshold reads `Date.now()` against a hardcoded 2000 ms, so an
honest test needs injectable time, a multi-second wait, or a visibility change — and a cast into the
private method would re-introduce exactly the pattern this ticket removed.

### Checked, nothing to report

- **Docs.** `docs/optimystic.md` was correctly updated. `docs/correctness.md` (§Theorem 1 Case 2,
  §276–286) and `docs/partition-healing.md` name `resolveRace()` / `operationsConflict()` **without
  a file path**, so both remain accurate. `docs/review.html:187` does cite
  `cluster-repo.ts:1142-1156` for `resolveRace`, but that reference was already wrong before this
  change (at the parent commit `resolveRace` sat at line 2303) and the file is a point-in-time review
  snapshot, so it was deliberately left alone. No doc in the tree enumerates the `cluster/`
  directory's modules, so nothing needed the two new filenames added.
- **Duplicate definitions.** `getAffectedBlockIds`'s comment insists on one definition; grep found no
  second one. The other per-operation switches (`cluster/client.ts:113`, `repo/client.ts:149`,
  `repo/service.ts:210`) pick a single *routing anchor*, not the affected set — a different question,
  documented as such at each site.
- **API surface.** `approvalCount` and `recordPriority` are exported but consumed only within
  `race-resolution.ts` and the new tests. Considered and left: making the individual comparison keys
  testable is the point of the extraction, and both are internal to the package (neither module is
  re-exported from `src/index.ts`).
- **Tripwires.** None recorded — nothing found in this diff was of the "fine now, breaks if X later"
  shape. The findings above are either present-tense defects (fixed) or a present-tense coverage gap
  (ticketed).
- **Accepted tradeoffs.** No `NOTE: accepted tradeoff` markers sit at any site touched here, so no
  finding was suppressed on that basis.
- **`packages/db-p2p/dist/`** is untracked, so the emitted `.d.ts` files for the new modules are not
  in the diff.

## Verification

- `yarn workspace @optimystic/db-p2p build` → exit 0. The package `tsconfig.json` includes `test`, so
  this type-checks the new spec files too (the mocha loader only strips types, it does not check).
- `yarn lint` (root `eslint .`) → exit 0, no output.
- `yarn workspace @optimystic/db-p2p test` → **2471 passing, 49 pending, 0 failing** (58s) — 2444
  before, plus the 27 added here.
- New specs alone, `--reporter spec` → 27 passing.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
