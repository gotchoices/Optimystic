description: The block-repair logic decides how many peers must agree before it trusts a copy, and it now measures that against the "how many peers actually exist" setting instead of the "how many copies to keep" setting — so a small deployment no longer has to shrink its replication factor just to be able to repair itself.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/quorum-restore.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-content.spec.ts, packages/db-p2p/docs/cluster.md, docs/internals.md, docs/transactions.md, packages/reference-peer/src/cli.ts, packages/reference-peer/README.md
----

# Complete: repair corroboration floor measured against the asserted cohort size

## What shipped

`corroboratorCapacity(cohortPeerCount, assumedClusterSize)` in
`packages/db-p2p/src/cluster/quorum-restore.ts` answers "how many peers other than me could possibly
answer for this block", and both block-restoration paths — read-repair in
`CoordinatorRepo.queryClusterForLatest` and the commit-path reconcile in `createReconcileBlock` — cap
their corroboration-vote requirement with it. Its second input was `clusterSize`, the replication
factor (default 10), so a two-node deployment computed a capacity of 9, needed two corroborators, had
exactly one peer that could ever supply one, and could never repair a damaged block. The only escape
hatch was `clusterSize: 2`, which also dropped the replication factor to two copies.

That input is now `assumedClusterSize` — the operator's declaration of the smallest cohort the
deployment can genuinely field, introduced by the prerequisite ticket
`split-admission-floor-from-replication-factor` for the membership admission gate and already threaded
through `libp2p-node-base`. Arithmetic unchanged (`Math.max(cohortPeerCount, assumedClusterSize - 1)`).

- `ReconcileBlockDeps.clusterSize` → `assumedClusterSize` (still required).
- `CoordinatorRepo` resolves `policy.assumedClusterSize ?? policy.clusterSize` in its constructor, so a
  caller constructing it directly without the new field keeps the old strict behavior.
- `libp2p-node-base` feeds `consensusConfig.assumedClusterSize` to both paths.
- Docs updated wherever the old "configure `clusterSize: 2`" advice appeared: `packages/db-p2p/docs/cluster.md`,
  `docs/internals.md`, `docs/transactions.md`, jsdoc in `libp2p-node-base.ts`, and the
  `--assumed-cluster-size` CLI help + README entry in `packages/reference-peer`.

## Review findings

### Major — filed as a new ticket

- **The shrunken-view protection is now off by default for every deployment.** Filed as
  `fix/corroboration-floor-defaults-to-two-for-large-meshes`. `corroboratorCapacity`'s whole purpose is
  that the two-corroborator requirement may be relaxed only for a cohort that is *genuinely* small,
  never one that merely *looks* small — cohort views are unauthenticated, so a partition or a
  routing-level attacker can otherwise shrink the view to one peer and have that peer's unverified
  claim drive a repair. Before this change the yardstick was `clusterSize`, defaulting to 10, so an
  unconfigured node held a floor of `max(visible, 9)` and a shrunken view gained nothing. After it the
  yardstick is `assumedClusterSize`, which `libp2p-node-base` defaults to `minAbsoluteClusterSize` (2)
  — so every node built through `createLibp2pNodeBase` with default config now sits at `max(visible,
  1)`: one voter suffices. This is *not* covered by the prerequisite ticket's explicitly-accepted
  tradeoff; that reasoning rested on a large healthy network taking the admission gate's confident
  measured branch and so being at full strength regardless of configuration, and the corroboration
  floor has no measured branch — it reads the asserted size unconditionally, on every repair. The
  ticket lays out the option space (separate yardstick per consumer / derive from observed cohort
  high-water mark, which would also subsume
  `backlog/feat-admission-floor-from-observed-cohort-high-water-mark` / accept-and-warn) rather than
  picking one, because the choice trades directly against the small-mesh goal this ticket existed to
  serve. `CoordinatorRepo`'s `?? clusterSize` fallback is real but unreachable from the node path,
  which is why the existing `'does not relax the floor when a LARGER configured cluster merely looks
  small'` test still passes while the shipped node does the opposite.

### Minor — fixed in this pass

- **`NodeOptions.clusterPolicy.assumedClusterSize` jsdoc still said "Used only as the membership
  admission gate's fallback yardstick"** (`libp2p-node-base.ts`) — false after this change, and the
  handoff claimed it had been updated when the diff shows only the sibling `clusterSize` jsdoc was.
  Rewritten to name both consumers and both failure directions.
- **The `consensusConfig.assumedClusterSize` inline comment** in the same file had the same
  gate-only framing. Rewritten.
- **`docs/transactions.md` contradicted itself on the default.** One bullet said a genuine two-node
  deployment "must set `clusterPolicy.assumedClusterSize: 2`"; the next said leaving it unset "(it
  defaults to `minAbsoluteClusterSize`, 2)" makes the heal *decline*. Both were wrong in opposite
  directions — the default is 2 and the two-node mesh heals unconfigured. Rewritten to state the
  consequence in both directions, including the large-deployment one.
- **`corroboratorCapacity`'s own doc comment** described `assumedClusterSize: 2` as "an explicit
  operator declaration" while the node path supplies it by default. Added the caveat, pointing at the
  fix ticket.
- **`ReconcileBlockDeps.assumedClusterSize` jsdoc described a fallback the type does not have** ("an
  absent value here should fall back to `clusterSize`" — the field is required, and the sole
  production caller passes the already-defaulted 2). Rewritten to say what a caller should actually
  pass and what each direction of error costs.

### Conditional — recorded as tripwires, not tickets

- **The two restoration paths could drift on which `assumedClusterSize` they cap against.** The
  implementer flagged the absence of a live coupling assertion in the spirit of
  `assertSuperMajorityCoupling`. Verified this cannot happen today: in `libp2p-node-base.ts` both
  `CoordinatorRepo` (via the spread `consensusConfig`) and `createReconcileBlock` read fields of the
  same object literal, with no independent resolution on either side. An assertion for two lines
  reading one local variable is not worth its own machinery — but a future edit threading a different
  config to one side would go uncaught, so a `NOTE:` at the `createReconcileBlock` wiring site says
  exactly that and names the assertion to add if it ever happens.
- **A non-finite `assumedClusterSize` is unguarded** at `corroboratorCapacity` (the admission gate got
  a `Number.isFinite` guard in the prerequisite ticket; this path did not). Fails in the safe
  direction — `NaN` capacity makes every quorum comparison false, so the block goes unrepaired rather
  than under-corroborated — and the reference-peer CLI validates the flag, so only a programmatic
  embedder passing garbage can reach it. Not filed; recorded here.

### Checked and clean

- **The rename is complete.** Both `corroboratorCapacity` call sites pass `assumedClusterSize`; no
  path still measures the corroboration floor against the replication factor. `clusterSize`'s
  remaining readers are all genuine replication-factor questions (cohort assembly, FRET dynamic-`d`,
  the coordinator downsize check) plus `CoordinatorRepo`'s fallback.
- **Test coverage of the arithmetic and of both paths.** `quorum-restore.spec.ts` pins the function
  itself including the degenerate `0`/`1` sizes; `reconcile-block.spec.ts` pins both the two-node heal
  and the looks-small-but-isn't refusal; `coordinator-repo-read-repair.spec.ts` adds the headline case
  (`clusterSize: 10, assumedClusterSize: 2` heals). The gap is not in these — it is the missing test at
  the `libp2p-node-base` wiring layer, which is part of the filed ticket.
- **`docs/internals.md`, `packages/db-p2p/docs/cluster.md`, `packages/reference-peer/README.md` and the
  CLI help text** describe the shipped behavior accurately, including the default and the
  large-deployment caveat. The reference-peer edits were outside the ticket's stated file list; the
  implementer flagged the scope expansion rather than widening silently, and the edits are the same
  category of stale-doc correction the ticket asked for. Kept.
- **`docs/correctness.md`** — its one relevant mention (Theorem 2, membership admission) concerns the
  admission gate, not the repair path, and is unaffected. Left alone, confirmed by reading.

## Validation

From `packages/db-p2p`: `yarn build` exit 0, `yarn test` **1432 passing, 41 pending, 0 failing**. From
the repo root: `yarn lint` exit 0. No pre-existing failures encountered, so
`tickets/.pre-existing-error.md` was not written. This pass changed only comments, jsdoc and markdown,
so the test count is unchanged from the implement stage — deliberately: the behavioral question it
surfaced is a design decision, filed rather than unilaterally reversed.
