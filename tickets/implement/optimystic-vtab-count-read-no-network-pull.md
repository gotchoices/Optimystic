description: A peer that only ever runs `count(*)` never sees another peer's new rows, because counting (unlike a normal row query) skips the step that fetches fresh data from the network. Confirm the cause and make counting refresh like every other read.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts, docs/internals.md
difficulty: hard

## Summary of the investigation (fix stage)

The originating question: *do concurrent bidirectional **blind** appends (writes with
no intervening read) converge in Optimystic strand sync, and is the observed
"converges only after a list read" behavior by design or a latent gap?*

Answer, from static analysis of the read/sync path (empirical confirmation is a TODO
below — the repro harness is currently blocked, see "Repro status"):

**Optimystic strand sync is pull-on-read by design, with no background propagation in
the default configuration. The surprising part — that a `count(*)` read does NOT
behave like a read — is a real gap in the Quereus plugin's read path.**

### How read-driven convergence actually works

Every read that reaches `OptimysticVirtualTable.query()` pulls the latest committed
state from the network *before* serving:

- `executeTableScan()` (`optimystic-module.ts:600`), `executePointLookup()` (`:496`),
  and `executeIndexScan()` (`:535`) each call `await this.collection.update()` first
  (`:604`, `:506`, `:544`). `executeRangeQuery()` delegates to `executeTableScan()`.
- `Collection.update()` → `updateInternal()` (`collection.ts:112`) opens a **fresh**
  `TransactorSource` (bypassing the per-collection `sourceCache`), reads the header,
  opens the `Log`, and calls `log.getFrom(actionContext.rev)` to pull every log entry
  appended since the last-seen revision. It then `sourceCache.clear(entry.blockIds)`
  for the affected blocks so the subsequent tree scan re-fetches them from the
  network. This is the *entire* mechanism by which one peer observes another peer's
  appends.

So the old `select max(Id)+1` subquery converged because it was a read → `query()` →
`update()` → network pull on every insert. Removing it removed the implicit pull. An
explicit `select Id …` re-introduces a real `query()`/`update()` pull (the
implementer measured ~11 ms convergence with it), which is exactly why the real apps
— polling `queryMessages` on a timer — converge in practice and are unaffected.

### There is no push in the default config

`docs/internals.md` documents two push-ish mechanisms, **neither active here**:

- The **Quereus reactive-watch bridge** (StorageRepo `CollectionChangeEvent` →
  `notifyExternalChange`) only fires for nodes that *host* the collection's blocks
  **and** have a `Database.watch` subscriber. The convergence test (and
  `waitForConvergence`) *polls* `count(*)`; it never establishes a watch. A polling
  consumer gets no wake.
- **Cohort-topic origination** (networked reactivity) is gated on
  `cohortTopic.enabled`, which **defaults OFF**. The test mesh does not enable it.

Therefore a pure write-only workload has nothing driving sync: convergence is
pull-only, and a peer must *read* to pull. **This part is by design** and should be
documented (see TODO: docs), not "fixed" — the apps' polling timers and the explicit
poll now in the test are the correct pattern.

### The actual gap: `count(*)` does not pull

The implementer's three measured configurations of the *same* test (which always ends
with `waitForConvergence`, a `select count(*)` poll loop):

| Config | In-loop reads | Result |
|--------|---------------|--------|
| `select max(Id)+1` per insert | yes (implicit) | converges ~20 ms |
| blind UUID, no reads | none | **times out at 30 s** |
| blind UUID + `select Id` per insert | yes (explicit) | converges ~11 ms |

Reconcile this with the puzzle the fix ticket raised ("if `count(*)` never drove a
pull, the *final* `waitForConvergence` would hang even in the passing configs, yet
they pass"):

- In the passing configs, the **in-loop reads** (`max(Id)+1` / `select Id`) already
  pulled every remote row into the local tree *during the loop*. By the time the final
  `count(*)` runs, the local materialized tree already holds all 20 rows, so a
  local count returns 20 — **no pull needed at that point**.
- In the blind config, **no read ever pulls**. The final `count(*)` poll loop is the
  only read, and it counts the local (unconverged) tree forever → times out.

The only model consistent with all three rows: **`count(*)` reads the locally
materialized tree but does NOT trigger a network pull, whereas `select Id` / point /
index reads do.** (It is *not* served from `StatisticsCollector.getRowCount()` — that
counter is bumped only on local INSERT DML and would read ~10 on the phone in *every*
config, contradicting the passing configs' final count of 20. So `count(*)` does read
real local rows; it just doesn't `update()` first.)

Because all three vtab read methods call `collection.update()`, the only way
`count(*)` can skip the pull is if **`select count(*)` does not reach
`OptimysticVirtualTable.query()` at all** — i.e. Quereus's planner/optimizer answers
the aggregate via a path that opens no cursor on the vtab (or opens one that the vtab
routes somewhere other than the `update()`-bearing methods). The 30 s timeout cleanly
exceeding the 10 s lazy read-repair window (`coordinator-repo.ts:103-104`,
`readRepairMode='lazy'`, `readRepairWindowMs=10000`) reinforces that no
`update()`/pull is happening on the count path — otherwise it would converge by ~10 s
at the latest.

**Leading hypothesis (H1, to confirm):** Quereus serves `select count(*)` (no
predicate) without invoking `OptimysticVirtualTable.query()`, so `collection.update()`
is never called and no network pull occurs. Any non-count read shape routes through
`query()` → `update()` → pull and converges.

**Secondary hypotheses to rule out while localizing:**
- (H2) a `count`-specific plan *does* reach `query()` but lands on a branch that skips
  `update()` (re-check the `idxNum`/`idxStr` routing in `query()` at
  `optimystic-module.ts:434-464` and what `bestIndex` emits for a bare aggregate).
- (H3) `db.get(...)` (single-row API used for the count) short-circuits cursor
  consumption differently from `db.eval(...)` (the iterator used for `select Id`).

## Fix direction

Once H1/H2/H3 is localized:

- **Make aggregate/count reads pull-latest like every other read.** The robust
  invariant is *"any read served by the Optimystic vtab first reconciles to the latest
  committed network state"* — decouple "pull latest" from the read **shape**. If
  Quereus bypasses `query()` for `count(*)`, the plugin must either (a) force such
  aggregates through a cursor that calls `collection.update()`, or (b) hook the
  count/aggregate path the planner uses and call `update()` there.
- **Do NOT** add automatic background write-propagation to the default substrate to
  "fix" this — that is the by-design pull-on-read model, and the push paths
  (reactive-watch / cohort-topic) already exist for consumers that opt in. The gap is
  specifically that one read shape doesn't pull, not that writes don't push.

## Repro status (harness currently blocked)

The designated repro harness —
`C:\sereus\packages\integration-tests\src\scenarios\convergence-stress.integration.ts`
(sereus, with optimystic `link:`-ed in) — **cannot run at optimystic HEAD**: optimystic
commit `8cea904` (`crypto-digest-variadic-config`) changed `digest()`'s signature, and
sereus `cadre-core/src/schema-verification.ts:27` still calls the old 4-arg form, so
`signSchema` throws `Unsupported output encoding: utf8` at module load. See
`tickets/.pre-existing-error.md`. This blocks the *cadre-level* empirical repro until
that cross-repo call is migrated.

**Harness-independent confirmation (preferred — do this first, no sereus dependency):**
write a spec at the `quereus-plugin-optimystic` level (pattern:
`packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts`) that registers
the plugin, creates a table, inserts rows, and **spies on
`OptimysticVirtualTable.query()` / `executeTableScan` / `collection.update`**. Assert
whether `db.get('select count(*) …')` invokes them vs `db.eval('select Id …')`. A
single node is enough to prove the *mechanism* (does count reach `query()`/`update()`),
which is the crux; you do not need two peers to confirm H1.

## TODO

### Phase 1 — localize (harness-independent)
- [ ] Add a `quereus-plugin-optimystic` spec that spies on `query()` /
      `executeTableScan` / `Collection.update`, and compare invocation for
      `select count(*)` vs `select Id` (and a point lookup) on the Optimystic vtab.
- [ ] Confirm H1 (count bypasses `query()`) or pin down the exact branch (H2/H3).
      Capture the Quereus plan for the bare aggregate (the planner is the external
      `@quereus/*` dependency; inspect via `explain`/`idxStr` or its planner source).

### Phase 2 — fix
- [ ] Make the count/aggregate read path reconcile to the latest committed network
      state (route through `collection.update()`), preserving the existing pull
      behavior of `executeTableScan`/`executePointLookup`/`executeIndexScan`.
- [ ] Guard against regressions: ensure the fix does not double-`update()` on read
      shapes that already pull, and does not break the path-invalidation retry loop in
      `executeTableScan` (`optimystic-module.ts:606-658`).

### Phase 3 — verify
- [ ] Re-run the `quereus-plugin-optimystic` spec: `count(*)` now triggers
      `update()`/pull.
- [ ] If the cadre-core digest migration (`tickets/.pre-existing-error.md`) has
      landed, re-run the sereus `convergence-stress` "Interleaved Inserts" scenario in
      its **blind** form (no in-loop reads) and confirm the `count(*)`-only
      `waitForConvergence` converges. If still blocked, document the deferral and rely
      on the plugin-level spec.

### Phase 4 — docs
- [ ] `docs/internals.md`: under the read path, state explicitly that **every** vtab
      read reconciles to latest committed network state via `collection.update()`,
      including aggregate/count reads (call out the former gap).
- [ ] Sereus `docs/cadre-consistency.md` / `docs/strands.md`: document that strand sync
      is **pull-on-read** — there is no background write-propagation in the default
      (cohort-topic-disabled) config, so peers must read (poll) to observe others'
      appends. The apps' polling timers (RN `useChat` 2 s, web `messages.svelte` 4 s,
      ns `chat-vm` 2 s) and the explicit poll in the convergence test are the correct,
      intended pattern.
