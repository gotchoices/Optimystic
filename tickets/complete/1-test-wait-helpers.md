description: Consolidated the six hand-rolled test polling/sleep helpers into one shared module in db-core, exported it, unit-tested it, and migrated every private copy to import it.
files: packages/db-core/src/testing/async-wait.ts, packages/db-core/src/testing/index.ts, packages/db-core/test/async-wait.spec.ts, packages/db-core/package.json, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/multi-coordinator-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-cross-network-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts
----

## Summary

A single canonical condition-polling module now lives at `packages/db-core/src/testing/async-wait.ts`, exported through the `@optimystic/db-core/test` subpath via a new barrel (`src/testing/index.ts`). It exports:

- `waitFor(predicate, opts?)` — polls until true; **throws** on timeout (void return).
- `waitForValue<T>(fn, opts?)` — polls until non-`undefined`; throws on timeout; returns the value.
- `delay(ms)` — real-time sleep, for absence-checks that cannot be expressed as a predicate.
- `WaitForOptions` — `{ timeoutMs?=2000, intervalMs?=10, description? }`.

Six private helper copies across five packages were replaced with imports from this module. The `./test` subpath, which previously pointed straight at `test-transactor.js`, now points at the barrel — `TestTransactor` is still re-exported, so existing importers (`client-tx-signature.spec.ts`, `demo`) are unaffected.

## Review findings

Reviewed the implement-stage diff (`0edd7da`) with fresh eyes before the handoff, across all five migrated packages plus the new module and its spec.

**Verification run (all green):**
- `yarn workspace @optimystic/db-core build` — clean; emits `dist/src/testing/{index,async-wait}.{js,d.ts}`.
- `yarn workspace @optimystic/db-core test` — **1266 passing** (includes the 9-case `async-wait.spec.ts`).
- `yarn workspace @optimystic/db-p2p tsc --noEmit` — 0 errors (confirms all call-site adaptations type-check and `@optimystic/db-core/test` resolves).
- `yarn workspace @optimystic/quereus-plugin-optimystic tsc --noEmit` — 0 errors.
- `reactive-watch.spec.ts` standalone — **7 passing**.
- eslint on all changed files — clean.

**Correctness (checked, no defects):**
- `waitFor` / `waitForValue` control flow evaluates the predicate at least once even at `timeoutMs=0`, checks the deadline *after* each predicate eval (so a slow predicate can't wait past the bound), and leaves no dangling timer when it throws. Sound.
- No export collision in the barrel: `test-transactor.ts` exports only `TestTransactor` / `FlakyCommitTransactor`; `async-wait.ts` exports disjoint names.
- Every integration call site correctly drops the old `const ok = await waitFor(...); expect(ok).to.equal(true)` pattern — throw-on-timeout *is* the assertion now, and captured-variable predicates (`reply`, `result` assigned inside the predicate) still resolve before the outer assertion reads them.
- `substrate-real-libp2p`'s `quorumOn` two-attempt semantics correctly reproduced via try/catch around the throwing `waitFor`.
- The harness (`cohort-topic-mesh-harness.ts`) keeps a boolean-returning `waitFor` wrapper (intentional debt for downstream tickets) whose behavior is equivalent to the old private copy; its remaining positional callers (`live-tier.spec.ts`, `cohort-topic-scale-*.spec.ts`) still compile and match the signature.

**Minor (fixed in this pass):**
- The implement handoff claimed a `// NOTE:` tripwire comment about the 2000ms default had been parked at the `timeoutMs` site in `async-wait.ts`, but no such comment existed — the note lived only in the ticket text (which does not travel to a future reader of the code). Added the `// NOTE:` comment at the `WaitForOptions.timeoutMs` field, per the tripwire convention. Rebuilt + re-linted clean.

**Tripwire (recorded, not a ticket):**
- Short default timeout (2000ms) vs the 10k–90k bounds integration callers require. A new caller that forgets `timeoutMs` gets 2s — surfaces fast locally, but could flake a legitimately-slow wait on a slow CI machine. Parked as the `// NOTE:` comment above (its home is now the code site; this bullet is only the index). The fix, if it ever trips, is an explicit `timeoutMs` at that call site — not a raised global default.

**Style nit (left as-is, not worth churn):**
- `cohort-topic-mesh-harness.ts` both `export { delay } from '@optimystic/db-core/test'` and `import { delay } from '...'` — two module references to the same specifier. Harmless (bundlers dedupe), lint-clean, and disappears when tickets 3–8 retire the wrapper.

**Not run (documented deferral, unchanged from handoff):**
- The db-p2p `*.integration.spec.ts` files gate on `OPTIMYSTIC_INTEGRATION=1` and real libp2p networking — not agent-runnable here. The clean type-check confirms the call-site rewrites are structurally correct; runtime behavior is preserved because throw-on-timeout maps 1:1 onto the old `expect(ok).to.equal(true)`.

**No major findings** — no new fix/plan/backlog tickets filed. The downstream call-site migrations (harness wrapper removal) are already tracked by the plan's tickets 3–8.

## Known follow-on work (pre-existing, tracked elsewhere)

Tickets 3–8 (per the `wall-clock-sleep-test-migration` plan) replace the harness's boolean-returning `waitFor` wrapper call-site-by-call-site with the canonical throw-on-timeout form. Not in scope here.
