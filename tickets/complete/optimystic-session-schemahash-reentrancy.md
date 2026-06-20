description: Wiring Optimystic's session/consensus mode used to hang the first transaction forever after a schema change; the engine now fails fast with a clear, actionable error instead of deadlocking, and the contract is documented.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/README.md, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
----

# Complete: session-mode schema-hash re-entrancy (deadlock → fail-fast)

## Summary

In session/consensus mode, `TransactionBridge.beginTransaction` awaits a
`schemaHashProvider` while `begin` runs inside a statement's exec (Quereus's exec
mutex held). The natural provider `() => engine.getSchemaHash()` computed a cold
hash via `db.eval('select … from schema()')`, re-acquiring that same mutex →
permanent hang on the first transaction after any schema change.

The implementation makes `QuereusEngine.getSchemaHash()` never re-enter the db
from `begin`:

1. Warm cache → return it (no db access).
2. Cold cache while `db._isExecuting()` → **throw** an actionable error naming the
   fix, replacing the silent deadlock.
3. Cold cache while idle → compute, cache (version-guarded), return.

The host obligation is to keep the hash warm out of band (call `getSchemaHash()`
once outside any statement after DDL); the engine invalidates but does not
auto-recompute on schema change. Contract docs were added to `getSchemaHash`,
`configureTransactionMode`, the session-mode test header, and (this review) the
README.

The deliberate deviation from the ticket's three-layer plan — dropping the
background re-warm and the stale `lastKnownHash` fallback — is sound: a background
`db.eval` flips `_isExecuting()` at unpredictable times and derails honest callers
(the implementer reproduced real engine-test failures), and a stale fallback
silently signs with the wrong schema hash. The primary goal — `begin` can never
deadlock — is fully met.

## Review findings

### Verified (read every touched file + the ones it should have touched)

- **Re-entrancy signal is sanctioned, not a hack.** `db._isExecuting()` is a
  documented public Quereus API — `database.d.ts:144`, "Deliberately part of the
  consumable type surface … so a basis-backing host in another package can make
  that defer-vs-await decision." The fix uses exactly the intended mechanism.
- **No lingering bridge state after a failed `begin`.** In `txn-bridge.ts`,
  `beginTransaction` throws at the `await this.schemaHashProvider()` (line 177)
  *before* `this.session` (178) and `this.currentTransaction` (193) are set; the
  `accumulatedStatements`/`dirtyTrees` clears at 172–173 only run when no txn is
  active (the early-return at 163 guards that). So the failed cold-cache throw
  leaves no half-open transaction — confirmed by the new test's "warm then works"
  tail driving the same db to a durable 2-row commit.
- **Version-guarded cache write is an improvement, not a regression.** Path 3's
  `if (version === this.schemaVersion) this.schemaHashCache = hash` correctly drops
  a now-stale result when a schema change lands during `computeSchemaHash`. In the
  race it leaves the cache cold (so the next `begin` throws loudly) rather than
  caching a stale hash and signing wrong — strictly safer than the prior
  unconditional cache. No flow is masked: the out-of-band warm path has no
  concurrent schema change and caches normally.
- **Validator wiring unaffected.** `quereus-validator.ts:58` wires
  `getSchemaHash` on a *separate* engine instance with its own cache; validation
  is driven by the consensus layer (not nested in a host statement), so it hits
  the idle compute path. The dropped background re-warm would have broken this
  (implementer's reproduced failure); without it, the validator suite is green.

### Validation run (from `packages/quereus-plugin-optimystic`)

`npm run build` ✓ · `npm run typecheck` ✓ (clean) · `npm test` ✓ —
**246 passing, 4 pending, 0 failing** (~3m). Confirmed the new
`session-mode-commit.spec.ts` → "naive wiring without an out-of-band warm-up fails
fast (no deadlock)" test actually **runs and passes** (verified via spec reporter;
it is not one of the 4 pending). A regression to the deadlock would surface as a
timeout under the suite's 20s guard, not a pass.

### Findings & disposition

- **MINOR — fixed inline (this pass): README doc gap.** The README's "Transaction
  Engine" section documented `QuereusEngine`/`configureTransactionMode` but omitted
  the new non-re-entrancy + keep-warm contract that the code now enforces with a
  hard throw — a host reading only the README would hit the throw with no guidance.
  Added a "Schema hash: keep it warm out of band (session mode)" subsection with
  the correct `await engine.getSchemaHash()`-before-wiring example. (Root
  `AGENTS.md` and `examples/` do not wire session mode — nothing to update there.)

- **MAJOR — filed to backlog (not blocking): seamless naive wiring.** The ticket's
  aspiration that the obvious wiring "just works without a manual pre-warm" is not
  achieved — naive wiring throws (loudly, actionably) rather than completing. The
  only way to make it seamless is to compute the schema hash without the exec mutex
  (read `db.schemaManager` directly instead of `db.eval`), which duplicates ~100
  lines of Quereus catalog formatting that must stay byte-identical to `schema()`
  for cross-node consensus, and couples to underscore-prefixed internal APIs. That
  cost/benefit is a genuine design decision, not a quick fix — filed
  `tickets/backlog/optimystic-session-schemahash-mutex-free-compute.md`. The
  deadlock fix stands on its own; the warm-up contract is enforced and now fully
  documented, so this is a future enhancement, not a defect.

- **Test coverage.** Happy path (warm) — five existing session-mode commit/rollback
  tests, green. Error path (cold + in-flight → throw) — new naive-wiring
  integration test, end-to-end on a real db, green. Regression (DDL
  auto-invalidation, determinism, validator) — `quereus-engine.spec.ts` suites,
  green. **Gap accepted:** the path-3 version-guard race is not directly
  unit-tested (it is defensive, low-risk, and not deterministically testable
  without hooking `computeSchemaHash`); the integration test plus the existing
  idle-compute coverage are sufficient.

### Verdict

Fail-fast + documented out-of-band warm-up is an acceptable resolution: the
primary ticket goal (no deadlock) is fully met, the contract is enforced loudly
and now documented end-to-end (code + README), and tests pass. The one
seamless-wiring aspiration that remains is captured as a backlog enhancement with
its tradeoffs spelled out.
