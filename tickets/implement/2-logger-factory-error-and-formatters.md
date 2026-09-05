description: Give this package's own log-channel helper the extra features that make it a full replacement for the third-party one some services still use — a separate channel for errors, and support for the shorthand codes log messages use to print peer identities and errors readably.
files: packages/db-p2p/src/logger.ts, packages/db-p2p/test/logger.spec.ts, packages/db-p2p/test/support/capture-log.ts, packages/db-p2p/node_modules/@libp2p/logger/src/index.ts
difficulty: medium
----

# Widen `createLogger` so it can replace libp2p's `forComponent` logger

This is step 1 of 3. It changes only `packages/db-p2p/src/logger.ts` and its spec — no service
is migrated here. Step 2 (`migrate-services-off-libp2p-logger-factory`) does the migration;
step 3 (`lock-and-document-db-p2p-log-namespaces`) adds the guards and docs.

## Background: why two logger factories exist today

`packages/db-p2p` creates `debug` log channels ("namespaces") two ways:

- **`createLogger('x')`** — `src/logger.ts`, backed by the `debug` npm package. Produces
  `optimystic:db-p2p:x`. This is the tree `docs/debugging.md` tells operators to enable with
  `DEBUG=optimystic:db-p2p:*`. ~40 call sites.
- **`components.logger.forComponent('db-p2p:x')`** — libp2p's own `ComponentLogger`, backed by
  the **`weald`** package (a TypeScript port of `debug`, shipped by `@libp2p/logger`). Produces
  the bare `db-p2p:x`, which `optimystic:db-p2p:*` never matches. 9 call sites.

Two consequences that shape this ticket:

1. **`weald` and `debug` are separate modules with separate state.** Both read `process.env.DEBUG`
   at load, so an env-var filter reaches both — but `debug.enable(...)` called from test code (which
   is how `test/support/capture-log.ts` works) reaches only `debug`. Service log lines are therefore
   invisible to every `captureLog`-based spec in this package.
2. **`@libp2p/logger` registers custom format specifiers on `weald`, not on `debug`.** Three call
   sites in this package use them today (`cluster/service.ts`, `repo/service.ts`,
   `dispute/service.ts` all log `'error handling … from %p - %e'`). Moving those lines onto
   `createLogger` without porting the specifiers would print the literal text `%p` and `%e`.

So before any service can be migrated, `createLogger` has to grow the two things `forComponent`
provides that it lacks: a `.error` channel, and the format specifiers.

## What to build

### 1. A `Logger` type with severity sub-channels

`@libp2p/logger`'s `logger(name)` returns `Object.assign(debug(name), { error: debug(name + ':error'), trace, newScope })`.
Mirror the shape that this package actually consumes.

```ts
// packages/db-p2p/src/logger.ts

/**
 * A `debug` channel plus the severity sub-channels libp2p's own `Logger` exposes, so a call site
 * can be moved between the two factories without changing what it calls.
 *
 * `error` and `trace` are ordinary child namespaces (`<namespace>:error`), so a wildcard filter
 * the operator already uses — `optimystic:db-p2p:*` — keeps matching them. An EXACT-match filter
 * (`DEBUG=optimystic:db-p2p:repo-service`) does not; that is the same caveat the peer-id suffix
 * already carries, and `docs/debugging.md` already documents it.
 */
export interface Logger extends debug.Debugger {
	error: debug.Debugger
	trace: debug.Debugger
}

export function createLogger(subNamespace: string, peerId?: string): Logger
```

Every existing `createLogger` call site keeps working unchanged: `Logger` is a superset of
`debug.Debugger`, so the ~40 sites that treat the result as a plain callable are unaffected, as is
`test/logger.spec.ts`'s `.namespace` assertion.

Implementation note — build the result with `Object.assign(debug(ns), { error: …, trace: … })`.
`debug` defines `enabled` as an **accessor property on the returned function object**; `Object.assign`
copies own enumerable properties from the *sources* onto the target, so the target's own `enabled`
accessor survives. (This is exactly what `@libp2p/logger` does with `weald`.) Do not build the
object the other way round — spreading a `Debugger` into a fresh object flattens `enabled` to a
snapshot boolean and breaks any future `if (log.enabled)` guard.

Unlike libp2p, do **not** conditionally disable `trace`: libp2p builds a no-op stub unless a
`:trace` namespace is explicitly enabled, but a plain disabled `debug` channel is already
near-free, and the conditional version reads its enablement once at construction, which makes it
wrong for anything constructed before `DEBUG` is set.

Nothing in `packages/*/src` calls `.trace`, `.newScope`, `.info`, `.warn` or `.debug` on a service
logger today (only `.error`, at 8 sites). `trace` is included anyway so the returned object stays
structurally assignable to `@libp2p/interface`'s `Logger`, which keeps the door open for handing
one of ours to a libp2p helper. `newScope` is deliberately omitted — nothing uses it, and
`createLogger('parent:child')` already expresses the same thing.

### 2. Port libp2p's format specifiers onto `debug`

`@libp2p/logger`'s `src/index.ts` registers these on `weald.formatters` at module load. Register
the equivalents on `debug.formatters` at the top of `src/logger.ts` (MIT-licensed source, same
license as this repo — port, don't re-derive):

| Specifier | Formats | Notes |
|---|---|---|
| `%p` | `PeerId` | `v == null ? 'undefined' : v.toString()` |
| `%a` | `Multiaddr` | same shape |
| `%c` | `CID` | same shape |
| `%b` | `Uint8Array` → base58btc | `multiformats/bases/base58` (already a dependency) |
| `%t` | `Uint8Array` → base32 | `multiformats/bases/base32` |
| `%m` | `Uint8Array` → base64 | `multiformats/bases/base64` |
| `%e` | `Error` | message + stack, de-duplicated when the stack already contains the message; `AggregateError` expands each inner error, indented |

`%p`/`%a`/`%c` need only *type-only* imports (`import type { PeerId } from '@libp2p/interface'`),
so they cost nothing at runtime. `%e` is the only one with real logic — port `formatError`,
`isAggregateError` and `printError` from `@libp2p/logger`.

Deliberately **not** ported: `%k` (`interface-datastore`'s `Key`). `interface-datastore` is not a
declared dependency of this package and no call site formats one. Say so in a comment at the
registration block so the omission reads as a decision rather than an oversight.

Add a comment recording the module-instance boundary:

```ts
// NOTE: these are registered on the `debug` module instance THIS file imports. libp2p's own
// loggers use `weald` (via @libp2p/logger) and carry their own copy — the two registries are
// independent, and enabling one from test code does not enable the other.
```

Whether the other packages' `logger.ts` files (`db-core`, the four storage backends,
`quereus-plugin-optimystic`) resolve to the same hoisted `debug` instance is not something to rely
on; register here because this is the package whose call sites use the specifiers.

## Edge cases & interactions

- **`Object.assign` and `enabled`** — see above. A regression here is silent: `log.enabled` would
  freeze at its construction-time value. Not currently read on a db-p2p service logger, but
  `db-core`/`quereus-plugin` gate expensive payload construction on it, so the idiom is live in the
  repo and will migrate here eventually.
- **Peer-id-suffixed namespaces.** `createLogger('x', peerId)` yields
  `optimystic:db-p2p:x:12D3KooWAb`; its error channel must be
  `optimystic:db-p2p:x:12D3KooWAb:error` — the suffix goes *before* `:error`, since `:error` is a
  child of the concrete channel. Pin both orderings.
- **`captureLog` and the `:error` child.** `test/support/capture-log.ts` enables
  `optimystic:db-p2p:<n>` **and** `optimystic:db-p2p:<n>:*`, so an `:error` line is captured by an
  existing `captureLog('<n>', …)` with no helper change. Confirm this rather than assuming it —
  if it does not hold, widen `capture-log.ts`, because step 2 depends on it.
- **Formatter substitution happens before the sink.** `debug` resolves its own formatters and then
  calls `debug.log(...)`; `captureLog` replaces `debug.log`. So a captured `args[0]` arrives with
  `%p`/`%e` **already substituted**, while `%s`/`%d` are still literal (that is why
  `formatCaptured` exists). Assertions on `%p`/`%e` output can read `args[0]` directly; do not be
  surprised that `%s` behaves differently in the same line.
- **`%e` on a non-`Error`.** A call site can pass anything. `printError` reads `.message`/`.stack`;
  a plain string or `undefined` must not throw — a logger that throws turns a caught error into an
  uncaught one at exactly the site that was trying to report it. Pin `undefined`, a bare string,
  and an `Error` with no stack.
- **`AggregateError` with an empty `errors` array** — libp2p's port prints `[Error list was empty]`.
  Keep that; it is the difference between "no inner errors" and "the expansion silently did nothing".
- **Idempotent registration.** `debug.formatters.x = fn` is a plain assignment, so a double import
  is harmless. But if another package's `logger.ts` resolves to the same hoisted `debug` and later
  registers a *different* `%e`, last-write-wins. No such registration exists today; do not add a
  guard, just do not assume exclusivity.
- **React Native / browser builds.** `src/rn.ts` re-exports part of this package. `multiformats` is
  already a dependency used throughout, and `debug` already works in these builds, so the three
  base-encoding imports add no new platform risk — but keep them as static top-level imports rather
  than lazy ones, so a bundler can tree-shake normally.

## Tests

Extend `packages/db-p2p/test/logger.spec.ts` (it already owns `createLogger`'s contract and has
`captureLog`/`formatCaptured` imported).

- `createLogger('x').error.namespace === 'optimystic:db-p2p:x:error'`; likewise `.trace`.
- With a peer id: `createLogger('x', peerId).error.namespace` ends `:<12-char peer id>:error`.
- The existing bare/suffixed `.namespace` assertions still pass (regression guard on the
  `Object.assign` rewrite).
- `log.enabled` is still a live accessor: enable the namespace, read `true`; disable, read `false`
  on the **same** logger object.
- **Round-trip through `captureLog`:** `captureLog('fmt-probe', …)` while calling
  `log.error('from %p - %e', peerId, err)`; assert the captured text contains the full peer-id
  string and the error's message. Expected before the port: the literal `%p`/`%e` survive
  unformatted — that failure mode is the whole reason this ticket exists, so the assertion must
  read the substituted text, not merely that *a* line was captured.
- `%b`/`%t`/`%m` each encode a fixed `Uint8Array` to its known base58btc / base32 / base64 string.
- `%e` cases: `undefined` → `'undefined'`; a plain string → does not throw; an `AggregateError`
  with two inner errors → both inner messages appear; an `AggregateError` with none →
  `[Error list was empty]`.
- A `captureLog('x', …)` capture picks up a line written to `log.error` without any change to
  `capture-log.ts` (this is the assumption step 2 is built on — pin it here).

## TODO

- Add the `Logger` interface to `packages/db-p2p/src/logger.ts` and return it from `createLogger`,
  built with `Object.assign(debug(ns), { error, trace })`.
- Port `%p`, `%a`, `%c`, `%b`, `%t`, `%m`, `%e` from `@libp2p/logger`'s `src/index.ts` onto
  `debug.formatters`; comment the `%k` omission and the `debug`-vs-`weald` registry boundary.
- Extend `test/logger.spec.ts` with the cases above.
- Confirm `captureLog` already captures the `:error` child; widen `test/support/capture-log.ts`
  only if it does not. (`debt-three-copies-of-the-log-capture-test-helper` in `backlog/` proposes
  moving that helper to a shared home. Independent of this work — do not do it here, but keep any
  edit to the helper small and self-contained so it is cheap to relocate later.)
- Run `yarn workspace @optimystic/db-p2p test`, then `yarn build` and `yarn typecheck` from root
  (the widened return type touches every `createLogger` consumer's inferred types).
