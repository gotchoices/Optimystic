description: One source file holds the entire behaviour of a cluster node — over two and a half thousand lines in a single class — so the part that decides which of two competing writes wins is buried among storage, signatures, membership and recovery code, and is hard to read, review, or test on its own.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-repo.spec.ts
difficulty: medium
----

# The race-resolution logic deserves its own module

`packages/db-p2p/src/cluster/cluster-repo.ts` is **2614 lines**
(`wc -l packages/db-p2p/src/cluster/cluster-repo.ts`, measured 2026-09-01), almost all of it one
class, `ClusterMember`. That one class covers: the two-phase protocol state machine, signature
signing and verification, membership admission, block storage application, consensus certificates,
invalidation, persistence and restart recovery, expiration timers — and conflict/race resolution.
(The file was 2200 lines when this was first filed and 2034 before that; it grows every ticket,
which is the trend the split is meant to arrest for at least this one concern.)

No behaviour is wrong. The cost is that the piece a reader most often needs to reason about in
isolation has nowhere to live on its own.

## The seam

Race resolution is nearly self-contained and unusually heavily documented — the safety argument for
its ordering runs to roughly seventy lines of comment and mirrors `docs/correctness.md` §Theorem 9.
Current members, with line numbers as of this writing:

| symbol | line | state it touches |
|---|---|---|
| `findConflict` | 2188 | reads and mutates `activeTransactions` (sweeps stale, clears losers) |
| `approvalCount` (already `static`) | 2248 | none — pure |
| `resolveRace` | 2303 | none — pure (calls `recordPriority`) |
| `recordPriority` | 2341 | none — pure |
| `operationsConflict` | 2354 | none — pure (calls `getActionId`, `getAffectedBlockIds`) |
| `getActionId` | 2385 | none — pure |
| `getAffectedBlockIds` | 2401 | none — pure |

Shape of the target: a new module beside `cluster-repo.ts` owning the pure arbiter and the pure
block-overlap tests, exported as plain functions. `findConflict` stays a method on `ClusterMember`
(it is the only one coupled to member state) and calls into the module.

## Constraints the design must respect

Two things the original filing of this ticket did not account for:

- **`getAffectedBlockIds` has a second consumer outside race resolution.** Line 1311 uses it for the
  membership-admission binding check (`deriveExpectedClusterView`) — the set a legitimate
  `coordinatingBlockIds[0]` must come from. Its own doc comment states the two consumers deliberately
  share one definition, and that if they ever disagreed a coordinator could name a block the record
  is not judged to touch. So the extraction must leave exactly **one** definition that both call.
  Duplicating it into the new module would silently re-open that hole.
- **`operationsConflict` depends on `getActionId`**, which the original filing did not list.
  `getActionId` has no other caller in the repo, so it moves with `operationsConflict`.

Everything the pure functions need from outside is already a plain import from `@optimystic/db-core`
(`blockIdsForTransforms`, `clampPriority`, and the `ClusterRecord` / `RepoMessage` types), so the new
module introduces no import cycle.

## Why it is worth doing

- The comment block explaining *why* the ordering is what it is currently sits in the middle of an
  unrelated 2500-line file; in its own module it would be the module's purpose.
- Every recent ticket in this area (`occ-priority-first-breaks-promise-monotonicity`,
  `abandoned-pend-holds-the-block`, `feat-occ-priority-reservation`) changes exactly these functions
  and nothing else in the file.
- The existing tests already reach in through a private-method escape hatch — `cluster-repo.spec.ts`
  line 1057 defines `raceOf()` as an `as unknown as {...}` cast purely to reach `resolveRace`, used
  by about a dozen assertions — because there is no public surface to test against. An extracted
  module would be directly importable, and that cast would be deleted rather than maintained.

## Expected behaviour after the change

Identical. This is a move, not a redesign: no ordering rule changes, no logging changes, no
signature or wire-format changes. The success criteria are that `db-p2p`'s existing suite passes
unmodified apart from the `raceOf()` cast being replaced by direct imports, and that
`getAffectedBlockIds` still resolves to a single definition shared with the admission gate.

## Not in scope

Splitting the rest of `ClusterMember`. The protocol state machine, storage application and recovery
paths share mutable member state and do not have a clean seam; carving them apart is a much larger
and riskier piece of work, and this ticket should not be read as a first step toward it.

Likewise not in scope: changing the 2-second staleness threshold, the aging/priority rules, or
anything `feat-occ-priority-reservation` covers.

## Sequencing

Nothing is in flight against this file in `fix/`, `plan/`, `implement/`, or `review/`
(checked 2026-09-01). Several `backlog/` tickets reference `cluster-repo.ts`
(`feat-occ-priority-reservation`, `feat-admission-floor-from-observed-cohort-high-water-mark`,
`feat-cluster-membership-threshold-cert-anchoring`, and others); of these only
`feat-occ-priority-reservation` touches the race functions, and it is unstarted. Landing this split
first makes that ticket smaller, so this should go before it rather than wait behind it.
