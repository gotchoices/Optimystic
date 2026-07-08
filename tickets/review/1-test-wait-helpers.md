----
description: Review the canonical wait-helper consolidation — new async-wait module, package export extension, unit tests, and migration of six private copies across five packages.
files: packages/db-core/src/testing/async-wait.ts, packages/db-core/src/testing/index.ts, packages/db-core/test/async-wait.spec.ts, packages/db-core/package.json, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/multi-coordinator-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-cross-network-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts, packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts
----

## What was done

Created a canonical condition-polling helper in `packages/db-core/src/testing/async-wait.ts` and replaced six private copies across the test suite with imports from `@optimystic/db-core/test`.

### New module: `async-wait.ts`

Exports:
- `waitFor(predicate, opts?)` — polls until true, **throws** `Error` on timeout (void return). Accepts sync or async predicate.
- `waitForValue<T>(fn, opts?)` — polls until non-undefined, throws on timeout, returns `T`.
- `delay(ms)` — real-time sleep, for absence-check cases that cannot use a predicate.
- `WaitForOptions` — `{ timeoutMs?: number, intervalMs?: number, description?: string }` defaults: 2000ms / 10ms.

### Package export change

`packages/db-core/package.json` `./test` subpath now points to a new barrel (`dist/src/testing/index.ts`) that re-exports both `test-transactor` and `async-wait`. Previously it pointed directly to `test-transactor.js`.

### Unit tests

`packages/db-core/test/async-wait.spec.ts` covers: resolves immediately, resolves once predicate flips, throws on timeout, includes `description` in thrown message, async predicate, predicate rejection propagates, `waitForValue` returns value, `waitForValue` throws on timeout, `waitForValue` with async fn.

### Migration of private copies

| File | Change |
|---|---|
| `cohort-topic-mesh-harness.ts` | Replaced private `delay`/`waitFor` with canonical `delay` import + **boolean-returning backward-compat wrapper** for non-touched callers (`live-tier.spec.ts`, `cohort-topic-scale-*.spec.ts`). Tickets 3–8 replace those call sites. |
| `multi-coordinator-write.integration.spec.ts` | 4 call sites adapted to `opts` form; boolean-return assertions dropped (throw-on-timeout is now the assertion). |
| `multi-coordinator-cross-network-write.integration.spec.ts` | 3 call sites adapted. |
| `multi-coordinator-write-relay.integration.spec.ts` | 2 call sites adapted. |
| `real-libp2p.integration.spec.ts` | 6 call sites adapted. |
| `substrate-real-libp2p.integration.spec.ts` | 10 call sites adapted. `quorumOn()` helper (two-attempt semantics) converted to try/catch around `waitFor`. Also imports `delay` for `seedWillingness` (fixed-duration wait). |
| `reactive-watch.spec.ts` | Private `waitUntil` removed. 5 wake-and-assert call sites → `waitFor` with `description`. 4 absence-check call sites (`await waitUntil(…, N)`) → `await delay(N)`. |

### Validation

- `yarn workspace @optimystic/db-core build` — clean (0 errors), emits `dist/src/testing/index.js`, `dist/src/testing/async-wait.js`, `.d.ts` files.
- `yarn workspace @optimystic/db-core test` — **1266 passing** (includes `async-wait.spec.ts`).
- `yarn workspace @optimystic/db-p2p tsc --noEmit` — **0 errors** (confirms `@optimystic/db-core/test` resolves from db-p2p).
- `reactive-watch.spec.ts` standalone run — **7 passing**.

### Known gaps / handoff notes

- **db-p2p integration specs not run** — `real-libp2p.integration.spec.ts`, `substrate-real-libp2p.integration.spec.ts`, `multi-coordinator-*.integration.spec.ts`, and `multi-coordinator-write-relay.integration.spec.ts` require `OPTIMYSTIC_INTEGRATION=1` and real libp2p networking; not run here. The type-check is clean so call-site adaptations are structurally correct.
- **`cohort-topic-mesh-harness.ts` backward-compat wrapper** — intentional debt; tickets 3–8 remove it call-site-by-call-site. The wrapper uses canonical `delay` internally so it is functionally equivalent to the old private copy.
- **`quereus-plugin-optimystic` full test suite** — was running in background at handoff; the `reactive-watch.spec.ts` subset passed in isolation (7/7). The full suite includes heavy integration tests (3-node mesh spin-up) unrelated to this ticket.

## Review findings

- **Tripwire (timeout default)**: `waitFor` and `waitForValue` both default `timeoutMs=2000`. Integration callers that previously used 20 000ms–60 000ms all pass explicit values; new callers that forget to pass a value will hit the 2 s wall quickly in dev (surfacing the bug), but if a slow CI machine needs more time this default could cause flakes. Parked as `// NOTE:` comment at the `timeoutMs` default site in `async-wait.ts`.
- **`waitForValue` and `undefined` sentinel**: documented in the `WaitForOptions` doc-comment; no callers of `waitForValue` yet (the function exists for tickets 3–8).
- No other findings.
