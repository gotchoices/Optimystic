----
description: The test suite has six near-identical copies of a "poll until this becomes true" helper and no shared home for them; create one canonical, well-tested helper so the later sleep-removal tickets all import the same thing.
prereq:
files: packages/db-core/src/testing/test-transactor.ts, packages/db-core/package.json, packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts, packages/db-p2p/test/multi-coordinator-write.integration.spec.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts
difficulty: easy
----

Foundation ticket for the wall-clock-sleep migration. This one adds no behavioral test changes — it creates the shared condition-polling helper that the later batches (tickets 3–8) import, and replaces the scattered private copies with re-exports so the migration has a single canonical source.

## Background

There are at least six hand-rolled `waitFor` / `waitUntil` helpers, each with slightly different signatures and defaults:

- `packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts:62` — `waitFor(predicate, timeoutMs=2000, intervalMs=5): Promise<boolean>` (the most-used shape; returns a boolean, callers assert `.to.be.true`).
- `packages/db-p2p/test/multi-coordinator-write.integration.spec.ts:64`, `multi-coordinator-cross-network-write.integration.spec.ts:56`, `multi-coordinator-write-relay.integration.spec.ts:45`, `real-libp2p.integration.spec.ts:94`, `substrate-real-libp2p.integration.spec.ts:128` — `waitFor(predicate, timeoutMs, intervalMs=250)` variants.
- `packages/quereus-plugin-optimystic/test/reactive-watch.spec.ts:67` — `waitUntil(pred, timeoutMs=1000, stepMs=5)`.

They also each define a private `delay = (ms) => new Promise(r => setTimeout(r, ms))`.

## Design

Create `packages/db-core/src/testing/async-wait.ts`. db-core is a dependency of every package that has these tests (db-p2p, quereus-plugin-optimystic, reference-peer), and db-core already publishes a `./test` subpath export (`package.json` → `exports["./test"]` → `dist/src/testing/test-transactor.js`). Extend that export so `import { waitFor, waitForValue, delay } from '@optimystic/db-core/test'` resolves everywhere.

Canonical surface:

```ts
export interface WaitForOptions {
  /** Upper bound before the poll gives up. Default 2_000. */
  timeoutMs?: number;
  /** Poll cadence. Default 10. */
  intervalMs?: number;
  /** Included in the thrown message so a failure says WHAT never became true. */
  description?: string;
}

/**
 * Poll `predicate` until it returns true or `timeoutMs` elapses. Bounded: a predicate that never
 * becomes true THROWS (with `description`) rather than hanging until the runner idle-timeout kills
 * the whole run. `predicate` may be sync or async.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts?: WaitForOptions,
): Promise<void>;

/**
 * Poll `fn` until it returns a non-undefined value (or timeout → throw). Returns the value. Use for
 * "wait until X appears" where the test then needs X.
 */
export async function waitForValue<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  opts?: WaitForOptions,
): Promise<T>;

/** Real-time sleep. Retained ONLY for the residual cases a fake clock / condition poll cannot cover;
 *  new code should prefer waitFor. */
export const delay: (ms: number) => Promise<void>;
```

Design decisions (settle these here so downstream tickets don't each re-litigate):

- **Throw on timeout, not return `false`.** The migration edge-case list requires that a genuinely-broken condition fails the test with a clear message instead of hanging or passing vacuously. A boolean return invites callers to forget the assertion. The old `waitFor` returned a boolean; downstream tickets will rewrite `expect(await waitFor(...)).to.be.true` into a bare `await waitFor(..., { description })`.
- **Default `timeoutMs = 2_000`** (matches the dominant existing default). Integration/real-network callers pass larger explicit values; they must keep doing so.
- **`intervalMs` default 10** (compromise between the 5 and 250 in existing copies; explicit override where a slower poll is wanted).
- The helper still uses real `setTimeout` internally — that is correct and unavoidable for condition polling; the point is a *bounded* real wait keyed to an observable predicate, not a fixed padded sleep.

Then replace the private copies with re-exports (do NOT change any test's assertions in this ticket — only swap the helper definition for an import, adjusting call sites mechanically for the new `opts` object + throw-vs-boolean contract):

- `cohort-topic-mesh-harness.ts` — re-export `waitFor`/`delay` from the new module (harness is widely imported; keep the named exports stable).
- The five integration specs + `reactive-watch.spec.ts` — delete the private helper, import the canonical one. `reactive-watch`'s `waitUntil` callers become `waitFor`.

## Edge cases & interactions

- **Bounded timeout is the whole point** — the throw path must be unit-tested: a predicate that is always `false` must reject within ~`timeoutMs`, not hang.
- **Async predicate** — a predicate returning a `Promise<boolean>` must be awaited each poll (some existing callers pass async predicates); a thrown/rejected predicate must propagate, not be swallowed.
- **`waitForValue` and `undefined`** — a legitimately-`undefined` sentinel value must be distinguishable; document that `undefined` means "not ready yet" and callers needing to wait for an actual `undefined` should use `waitFor` on a separate flag.
- **Export map** — after editing `package.json` exports, the built `dist/` path must exist; verify `yarn build` (or the package's build step) emits `dist/src/testing/async-wait.js` and that the `./test` (or new `./test/async-wait`) subpath resolves at type-check time from a consuming package.
- **No assertion drift** — swapping helper internals must not change what any migrated-later suite asserts; this ticket is a pure consolidation. Every touched suite must still pass unchanged.

## TODO

- Add `packages/db-core/src/testing/async-wait.ts` with `waitFor`, `waitForValue`, `delay` as specified.
- Extend `packages/db-core/package.json` `exports` so the helper is importable as `@optimystic/db-core/test` (or a dedicated subpath); confirm the built path resolves.
- Add a focused unit spec for the helpers: resolves-when-true, throws-on-timeout (bounded), async-predicate, `waitForValue` returns the value / throws on timeout.
- Replace the private `waitFor`/`delay` in `cohort-topic-mesh-harness.ts` with re-exports of the canonical ones (keep named exports stable).
- Replace private helpers + call sites in the five `*.integration.spec.ts` files and `reactive-watch.spec.ts` with the canonical import; adapt call sites to the `opts` object and throw-on-timeout contract without changing assertions.
- Run the affected packages' test + type-check; confirm all touched suites still pass.
