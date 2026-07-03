----
description: Re-enable a previously-disabled test that checks a single transaction can span a table and its index across networked nodes; the feature already works, so confirm the whole test file still passes and hand it off.
prereq:
files: packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
difficulty: easy
----

## Background

`distributed-transaction-validation.spec.ts:253` held the project's lone unannotated
`it.skip` (`'should coordinate multi-collection transactions (table + index)'`). Review
finding eh-11 (docs/review.html, Section 9) flagged it: the other twelve skips are each
pinned to a documented expectation with a ticket reference; this one looked like a real
unfinished feature silently disabled.

## What the fix stage found

It is **not** a functional gap — it is a **stale skip** left over from initial development
(the skip has been present since the file's first commit, `fe08985`, with no annotation).

Multi-collection (table + index) coordination is fully working and independently covered:

- **Single-node / in-memory:** `test/index-support.spec.ts` exercises `CREATE INDEX`,
  index maintenance on INSERT/UPDATE/DELETE, and orphan-entry regressions — all passing.
  A DML transaction that mutates the main table tree plus one or more index trees is
  already the normal path (`IndexManager` in `src/schema/index-manager.ts`; `createIndex`
  and the commit-time flush of touched index trees in `src/optimystic-module.ts`).
- **Distributed (3-node libp2p mesh + FileRawStorage):** the fix stage un-skipped the test,
  rebuilt `dist/`, and ran it **three times in isolation** (via `--grep "multi-collection"`,
  so the shared `before`/`after` mesh setup still runs). **3/3 passed**, ~10–14s each.
  Table create → `CREATE INDEX idx_customer` → multi-row INSERT → cross-node UPDATE that
  re-keys the index → cross-node DELETE all replicate correctly across the mesh.

Correction applied by the fix stage (already in the working tree, verified):

```diff
-	it.skip('should coordinate multi-collection transactions (table + index)', async () => {
+	it('should coordinate multi-collection transactions (table + index)', async () => {
```

## Remaining validation gap (why this needs an implement pass)

The three passing runs were **isolated** (`--grep`). Inside the real suite this test runs
after two sibling tests that stress the FRET layer and share the same 3-node mesh (the file
deliberately uses no `beforeEach`/`afterEach` — see the comment at line ~113). The honest
gap is confirming the un-skipped test coexists with its siblings in-sequence, not just alone.

## TODO

- Rebuild the plugin so the test's `../dist/plugin.js` import is current:
  `cd packages/quereus-plugin-optimystic && yarn build`
- Run the **entire** distributed spec file in one process (all tests, no `--grep`) and stream
  output:
  `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/distributed-transaction-validation.spec.ts" --colors --reporter spec --exit 2>&1 | tee /tmp/dtv-full.log`
  Confirm the multi-collection test passes alongside its siblings. This file is a real
  3-node mesh with multi-second delays — expect a wall-clock in the low minutes, well under
  the 10-minute idle limit since it streams. If it exceeds ~10 min wall-clock, treat it as
  not agent-runnable: document the deferral and let CI cover the full-suite run.
- Run `yarn typecheck` in the package to confirm no regressions.
- If the full-suite run passes: leave the test enabled as-is; nothing else to change.
- If the full-suite run reveals cross-test interference (not the feature itself — a mesh/
  ordering/timing coupling between the sibling tests), that is a *test-isolation* problem,
  not the multi-collection feature. Fix the isolation (or add the smallest needed inter-test
  delay, matching the pattern the sibling tests already use) rather than re-skipping. Only if
  isolation genuinely can't be made reliable should you re-add `it.skip` — and then it must
  carry an annotation + a follow-up ticket, matching the convention of the other twelve skips.

## Handoff to review

Note in the review handoff that the fix was a stale-skip removal (feature already worked and
was already covered by `index-support.spec.ts`), and that the added coverage is the
distributed variant. No production code changed — this is test re-enablement only.
