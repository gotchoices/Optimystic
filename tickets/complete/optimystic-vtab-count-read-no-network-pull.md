description: An investigation expected that counting rows skipped fetching fresh data from other peers; testing proved counting already fetches fresh data exactly like every other read, so there was no bug — the work added a regression test and documentation, and review confirmed the "no bug" conclusion holds across every read shape.
prereq:
files: packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, docs/internals.md
difficulty: hard

## Summary

The implement stage put the originating hypothesis — *"`select count(*)` does not
pull latest from the network, whereas other reads do"* — under direct, empirical
measurement and found it **FALSE**. `count(*)` reaches
`OptimysticVirtualTable.query()`, runs `executeTableScan()`, and calls
`collection.update()` (the network pull) on the same access path as `select <col>`.
H1/H2/H3 from the implement ticket are disproven. No product code was changed; the
deliverables are a regression spec and a docs update. Review independently verified
the negative claim at both the source level and empirically, and **hardened the
regression guard** with the adversarial shapes the implement ticket had only listed,
not tested.

## Review findings

### What was checked

- **Read the implement diff first** (commit `8640f27`) with fresh eyes before the
  handoff: docs/internals.md additions + the new spec. No source diff.
- **Independent source verification** of the central claim, `optimystic-module.ts`:
  - `query()` (L417) routes every shape to one of `executeIndexScan` /
    `executePointLookup` / `executeRangeQuery` / `executeTableScan`.
  - All three real read methods `await this.collection.update()` first
    (L506 point-lookup, L544 index-scan, L604 table-scan); `executeRangeQuery`
    (L524) delegates to `executeTableScan`. So **every** branch of `query()` pulls.
  - `getBestAccessPlan()` (L1285) emits only access plans (scan/seek/index) — no
    row-count/aggregate pushdown output that could answer a count without scanning.
- **Quereus architecture check** (`@quereus/quereus` dist): aggregates are computed
  by `StreamAggregateNode`/`HashAggregateNode`, which always consume rows from a
  `source` relational node (`rule-aggregate-streaming`). There is no row-count vtab
  API. The only count-without-scan path is planner constant-folding from a declared
  `CHECK` constraint (`capabilities.permitsGrandfatheredCheckViolators` notes
  `count(*) where v <= 0` folding) — not applicable: the optimystic module declares
  no CHECKs. So `count(*)` cannot bypass the cursor; it must drain `query()`.
- **Lint/typecheck/tests**: `yarn typecheck` clean. Full suite green —
  **223 passing, 5 pending** (was 222; +1 from the added adversarial test).

### What was found

- **Premise empirically disproven (confirmed).** Re-ran the implement spec: all
  shapes (`count(*)` aliased/bare/`db.get`, PK-predicate) reach `query()` with
  `treeUpdate ≥ 1`. `count(*)` is byte-for-byte the same `fullscan` →
  `executeTableScan` → `collection.update()` path as `select id`. Cross-writer test
  (two `Database`s over one on-disk store) shows a count-only reader sees a second
  writer's committed appends after its pull.
- **Adversarial falsification attempts — all failed to break the claim.** I probed
  the exact angles the implement ticket flagged but left untested:
  - **empty-table `count(*)`** → `query()=1`, `tableScan=1`, `treeUpdate=1` (no
    empty-table fast path bypasses the pull).
  - **`count(*)` over a secondary-index predicate** → routes through
    `executeIndexScan` (`query()=1`, `indexScan=1`, `treeUpdate=2`) — still pulls.
  - **`count(distinct)`, `sum`, `group by`** → each reaches `query()` with a
    `fullscan` and pulls (`treeUpdate=1`).
  Every shape I could construct pulls. Combined with the architectural proof
  (aggregates stream from the vtab source), I could not find any read that skips
  `collection.update()`. The negative conclusion stands.

### What was done

- **Minor — fixed in this pass:** Hardened the regression spec
  (`test/read-pull-mechanism.spec.ts`) with a 4th test, *"adversarial shapes (empty
  table, secondary-index predicate, distinct/sum/group-by) all pull"*, locking in
  the shapes that were previously only reasoned about. 4 passing in the spec; full
  suite 223 passing.
- **Verified docs** (`docs/internals.md`): the new *"Quereus vtab read path —
  pull-on-read is shape-independent"* subsection and the *Debugging Tips* item
  accurately describe the source after re-reading every touched method. No further
  doc edits needed.
- **No source changes** (correct): `count(*)` already pulls; adding a second
  `update()` would reintroduce the double-pull regression the implement ticket
  warned about.

### Major — filed as a new ticket

- The originating fix ticket's *cadre-level* observation (a **blind**, no-in-loop-read
  two-peer workload whose final `count(*)` poll loop times out at 30 s in sereus
  `convergence-stress`) is **not** explained by the optimystic count read path, which
  pulls. Its true cause is unresolved and currently **unreproducible**: the sereus
  harness can't run at optimystic HEAD because a `cadre-core` digest-signature
  migration is outstanding (cross-repo). The optimystic read path is exonerated, so
  this is **not** reopened on this slug — it is parked as
  `backlog/sereus-convergence-stress-blind-write-repro` (blocked on a cross-repo
  migration this repo can't perform). See that ticket for scope.

### Empty categories

- **Bugs / correctness defects in the change:** none — the change is test + docs
  only, and the asserted invariant is true at the source level, in Quereus's
  aggregate architecture, and across every measured read shape.
- **Resource cleanup / error handling / type safety regressions:** none — the spec
  restores patched prototypes in `afterEach` and removes its temp dir; typecheck is
  clean.

## Validation

```
cd packages/quereus-plugin-optimystic
yarn build
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/read-pull-mechanism.spec.ts" --reporter spec --exit   # 4 passing
yarn typecheck                                                  # clean
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/**/*.spec.ts" --reporter min --exit                    # 223 passing, 5 pending
```
