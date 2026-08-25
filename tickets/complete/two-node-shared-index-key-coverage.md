description: A bug report claimed our tests had never tried two machines saving records that share one search-index value. They had, and those tests pass. Tests were added for four neighbouring situations that genuinely had never been tried, and those pass too — so the reported bug still has no explanation on our side.
prereq:
files: packages/quereus-plugin-optimystic/test/two-node-shared-index-key.spec.ts, packages/quereus-plugin-optimystic/test/mesh-node-harness.ts, packages/quereus-plugin-optimystic/test/two-node-index-interleaving-sweep.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, packages/quereus-plugin-optimystic/test/two-node-multi-collection-commit.spec.ts, tickets/backlog/debt-index-sweep-misses-update-delete-and-orphans.md
----

# What landed

`fix/two-nodes-writing-one-index-key-was-never-tested` claimed that five prior attempts to
reproduce a downstream secondary-index bug had all given the two machines **disjoint index keys**,
so no index entry had ever had to hold two writers' contributions. It proposed a mechanism: a
shared index entry overwritten last-writer-wins instead of merged.

Both halves were refuted, and the refutation holds up under review (see *Review findings*):

- **The shape was already tested.** The interleaving sweep's `token` dimension crosses
  `same-token`, which puts both machines on one indexed value in 72 of its 144 orderings.
- **The proposed mechanism cannot occur.** `index-manager.ts insertIndexEntries` keys every index
  tree entry as `frame(indexColumns) ‖ frame(primaryKey)`, for unique and non-unique indexes
  alike. Two rows sharing an indexed value occupy two **distinct** tree keys; there is no shared
  slot to overwrite. What two same-value writers share is the tree *block* their adjacent keys
  land in, which the `same-token` sweep cases already exercise.

What the implement stage got right and kept: the sweep's header had claimed the downstream
scenario "redeems distinct tokens". It does not — it redeems the *same* token with distinct
primary keys. The header was corrected in place.

`packages/quereus-plugin-optimystic/test/two-node-shared-index-key.spec.ts` (**7 cases, ~1s**,
ungated so it runs on every `yarn test`) closes four gaps the sweep's own review had catalogued as
untested:

- **A shared index value created from nothing** — every `same-token` sweep case grows a group a
  committed seed row already established; here the index tree starts empty and both machines
  create the group at once, across all three commit orders.
- **A third writer** — three machines all staging before any commits, which distinguishes "last
  writer wins over the whole group" (1 surviving row) from "a pairwise merge drops one arm" (2).
  Two machines cannot tell those apart.
- **A UNIQUE index across two machines**, in both arms — distinct values (pure maintenance) and
  the same value (both admit).
- **An index tree spanning more than one block**, deriving its preload from the btree's exported
  `NodeCapacity` and asserting through `Path.branches` that the tree actually split.

Every case asserts the committed entry count through a **fresh** Tree on each node's transactor,
not the vtab's tracker, so a lost write the query path papered over would still fail.

**All 7 pass. This is the sixth failure to reproduce the downstream report upstream.** Nothing
here is a fix — there was no defect to fix.

Where the investigation goes next is a human's call, filed as
`blocked/secondary-index-repro-exhausted-upstream`.

# Review findings

## Verified — the implement stage's central claims, re-derived from the code

Every load-bearing claim in the handoff was checked against source rather than accepted:

- **The refutation is sound.** `index-manager.ts:304` (`insertIndexEntries`), `:326`
  (`deleteIndexEntries`) and `:352` (`updateIndexEntries`) all build `treeKey = indexKey +
  primaryKey`, unconditionally — no unique/non-unique branch. There is no shared slot.
- **"72 of 144"** — the sweep crosses 2×3×2×3×2×2 = 144, and its `same-token` arm returns
  `{ a: SEED_TOKEN, b: SEED_TOKEN }` for both machines. Half of 144 is 72. Correct.
- **The downstream claim** — `sereus/packages/integration-tests/src/scenarios/strand-formation-concurrent-redemption.integration.ts:20`
  says two joiners "redeem the SAME token in the same tick", and `sereus/schemas/control.qsql:528`
  makes `UsageStampId` the primary key. The sweep-header correction is right.
- **The shared value really does start absent** — `openTwoNodesOnEmptyIndex` declares table and
  index on both nodes and commits no row, so the index tree is empty when the writes begin. The
  claim in the file header is accurate.
- **The "fresh Tree" claim is real** — `collection-factory.ts getCachedCollection` only consults
  the cache when a `TransactionState` is passed and active. The helper passes none, so it always
  opens a new `Tree`. It is genuinely reading committed state, not a vtab's tracker.
- **The split probe is not constant** — `Path.branches` (`db-core/src/btree/path.ts:20`) is the
  branch-level array, empty for a single-leaf tree. The negative control asserting `split ===
  false` on the two-entry cases is what keeps the positive assertion meaningful.
- **The multi-block case's "interior, not edge" comment is right** — `key-encoding.ts` frames
  order-preservingly (tag + escaped payload + terminator), not length-prefixed, so
  `tok-040` < `tok-040-shared` < `tok-041`. The concurrent inserts do land in an interior block.
- **The oracle is not vacuous** — `expectIndexAgreesWithScan` requires `executeIndexScan` to have
  run for every non-null value group, so a full-scan fallback fails rather than passes.

## Minor — fixed in this pass

- **The mock-mesh harness was copy-pasted a fourth time.** `createNode`/`createDb`, the
  `createMesh(2, …)` + `buildNetworkTransactors` block, `transactorFor`, and `countTreeEntries`
  existed verbatim in `two-node-secondary-index-convergence`, `two-node-index-interleaving-sweep`
  and `two-node-multi-collection-commit`; the new spec made a fourth copy of the first three and
  a superset of the fourth. Filed nothing — this is the class, not an instance, so the fix is the
  invariant: extracted `test/mesh-node-harness.ts` (`startMockMesh`, `createMeshDbNode`,
  `readTree`, `countTreeEntries`) and pointed all four specs at it. Net **−153 lines** across the
  specs for **+130** in the harness. The duplication mattered beyond tidiness: it is the seam
  where `clusterSize` or the `shared:test` transactor key could drift between two specs that read
  identically, silently testing different topologies.
- **A wrong claim in a comment about what `staged-both` proves.** It read "so neither machine's
  flush can have seen the other's". The harness is single-threaded — A's commit returns before B's
  begins, so B's *flush* certainly can have seen A's. The true property is about **staging**: each
  machine staged against a tree snapshot taken before the other's commit existed, so the second
  commit must reconcile a stale revision. Corrected at both sites (the `WRITE_ORDERS` docblock and
  the three-node case), and the corrected text now says out loud that the commits are still
  sequential — which is exactly the still-open "`staged-both` commit-order gap" the backlog ticket
  tracks, now visible at the site instead of only on the board.
- **The same-value UNIQUE behaviour was argued in a comment, not tested.** The handoff explicitly
  asked whether it deserved to be a case. It does, and now is: `a UNIQUE index over-admits the
  same value across two nodes, while rejecting it on one`. The comment's reasoning checked out —
  `create unique index` really does derive an enforced constraint (`mirrorDerivedUniqueConstraint`
  at `optimystic-module.ts:2127`) and `resolveSecondaryUniqueDecision` really is check-then-write
  against the tree — but "both rows survive" has two causes and only one is acceptable. The case
  carries a **single-node control**: the second same-value insert on the machine that can already
  see the first must be rejected with a unique violation. Without that arm, a constraint that had
  quietly stopped being enforced would pass the cross-machine assertion. It passes both arms, so
  the surviving pair really is an over-admission by two machines that could not see each other —
  the same trade the downstream schema takes knowingly at
  `sereus/schemas/control.qsql:541` ("two nodes that have not yet converged could each admit the
  same nonce"). That reference is now in the test comment, so the two records agree.
- **Doc drift in the ticket the implement stage itself edited.** Its "Update 2026-08-25" section on
  `backlog/debt-index-sweep-misses-update-delete-and-orphans` said "6 cases, ~3s". Now 7 cases and
  measured at ~1s; the UNIQUE bullet was rewritten to name both arms. The sweep header and that
  Update section were cross-read and agree with each other and with the code.

## Major — none filed, and why

No finding rose to a new ticket. The three candidates were weighed and rejected:

- The **refutation itself** — checked against source above, and it holds. Nothing to file.
- **Resource cleanup**: no spec closes its `Database`s or tears the mesh down. This is the
  accepted tradeoff already recorded at the sweep site; the mesh is in-process objects over
  `MemoryRawStorage` with no sockets or timers. The `NOTE:` moved onto `startMockMesh` so it now
  sits at the one site the behaviour lives at, with the sweep's scale-specific magnitude (288
  Databases on the wide arm) kept where it was measured. Its revisit condition — a spec slowing
  down or running the heap up — has not tripped.
- The **multi-block case runs only `staged-both`**. Deliberate, not a gap: `staged-both` is the
  strictly hardest ordering (both machines stage before either commits), so `a-then-b` and
  `b-then-a` are strictly easier over the same tree. Adding them would triple the cost of the most
  expensive case in the file for no new failure mode.

## Tripwires — one, already parked at its site

The only conditional concern is the un-torn-down meshes and Databases described above; it is
parked as the `NOTE:` on `startMockMesh` in `test/mesh-node-harness.ts`, not as a ticket.

## Docs — read, and correctly need no change

Every doc that mentions secondary indexes or two-node specs was read, not assumed:

- `docs/debugging.md:237` names which specs pin the `commit:collections` / `index:tree-open` /
  `index:seek` trace lines. The new spec pins none of them and the refactor moved no pinning code,
  so the list is still complete.
- `docs/optimystic.md:276` and `docs/transactions.md:17` describe the one-collection-per-index
  layout. The diff neither changes that layout nor contradicts the description.
- `packages/quereus-plugin-optimystic/test/README.md` lists a handful of specs by name and has
  never listed **any** two-node spec — the convergence spec, the sweep and the multi-collection
  spec are all absent and predate this ticket. It is a partial guide, not a claimed index, so
  adding one more unlisted spec does not make it wrong. Left alone deliberately rather than
  silently: bringing it up to date means indexing ~60 specs, which is its own piece of work and
  not this ticket's.

## Test quality

The implementer's tests were treated as a starting point. Happy path, both edge shapes (empty
index tree, split index tree), the three-writer discrimination case and the negative controls
(`split === false` on small trees; the single-node unique rejection added this pass) are all
covered. The one honest hole is unchanged and belongs to a different ticket: **no UPDATE or DELETE
anywhere in any two-node index spec**, which is the actual subject of
`backlog/debt-index-sweep-misses-update-delete-and-orphans`.

# Honest limits

Nothing here explains the downstream report. The gaps still open are listed on
`backlog/debt-index-sweep-misses-update-delete-and-orphans`: no UPDATE or DELETE in any two-node
index spec, no real sockets, no process restart mid-scenario, no genuine thread-level concurrency,
no same-primary-key conflict, no composite index, the `staged-both` commit-order gap, and the
read-only-sibling shape.

# Validation

| command | result |
|---|---|
| `yarn lint` (root) | pass |
| `yarn typecheck` (`packages/quereus-plugin-optimystic`) | pass |
| `yarn test` (`packages/quereus-plugin-optimystic`) | **648 passing, 13 pending, 0 failing** (3m) — was 647; +1 is the new same-value UNIQUE case. `test:smoke` ok. |
| all four `two-node-*.spec.ts` together, standalone | 168 passing, 2 pending (11s) |
| `two-node-shared-index-key.spec.ts` standalone | 7 passing (1s) |

No pre-existing test failures surfaced; `tickets/.pre-existing-error.md` was not written, and
nothing was skipped, commented out, or loosened.
