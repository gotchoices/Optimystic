description: The rule that decides which of two competing writes to a shared block wins is buried inside a single 2600-line file alongside storage, membership and recovery code; move it into its own small file so it can be read and tested on its own. No behaviour changes.
files: packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/cluster/race-resolution.ts, packages/db-p2p/src/cluster/record-operations.ts, packages/db-p2p/test/cluster-repo.spec.ts, docs/optimystic.md
difficulty: medium
----

# Extract race resolution out of `ClusterMember`

Pure code move. `packages/db-p2p/src/cluster/cluster-repo.ts` is 2614 lines
(`wc -l packages/db-p2p/src/cluster/cluster-repo.ts`, measured 2026-09-01), nearly all of it the
single class `ClusterMember`. Seven of its methods form the conflict/race-resolution concern; six of
those seven are pure functions of their arguments. They move to two new sibling modules. Nothing
else about the file changes.

## Target shape

Two new files beside `cluster-repo.ts`, no new dependencies (everything they need is already a plain
import from `@optimystic/db-core`):

### `packages/db-p2p/src/cluster/record-operations.ts`

Pure introspection of a `RepoMessage`'s own operations. Two exported functions:

```ts
export function getAffectedBlockIds(operations: RepoMessage['operations']): string[]
export function getActionId(operations: RepoMessage['operations']): string | undefined
```

`getAffectedBlockIds` gets its **own module rather than living under a race-named one** because it
has a second, non-race consumer: the membership admission gate (`cluster-repo.ts:1311`, inside the
`deriveExpectedClusterView` path) uses it to decide which block ids a legitimate
`coordinatingBlockIds[0]` may name. Its existing doc comment states that the two consumers
deliberately share one definition, and that if they ever disagreed a coordinator could name a block
the record is not judged to touch. **Exactly one definition must exist after this change** — do not
copy it into the race module.

`getActionId` moves here too: it is the same kind of operation introspection, and its only caller
today is `operationsConflict`.

### `packages/db-p2p/src/cluster/race-resolution.ts`

The deterministic arbiter. Imports from `./record-operations.js`. Four exported functions:

```ts
export function operationsConflict(ops1: RepoMessage['operations'], ops2: RepoMessage['operations']): boolean
export function approvalCount(record: ClusterRecord): number
export function recordPriority(record: ClusterRecord): number
export function resolveRace(existing: ClusterRecord, incoming: ClusterRecord): 'keep-existing' | 'accept-incoming'
```

The ~70-line safety comment on `resolveRace` (why approvals are compared before priority; the
Theorem 9 / split-brain argument mirrored in `docs/correctness.md`) moves with it and becomes the
module's reason to exist. Keep it word-for-word apart from the `{@link}` fixes noted below.

### What stays in `cluster-repo.ts`

`findConflict` stays a private method on `ClusterMember` — it is the only one of the seven coupled
to mutable member state (it sweeps stale entries out of `activeTransactions` via `clearTransaction`,
and clears a held transaction that loses the race). It now calls the imported free functions instead
of `this.*`. Its body — the self-skip, the 2000 ms staleness sweep, the `continue` after clearing a
loser, the log lines, the `{ blockedBy }` return — is otherwise untouched.

`deriveExpectedClusterView`'s call at `cluster-repo.ts:1311` switches to the imported
`getAffectedBlockIds`.

## Symbols moving, with current line numbers

| symbol | current line | destination |
|---|---|---|
| `findConflict` | 2188 | stays in `cluster-repo.ts` (rewired to imports) |
| `approvalCount` (`private static`) | 2248 | `race-resolution.ts` (plain exported function) |
| `resolveRace` | 2303 | `race-resolution.ts` |
| `recordPriority` | 2341 | `race-resolution.ts` |
| `operationsConflict` | 2354 | `race-resolution.ts` |
| `getActionId` | 2380 | `record-operations.ts` |
| `getAffectedBlockIds` | 2401 | `record-operations.ts` |

## Logging

Both new modules create their logger as `createLogger('cluster-member')` — the **same**
sub-namespace `cluster-repo.ts` uses — so every emitted tag string
(`cluster-member:conflict-detected`, from `operationsConflict`) and the `debug` namespace it lands
under stay byte-identical to today. Several specs capture by namespace and tag substring
(`test/cluster-membership-admission.spec.ts:407,431,433`,
`test/mesh-partition-admission.spec.ts:96,109`), so a renamed namespace would silently break
capture.

## Test surface

`packages/db-p2p/test/cluster-repo.spec.ts:1056-1058` currently reaches `resolveRace` through a
private-method escape hatch:

```ts
const raceOf = () => (clusterMemberInstance as unknown as {
    resolveRace(a: ClusterRecord, b: ClusterRecord): 'keep-existing' | 'accept-incoming'
});
```

Delete the helper and the cast; import `resolveRace` directly from
`../src/cluster/race-resolution.js` and replace all **15** `raceOf().resolveRace(...)` call sites
(lines 1070, 1071, 1087, 1088, 1095, 1108, 1109, 1123, 1124, 1134, 1135, 1149, 1150, 1171, 1172)
with `resolveRace(...)`. Assertions and their messages stay exactly as they are — this is a
call-site substitution, not a rewrite of the tests. Do not add new race tests in this ticket; the
value here is that the existing dozen-odd assertions stop depending on a cast.

`clusterMemberInstance` is a shared `beforeEach` fixture used elsewhere in the file — leave it in
place even though this one `describe` block stops using it.

## Doc-comment cross-references

Three `{@link}` targets stop resolving once the symbols sit in different files. Rewrite them as
plain prose naming the file rather than leaving broken links:

- `getAffectedBlockIds`'s comment references `{@link ClusterMember.deriveExpectedClusterView}` →
  name it as "the membership admission gate's binding check in `cluster-repo.ts`". The *substance*
  of that comment — two consumers, one definition, and why — must survive intact; it is the guard
  against someone re-duplicating the function later.
- `resolveRace`'s comment references `{@link findConflict}` (twice) and `{@link recordPriority}`.
  `recordPriority` is now a sibling in the same module so that link still resolves; `findConflict`
  becomes a prose reference to `cluster-repo.ts`.
- `recordPriority`'s comment already names `findConflict` in prose — fine as-is.

## Public API

Do **not** add either new module to `packages/db-p2p/src/index.ts` or `src/rn.ts`. Both are internal
helpers of `ClusterMember`; the tests import them by relative path, as `cluster-repo.spec.ts` already
does for its other imports. Adding them to the barrel would widen `@optimystic/db-p2p`'s published
surface for no consumer.

## Docs

`docs/optimystic.md:288` says "the `resolveRace` path in `cluster-repo.ts`" — update the filename to
`race-resolution.ts`. That is the only prose doc pointing at the old location for this concern.
`docs/correctness.md` names `resolveRace()` and `operationsConflict()` as symbols without a path, so
it needs no change; `docs/review.html` is an archived review artifact — leave it.

## Expected behaviour after the change

Identical. No ordering rule changes, no threshold changes (the 2 s staleness window stays where it
is, in `findConflict`), no log-tag changes, no signature or wire-format changes, no public API
change. Success is: the `db-p2p` suite passes unmodified apart from the `raceOf()` substitution, and
`getAffectedBlockIds` still has exactly one definition, shared by conflict detection and the
admission gate.

## Edge cases & interactions

- **One definition of `getAffectedBlockIds`.** After the change,
  `grep -rn "function getAffectedBlockIds" packages/` must return exactly one hit, and
  `cluster-repo.ts` must import it rather than define it. A second copy silently re-opens the hole
  where a coordinator names a coordinating block the record is not judged to touch.
- **`findConflict`'s side effects and their order.** Self-skip on
  `existingHash === record.messageHash` first; then the staleness sweep
  (`now - state.lastUpdate > staleThresholdMs` → `clearTransaction` → `continue`) *before* the
  conflict test; then, on `keep-existing`, return `{ blockedBy: existingHash }` without clearing
  anything; on `accept-incoming`, `clearTransaction(existingHash)` and `continue` so further
  conflicts are still checked. Iterating over `Array.from(this.activeTransactions.entries())` (a
  snapshot) is what makes mutating the map mid-loop safe — keep the `Array.from`.
- **`resolveRace` must stay total and side-effect-free.** It is called from the vote path; a throw
  there costs the member its vote entirely. `recordPriority`'s fail-closed read
  (`op.pend.validation?.transaction?.priority ?? op.pend.priority`, then `clampPriority`) exists
  precisely for a malformed off-the-wire shape and is pinned by the spec's malformed-record case
  (lines ~1102-1109) — do not "tidy" the optional chaining away.
- **`approvalCount` counts `approve` votes only,** never `Object.keys(record.promises).length`. A
  `reject` occupies a key exactly as an `approve` does; counting keys would let a provably-dead
  record hold a rival's blocks for the whole staleness window. The test at spec:1171-1172 pins this.
- **No stale reference to `ClusterMember.approvalCount`.** It was `private static`; after the move
  nothing may reach it through the class. Note that `src/repo/cluster-coordinator.ts:416` has an
  unrelated *local variable* also named `approvalCount` — do not touch that file.
- **Priority clamping at the cap.** The over-cap self-assert test (spec:1131-1135) asserts a
  Byzantine over-cap priority clamps to `MaxPriority` and therefore *ties* rather than wins, falling
  through to the hash tiebreak. Both directions (`a,b` and `b,a`) must stay mirror-consistent.
- **`operationsConflict`'s same-action early return.** Equal, non-`undefined` action ids mean a
  commit is resolving its own pend, not conflicting — that check runs *before* block overlap and
  must stay first. `getActionId` returns the first matching operation's id and stops; preserve that,
  including the `pend` / `commit` / `cancel` precedence within a single operation.
- **`getAffectedBlockIds` covers all five operation kinds** — `get`, `pend` (via
  `blockIdsForTransforms`), `commit`, `cancel` (via `actionRef.blockIds`), and `invalidate`. The
  `invalidate` arm was added deliberately so a concurrent commit racing an invalidation serializes;
  dropping it in the move would be a silent correctness regression.
- **No import cycle.** Neither new module may import from `cluster-repo.ts`. `record-operations.ts`
  imports only `blockIdsForTransforms` and the `RepoMessage` type from `@optimystic/db-core`;
  `race-resolution.ts` adds `clampPriority` and the `ClusterRecord` type, plus
  `./record-operations.js` and `../logger.js`.
- **Log-capture specs.** `cluster-membership-admission.spec.ts` and `mesh-partition-admission.spec.ts`
  assert on `cluster-member:*` tags; the namespace must not shift. Run both.
- **Type level.** The four `race-resolution.ts` exports keep exactly the parameter and return types
  they have as methods (`ClusterRecord`, `RepoMessage['operations']`) — no widening, no narrowing,
  no new optionality.

## Not in scope

Splitting the rest of `ClusterMember` (protocol state machine, storage application, recovery — they
share mutable member state and have no clean seam). Changing the 2 s staleness threshold, the aging
or priority rules, or anything `feat-occ-priority-reservation` covers. Adding the new modules to the
package barrel. Writing new race tests.

## TODO

### Phase 1 — extract

- Create `packages/db-p2p/src/cluster/record-operations.ts` with `getAffectedBlockIds` and
  `getActionId` moved verbatim (bodies unchanged; `this.` calls become direct calls), doc comments
  carried over with the `{@link}` fix described above.
- Create `packages/db-p2p/src/cluster/race-resolution.ts` with `operationsConflict`, `approvalCount`,
  `recordPriority` and `resolveRace` moved verbatim, the full safety comment intact, and
  `const log = createLogger('cluster-member')`.
- Delete the six moved methods from `ClusterMember`; add the two imports to `cluster-repo.ts`.
- Rewire `findConflict` (lines ~2188-2245) to the imported functions.
- Rewire `deriveExpectedClusterView`'s call at `cluster-repo.ts:1311` to the imported
  `getAffectedBlockIds`.

### Phase 2 — tests and docs

- In `test/cluster-repo.spec.ts`, delete the `raceOf` helper and its `as unknown as` cast, import
  `resolveRace` from `../src/cluster/race-resolution.js`, and substitute all 15 call sites.
- Update `docs/optimystic.md:288` to name `race-resolution.ts`.

### Phase 3 — verify

- `grep -rn "function getAffectedBlockIds" packages/` → exactly one hit.
- `grep -rn "raceOf" packages/db-p2p/test/cluster-repo.spec.ts` → no hits.
- `grep -rn "ClusterMember.approvalCount|this.resolveRace|this.operationsConflict|this.getActionId|this.getAffectedBlockIds" packages/db-p2p/src/` → no hits.
- `wc -l packages/db-p2p/src/cluster/cluster-repo.ts` — record the new count in the review handoff.
- Build and typecheck the package.
- Run the `db-p2p` suite in the foreground (~3 min): `yarn workspace @optimystic/db-p2p test`.
  Confirm `cluster-repo.spec.ts`, `cluster-membership-admission.spec.ts` and
  `mesh-partition-admission.spec.ts` all pass. Integration specs are env-gated and out of scope.
