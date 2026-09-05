description: The package's own log-channel helper now has the two features it was missing compared to the third-party one some services still use — a separate channel for error messages, and support for the shorthand codes log messages use to print peer identities and errors readably. Needs a review pass before services are moved over.
files: packages/db-p2p/src/logger.ts, packages/db-p2p/test/logger.spec.ts
difficulty: medium
----

# Review: `createLogger` widened to replace libp2p's `forComponent` logger

Step 1 of 3. **No service was migrated here** — that is `migrate-services-off-libp2p-logger-factory`
(already sitting in `implement/` as `2.1-…`), which lists this ticket as its `prereq:`. Step 3 is
`lock-and-document-db-p2p-log-namespaces` (`2.2-…`). Only `src/logger.ts` and its spec changed.

## What the problem was

`packages/db-p2p` builds `debug` log channels ("namespaces") two ways:

- `createLogger('x')` — this package's own helper, backed by the **`debug`** npm package. Produces
  `optimystic:db-p2p:x`, which is the tree `docs/debugging.md` tells operators to switch on with
  `DEBUG=optimystic:db-p2p:*`. ~40 call sites.
- `components.logger.forComponent('db-p2p:x')` — libp2p's own logger, backed by **`weald`** (a
  separate TypeScript port of `debug`, shipped inside `@libp2p/logger`). Produces the bare
  `db-p2p:x`, which `optimystic:db-p2p:*` never matches. 9 call sites — confirmed by grep, listed
  below.

Before any of those 9 could move, `createLogger` had to grow the two things `forComponent` gives
them and it lacked: a `.error` sub-channel, and the custom format specifiers.

## What changed

### 1. `createLogger` returns a `Logger` with `.error` / `.trace`

```ts
export interface Logger extends debug.Debugger {
	error: debug.Debugger
	trace: debug.Debugger
}

export function createLogger(subNamespace: string, peerId?: string): Logger
```

Built with `Object.assign(debug(ns), { error: debug(`${ns}:error`), trace: debug(`${ns}:trace`) })`.
`Logger` is a superset of `debug.Debugger`, so all ~40 existing call sites are untouched.

`newScope` is deliberately omitted (nothing calls it; `createLogger('parent:child')` says the same
thing). `trace` is always a real channel — libp2p stubs it out unless a `:trace` namespace is
enabled at construction time, which is wrong for anything built before `DEBUG` is set.

### 2. Format specifiers ported from `@libp2p/logger` onto `debug.formatters`

`%p` (PeerId), `%a` (Multiaddr), `%c` (CID), `%b` (base58btc), `%t` (base32), `%m` (base64),
`%e` (Error, incl. `AggregateError` expansion). `%k` (`interface-datastore`'s `Key`) deliberately
skipped — not a declared dependency, no call site formats one; there is a comment saying so.

`%p`/`%a`/`%c` are type-only imports, so they cost nothing at runtime. `%b`/`%t`/`%m` pull three
static top-level imports from `multiformats`, already a dependency (`base58btc` was already
imported by `src/dispute/dispute-service.ts`).

### 3. One deliberate deviation from the upstream port — please review this specifically

The ticket's contract for `%e` was "must never throw — a logger that throws turns a caught error
into an uncaught one at exactly the site that was trying to report it." The faithful port does not
meet that: `formatError`'s last resort is `` `${v.toString()}` ``, which raises on a null-prototype
object (`throw Object.create(null)` is legal JavaScript, and every `%e` site here is a catch block
where `err` is `unknown`). I wrapped the `%e` formatter body in `try/catch` returning
`'[unformattable error]'`.

**Reviewer call:** whether to keep this, and whether `'[unformattable error]'` is the right
sentinel. Upstream libp2p propagates the throw.

A symbol turned out *not* to be in that class — `Symbol.prototype.toString` exists, so
`v.toString()` returns a string and the template interpolates it safely (`Symbol(nope)`). My first
draft assumed otherwise and the test caught it. Both behaviours are now pinned so it is not
re-litigated.

## Validation performed

All from repo root unless noted, all green:

| Command | Result |
|---|---|
| `yarn workspace @optimystic/db-p2p test` | 2539 passing, 49 pending, **0 failing** |
| `yarn typecheck` | clean |
| `yarn build` | clean |
| `yarn lint` | clean |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

`test/logger.spec.ts` went from 10 to 22 tests. New coverage:

- `.error` / `.trace` namespaces, bare and peer-id-suffixed. The suffix goes **before** `:error`
  (`…:x:12D3KooWAb:error`), since `:error` is a child of the concrete channel — both orderings pinned.
- `enabled` stays a **live accessor** across the `Object.assign` rewrite: constructed while disabled
  → `false`; later `debug.enable(...)` → the same object reads `true`; later `disable()` → `false`.
  Also pins that an exact-match filter does *not* reach `:error` but a wildcard one does.
- `%p` + `%e` round-tripped through `captureLog`, asserting the **substituted** text (peer-id string
  present, error message present, and `%p`/`%e` **absent**) — not merely that a line was captured.
- `%a`/`%c`; `%b`/`%t`/`%m` against hardcoded expected encodings of a fixed 7-byte array.
- `%e` on: plain Error, `undefined`, a missing argument, a bare string, a stackless Error,
  a null-prototype object, a symbol, `AggregateError` with two inner errors, `AggregateError` with
  none (`[Error list was empty]`).
- `captureLog('<n>', …)` picks up a `.error` line **with no change to `test/support/capture-log.ts`**
  — the helper already enables `optimystic:db-p2p:<n>` *and* `…:<n>:*`, and `:error` matches the
  wildcard. This was the assumption step 2 is built on; it holds, and the helper was left untouched.

### Guards checked empirically, not just by reading code

I verified with a standalone script that unregistered specifiers really do survive literally
(`%p`/`%e` present in output → the new assertions would genuinely fail without the port), and that
`Object.getOwnPropertyDescriptor(log, 'enabled').get` exists, survives `Object.assign`, and is
**lost** by object spread. So the `Object.assign`-not-spread comment in the source is a measured
claim, not a repeated assertion.

## Known gaps — treat these as the starting point, not a finish line

- **Node-only.** No browser or React Native build was exercised. The `%c` specifier is worth a look:
  `debug`'s *browser* `formatArgs` injects its own `%c` CSS directives into `args[0]`. Reading
  `debug`'s `common.js`, formatters run **before** `formatArgs`, so there is no double-substitution
  — but that is from source reading, not from running a browser build. Upstream libp2p has exactly
  the same shape, so this is not a regression, just untested.
- **`trace` cost unmeasured.** Every `createLogger` call now builds 2 extra `Debugger` objects
  (~40 sites → ~80 objects at import). Per-instance cost is an object plus `selectColor`; the regex
  compilation lives in `enable()`, not per instance. I did not benchmark it.
- **Registration is an import side effect.** `debug.formatters` is populated when `src/logger.ts`
  loads. Anything formatting `%p`/`%e` must have imported it first (directly or transitively). Every
  current `%e` site will, once step 2 lands. Per the ticket, no guard was added — a second
  registration of a *different* `%e` elsewhere would be last-write-wins. None exists today.
- **`isAggregateError(err?: any)` keeps upstream's `any`.** Lint and typecheck are clean, but it is
  a wart carried over verbatim.
- **The `enabled` test mutates global `debug` state.** It saves and restores via
  `debug.disable()` / `enable(previous)`, the same pattern `captureLog` uses. Serial mocha only; it
  would be racy under a parallel runner.
- **`src/logger.ts` is not re-exported** from `src/index.ts` or `src/rn.ts` (verified by grep), so
  `Logger` is *not* new public API surface and cannot collide with another exported `Logger`. Worth
  re-confirming if step 3 changes the barrel.

## Call sites step 2 will move (recorded here so step 2 need not re-grep)

Six service constructors:
`cluster/service.ts:97`, `repo/service.ts:108`, `sync/service.ts:56`, `dispute/service.ts:51`,
`network/network-manager-service.ts:48`, `cluster/block-transfer-service.ts:251`.

Three optional-call sites in `libp2p-node-base.ts`: lines `1085`, `1111`, `1396`.

The four lines that actually use the newly ported specifiers — the ones that would have printed
literal `%p`/`%e` without this work — are `cluster/service.ts:273` and `:303`,
`dispute/service.ts:121`, `repo/service.ts:327`.

## Review focus

- The `%e` try/catch deviation and its sentinel string (section 3 above).
- Whether always-on `trace` is right, versus libp2p's conditional stub.
- That the ported `formatError` / `printError` / `isAggregateError` match upstream semantics —
  they were copied, not re-derived, but a second pair of eyes on the indentation arithmetic in the
  `AggregateError` branch is worthwhile.
- Whether the hardcoded base-encoding expectations (`1W7N4wCi` / `aaaqea77qadq` / `AAECA/+ABw` for
  `[0,1,2,3,255,128,7]`) should instead call the encoders — hardcoding is the stronger guard but
  reads as magic.
