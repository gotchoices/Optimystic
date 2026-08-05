description: The written documentation stated things the code no longer does — an old agreement threshold, an old name for transactions, an old field name, an old directory name, and pointers into source code that had moved. All of these now match the code.
files: docs/correctness.md, docs/right-is-right.md, docs/repository.md, docs/transactions.md, packages/db-core/docs/transactor.md, packages/db-core/docs/collections.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/docs/storage.md, packages/db-p2p/readme.md, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts
----

# Documentation restated code facts that had drifted — fixed (implemented + reviewed)

Docs-only change plus two source *comment* edits. No behaviour change anywhere.

## What the implement stage delivered

**Arm A — super-majority threshold default: 0.67 → 0.75.** `DEFAULT_SUPER_MAJORITY_THRESHOLD`
(`packages/db-core/src/cluster/structs.ts`) is `0.75`, applied by `resolveClusterPolicy`
(`packages/db-p2p/src/cluster/cluster-policy.ts`). Docs still said 0.67 (true before
`6.2-implement-supermajority-threshold-coupling` unified three drifting defaults). Fixed at 5 sites in
`docs/correctness.md`, 1 in `docs/right-is-right.md`, plus the `admissionFloor` `NOTE:` comment in
`cluster-repo.ts` and a test doc comment.

Because the real default (0.75) now equals the proof's own assumption, two status notes needed
rewriting rather than a digit swap: Theorem 2's "threshold discrepancy" caveat became a
compound-margin caveat with the product re-derived at the true shared defaults
(`2 · 0.75 · 0.75 = 1.125`), and Theorem 10's "~33% effective Byzantine tolerance" became the stated
~25%.

**Arm B — retired "trx" vocabulary → "action".** Fixed 7 sites in `docs/repository.md`, 2 in
`docs/transactions.md`, 1 in `packages/db-p2p/docs/cluster.md`, 2 in `packages/db-p2p/readme.md`
(including a `trx/` → `actions/` directory-listing fix found while there). Deliberately left three
files alone (`docs/internals.md`, `docs/architecture.md`, `docs/optimystic.md`) whose `trxId`
references describe a coordinator log variable that genuinely still exists.

## Review findings

**Verification of the implementer's claims — all held.** Spot-checked every factual assertion in the
handoff against source: `DEFAULT_SUPER_MAJORITY_THRESHOLD` = 0.75 ✓; `membershipAdmissionFraction`
defaults to 0.75 (`cluster-repo.ts:262`) so `2 · 0.75 · 0.75 = 1.125` ✓; every remaining `0.67` in the
tree is a deliberate per-test override, not a default ✓; `coordinator.ts` really does still log
`trxId=%s` so the three "left unchanged" files are correct ✓; `TrxBlocks` and its three siblings really
do survive as aliases in `network/struct.ts` while `TrxId`/`TrxRev` do not ✓; `dispute/types.ts:124`
citation still accurate ✓.

**Minor — fixed in this pass (7 sites the implement stage missed or mis-flagged):**

- `docs/repository.md` — the implementer edited the bullet `pend(blockAction)` but left the section
  heading two dozen lines below reading `pend(blockTrx)`; same file, same rename, half-applied. Fixed.
- `docs/repository.md` — the implementer's own handoff flagged, but declined to fix, that the page
  names an `IBlockNetwork` interface that does not exist anywhere in the source, lists `getStatus` as
  one of its methods when that lives on a different interface, and describes a two-argument `commit`.
  Worse, their arm-B edit *rewrote* the wrong `commit` signature into a differently-wrong one
  (`commit(tailId, actionRef)` — still not a thing). Deferring here was the wrong call: a signature
  that does not compile is precisely the drift this ticket exists to remove, and correcting a name is
  the same kind of edit as the rest of the arm. Fixed all three: interface renamed to `IRepo` with its
  real path, `getStatus` correctly attributed to `ITransactor`, and `commit` documented as taking one
  `RepoCommitRequest` with its actual fields.
- `packages/db-p2p/docs/storage.md` — the same stale `trx/` directory in the filesystem-layout diagram
  the implementer fixed in `packages/db-p2p/readme.md`, in the sibling doc, missed. Fixed to
  `actions/` (confirmed against `db-p2p-storage-fs/src/file-storage.ts`).
- `packages/db-core/docs/transactor.md` (2 sites) — documents `TransactorSource` as carrying
  `trxContext: TrxContext`. Neither name exists; the real field is
  `actionContext: ActionContext`. Same rename, different package, not swept. Fixed.
- `packages/db-core/docs/collections.md` (4 sites) — same `this.source.trxContext` field. Notably the
  *same file* already used `actionContext` correctly at line 471, so it was internally contradictory.
  Fixed.
- `docs/correctness.md` + `docs/right-is-right.md` (3 sites) — all three cite
  `cluster-coordinator.ts:312-332` for the disputed-flag code. That code is at 377-395, and the file
  is at `src/repo/`, not the `src/cluster/` the surrounding text implies. The implementer explicitly
  replaced *other* stale line-number citations with file+symbol form in these very sentences but left
  this one. Fixed to the same file+symbol form.

**Mis-flagged gap, corrected rather than escalated.** The handoff's second listed gap claimed
`handleConsensus` "doesn't appear under that name in current `cluster-coordinator.ts` — likely moved/
refactored", and left the `packages/db-p2p/docs/cluster.md` snippet flagged for a future pass. It has
not been refactored away: it is `ClusterMember.handleConsensus` at
`packages/db-p2p/src/cluster/cluster-repo.ts:1141`, and the documented snippet is structurally
faithful. The implementer looked in the coordinator file for a member-side method. Rather than file a
ticket for a non-problem, added two sentences above the snippet naming the real file and the two ways
the snippet simplifies (per-operation dispatch extracted to `applyConsensusOperation`; durable
executed-marker written after the loop). No ticket needed.

**Major — one ticket filed.** Chasing the stale `cluster-coordinator.ts:312-332` citation prompted a
sweep of *every* line-number citation in the documentation: 7 exist, and 3 were already wrong
(`cluster-coordinator.ts:312-332` ×2, `ring-selector.ts:79`, `file-storage.ts:52`). Two of the three
sit outside this ticket's subsystem entirely. Per the architecture-first rule this is a class, not
three instances — a citation form that rots invisibly on every edit above it — so rather than patch
the two out-of-scope instances silently, filed
`tickets/backlog/debt-doc-code-citations-rot-silently.md` proposing a symbol-based citation convention
plus a check that fails on new line-number citations. The stale instances inside this ticket's files
were still fixed here; the out-of-scope two are documented as evidence in that ticket.

**Tripwires:** none recorded. Nothing found in this diff was of the "fine now, becomes work if X
happens" shape — documentation is either accurate or it is not, and everything found was already
inaccurate.

**Accepted-tradeoff `NOTE:` markers at finding sites:** none encountered. The one `NOTE:` the
implementer touched (`admissionFloor` in `cluster-repo.ts`) is an explanatory invariant note, not a
declined finding, and updating its arithmetic was the correct action.

**Source hygiene, error handling, resource cleanup, type safety, performance:** not applicable to
this diff in any meaningful sense — it changes prose and two comments. No function was added, moved,
or resized; no control flow, allocation, or type declaration was touched.

**Test coverage:** the implementer's edit to
`packages/db-p2p/test/cluster-coordinator-supermajority.spec.ts` is comment-only. Confirmed the
comment's arithmetic is now right *and* was right before (`ceil(3 × 0.75) = 3` and
`ceil(3 × 0.67) = 3` both demand unanimity in a 3-peer cluster), so the comment fix does not change
what the test asserts and the `threshold: 0.67` scenario rows below it remain deliberate overrides. No
new tests are warranted — there is no behaviour here to test. The documentation-accuracy gap that
*would* be worth automating is the citation checker, filed above.

**Deliberately not swept.** Theorem numbering, section cross-references, and the Appendix dependency
graph in `docs/correctness.md` — untouched by the diff and not re-derived, matching the implementer's
stated limit. Illustrative snippets that use `trx` as a *local variable* name
(`packages/db-core/docs/collections.md`, `docs/logs.md`) were left: they name nothing in the public
API, and `const trx = new Atomic(...)` locals do still exist in `chain.ts`. `docs/review.html` is a
historical review artifact recording defaults as they stood at review time; deliberately not updated.

## Verification

- `yarn lint` (repo root) — clean, exit 0.
- `packages/db-p2p`: `yarn build` — clean, exit 0.
- `packages/db-p2p`: `yarn test` — **1519 passing, 44 pending, 0 failing** (32s). This is the full
  package suite, broader than the three targeted spec files the implement stage ran.
- No test run for other packages: every review-stage edit is markdown, and the implement stage's only
  source edits were comments in `db-p2p`. No pre-existing failures encountered.
