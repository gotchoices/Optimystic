description: On React Native there is no way to turn on our debug logging, and nothing says so, so an empty log looks exactly like "that code never ran". Add one function that turns our logging on everywhere it lives, confirms what it turned on, and document it as the way to enable logging anywhere without environment variables.
prereq:
files:
  - packages/db-core/src/logger-registry.ts (new — the shared registry and the public enable/disable functions)
  - packages/db-core/src/logger.ts (register its `debug` copy)
  - packages/db-core/src/index.ts (export the registry module)
  - packages/db-p2p/src/logger.ts (register; correct the formatter NOTE)
  - packages/db-p2p-storage-rn/src/logger.ts, packages/db-p2p-storage-web/src/logger.ts, packages/db-p2p-storage-ns/src/logger.ts, packages/db-p2p-storage-fs/src/logger.ts, packages/quereus-plugin-optimystic/src/logger.ts (register)
  - packages/reference-peer/src/cli.ts (register its direct `debug` import)
  - packages/db-core/test/logger-registry.spec.ts (new — registry semantics with fake modules)
  - packages/db-p2p/test/logging-enable.spec.ts (new — real fan-out across two distinct `debug` copies)
  - packages/db-p2p/test/logger.spec.ts (static guard: every `debug` import site registers)
  - docs/debugging.md (rewrite the enabling section; correct the "specifiers reach every package" claim)
  - .yarnrc.yml (read-only context: `nmHoistingLimits: workspaces`)
  - eslint.config.js (read-only context: `no-console` and the direct-`debug`-import ban)
difficulty: medium
----

# One call that turns on every Optimystic log channel, on any runtime

Split out of the plan ticket `logging-cannot-be-turned-on-in-react-native`, reported by `risavian` on GitHub issue #8. The sibling `document-log-fields-that-say-which-case-you-are-in` covers the log-field half. It is independent of this ticket.

## Why

`debug`'s browser build is the one Metro picks (via the package's `browser` field). It turns namespaces on only from `localStorage.debug` or `process.env.DEBUG`. React Native has no `localStorage`: the read throws inside `debug`'s own try/catch (`load()` in `debug/src/browser.js`), and Metro never sets `process.env.DEBUG`. So every `optimystic:*` channel is off, silently. A device capture then comes back empty whether or not the code ran, and two app teams reasoned from such captures before they found out. `docs/debugging.md` documents only `DEBUG=`, so following our own guide leads into this.

## What planning established (verified, not inferred)

- **Each package loads its own `debug` copy in this repo.** `.yarnrc.yml` sets `nmHoistingLimits: workspaces`, so `packages/db-core/node_modules/debug` and `packages/db-p2p/node_modules/debug` are separate physical copies. A Node check from `packages/db-p2p` resolved db-core's `debug` via `createRequire(import.meta.resolve('@optimystic/db-core'))` and found it `!==` db-p2p's own. A consumer's bundler may or may not dedupe these. Metro, pnpm and hoisting limits all vary. **So one `debug.enable()` call cannot be relied on to reach every namespace, and a consumer calling `require('debug').enable(...)` enables only their own resolved copy.** Documenting that recipe would give people something that only usually works. That is why we export a helper.
- **The same fact makes an existing NOTE and doc sentence wrong.** The NOTE at the top of `packages/db-p2p/src/logger.ts` ("the other six packages' `createLogger` factories import the same `debug` module — so importing this file makes `%p`/`%e`/… work from their loggers too") is false under this repo's own install. So is the closing paragraph of `docs/debugging.md` § "Severity sub-channels and extra specifiers" ("the specifiers reach every package's logger in a process that loaded `db-p2p`"). No package outside db-p2p uses those specifiers today (grepped), so nothing is broken. Correct both statements to "whether they reach other packages depends on whether the install dedupes `debug`; use them only in db-p2p". Do not add cross-copy formatter registration.
- **Enabling after construction works.** In `debug` 4.4 (`src/common.js`), `enabled` is a live accessor that re-evaluates whenever `createDebug.namespaces` changes, and `packages/db-p2p/test/logger.spec.ts` already pins that for `createLogger`. So for a copy that is already registered, enable-then-construct and construct-then-enable both work. The remaining order risk is a package whose `logger.ts` **loads after** the enable call (a lazy import). The registry below closes it.
- **Colors won't leak `%c` CSS into RN output.** `useColors()` in `debug/src/browser.js` returns false when there is no `document` and no firebug/webkit user agent, which is RN's situation.
- **libp2p is a separate system.** Its loggers use `weald` via `@libp2p/logger`, which has the same `localStorage`/`process.env.DEBUG` dependence and exports its own `enable(namespaces)`. db-core does not depend on libp2p, so the helper does **not** reach `libp2p:*`. The docs must say so and show `import { enable } from '@libp2p/logger'`. Also caveat that libp2p may carry several copies of that module as well.

## Design

### The registry (`packages/db-core/src/logger-registry.ts`, new)

A process-wide registry lives on `globalThis` under `Symbol.for('@optimystic/logger-registry')`, **not** in module scope, so it survives a bundle that ends up with two copies of db-core itself. It must import nothing from db-core, because `test/barrel-import-cycle.spec.ts` guards cycles. Each package's `src/logger.ts` registers the `debug` copy **it** imported, so the coverage follows from each package registering its own copy and does not depend on how the install was laid out.

```ts
/** The slice of a `debug` module this registry drives. Structural, so db-core never type-imports a particular copy. */
export interface DebugModule {
	enable(namespaces: string): void;
	disable(): string;              // debug 4.x returns the namespaces that were active
	log: (...args: any[]) => any;
}

export interface OptimysticLoggingOptions {
	/**
	 * Where log lines go. Default: leave each copy's own sink (stderr on Node; `console.debug` in the
	 * browser/RN build). Pass one when the platform hides that sink (e.g. a device log filtered above
	 * debug level) or to collect a capture in memory.
	 */
	log?: (...args: unknown[]) => void;
}

export interface OptimysticLoggingReport {
	namespaces: string;              // the Optimystic contribution, comma-joined
	copies: string[][];              // one entry per distinct debug copy: the packages that registered it
}

/** Called once from each package's src/logger.ts at module load. Idempotent per (owner, module). */
export function registerDebugModule(owner: string, module: DebugModule): void;
/** Turn on the given namespaces on every registered debug copy, now and for copies that register later. */
export function enableOptimysticLogging(namespaces: string | readonly string[], options?: OptimysticLoggingOptions): OptimysticLoggingReport;
/** Undo it: every copy goes back to what it had enabled before the first enable call, and its original sink. */
export function disableOptimysticLogging(): void;
```

The name is `enableOptimysticLogging` rather than `enableLogging`. It is exported from db-core's root barrel next to unrelated symbols, and a consumer file that also imports `debug` needs to be able to tell them apart. db-core is the right home because every logger-owning package already depends on it, as does `reference-peer`. Because the state is global, calling it from any copy of db-core reaches everything.

Semantics. Settle these exactly as written. The reviewer checks against this list.

- **Adds; does not replace.** `debug.enable` replaces the whole namespace set of its copy. If our package shares a hoisted copy with the consumer's own `myapp:*` channels, a replacing enable would silently turn *their* logging off, which is the same family of silent failure this ticket fixes. So on the first touch, per copy, capture its current set as a **baseline** (`m.disable()` returns it). Then set `baseline + ',' + ours` (skip empty parts). A second `enableOptimysticLogging` call replaces **our** contribution only, and the baseline stays as captured.
- **`disableOptimysticLogging`** restores each copy to its baseline and its original `log` sink, then clears the pending state. It is safe to call with nothing enabled.
- **Pending state for late registrants.** The registry keeps `{ namespaces, log }` from the last enable call. `registerDebugModule` on a module that arrives afterwards applies it immediately, capturing that copy's baseline first. It does this silently, with no second confirmation line. If no enable call has happened, registration touches nothing, so Node users on `DEBUG=` are unaffected.
- **Deduplicated by module identity.** Several packages sharing one hoisted copy is one entry, with every owner recorded. That is what makes `copies` in the report informative: `[['db-core','db-p2p','db-p2p-storage-rn']]` vs `[['db-core'],['db-p2p'],…]`.
- **`options.log`** is installed as the `log` property on each copy (the `debug` module's default sink, the same property `test/support/capture-log.ts` swaps). The original is remembered for disable. It is applied to late registrants too.
- **Confirmation line. Always emitted, once per enable call, deliberately not through a namespace filter.** The whole defect is that silence is ambiguous. Write it through the same sink the log lines will use: `options.log` if given, else the first registered copy's `log`. That makes the three outcomes readable. No confirmation line means the helper wasn't called or the sink is swallowed. A confirmation line with no events means the code did not run, or the filter didn't match. Events mean it works. The line is one plain string, e.g. `optimystic logging on: "optimystic:*" across 3 debug copies [db-core | db-p2p | db-p2p-storage-rn]; libp2p:* is separate, see docs/debugging.md`. If no copy is registered yet, fall back to `console.log` and say that namespaces will apply as packages load. That fallback needs an `// eslint-disable-next-line no-console` with a one-line reason, because `packages/*/src` bans `console`. There is no quiet option: tests stub the sink or read the report.
- **`namespaces` as an array** is comma-joined. Leading and trailing whitespace per entry is trimmed. An empty result is equivalent to disabling our contribution. It is not an error.

### Registration sites

Add one `registerDebugModule('<package short name>', debug)` line after the `debug` import in each of: `packages/db-core/src/logger.ts`, `packages/db-p2p/src/logger.ts`, `packages/db-p2p-storage-{rn,web,ns,fs}/src/logger.ts`, `packages/quereus-plugin-optimystic/src/logger.ts`, and `packages/reference-peer/src/cli.ts`. Use the owner names from each file's `BASE_NAMESPACE` (`db-core`, `db-p2p`, `db-p2p-storage-rn`, …, `quereus-plugin`, `ref-peer`). These are exactly the files `eslint.config.js` permits to import `debug`.

## Docs (`docs/debugging.md`)

Replace the single sentence "Logging is controlled via the `DEBUG` environment variable." with a `## Turning logging on` section, placed before § Namespaces:

- **Node:** `DEBUG=…` as today. All existing `DEBUG=` examples stay valid.
- **React Native, and any runtime without `process.env`:** `enableOptimysticLogging('optimystic:*')` from `@optimystic/db-core`, called early (app entry). State plainly: *React Native cannot use `DEBUG=`, and without this call every `optimystic:` channel is silently off, so an empty capture proves nothing.* Give the one-sentence reason (no `localStorage`, Metro never sets `process.env.DEBUG`). Show the `log` option for routing output into your own capture. Say the confirmation line is the first thing to look for, and what each of the three outcomes means.
- **Browsers:** `localStorage.debug` works but, like `require('debug').enable`, reaches only the copies that read it at load. Prefer the helper.
- **Why not `require('debug').enable(…)`:** it enables only your resolved copy, and ours may be different ones. This repo's own install has one per package.
- **libp2p:** its `libp2p:*` namespaces are a separate registry. Use `import { enable } from '@libp2p/logger'; enable('libp2p:*')`, with the caveat that more than one copy may exist. Seeing no `libp2p:` lines after enabling ours is expected, not a bug.
- **Cost:** both issue #8 reporters found that debug logging roughly doubled their run times on device. We have not measured it ourselves, so say it as reported. Don't benchmark with it on and don't ship it on.
- Cite the helper as `packages/db-core/src/logger-registry.ts` with the anchor `enableOptimysticLogging` so `yarn lint:docs` fails if it is renamed.
- In § "Common DEBUG patterns", add one line noting that every filter shown is also a valid `enableOptimysticLogging` argument.
- Fix the "specifiers reach every package's logger" sentence as described above.

## Edge cases & interactions

- **Two distinct `debug` copies**, which this repo's own install provides: one enable call turns on channels in both. The db-p2p spec proves it against real copies, not fakes.
- **Enable, then a copy registers** (lazy-loaded package): the late copy gets our namespaces and sink, and its baseline is captured before we touch it.
- **Construct a logger, then enable:** it is enabled (live accessor). **Enable, then construct:** also enabled. Test both on the real copies.
- **A hoisted copy shared with the consumer's own channels:** their `myapp:*` stays on after our enable, and is still on after our disable.
- **Enable twice with different sets:** the second replaces our first contribution. It does not accumulate. The baseline is unchanged.
- **Disable with nothing enabled / disable twice:** no throw, no change.
- **The same copy registered by several owners:** counted once, all owners listed.
- **Registration with no prior enable:** nothing is touched, so `DEBUG=` on Node still works exactly as today.
- **`options.log` given:** every line, and the confirmation, goes there. After disable, each copy's original sink is back. This must not break `test/support/capture-log.ts`, which swaps `debug.log` on db-p2p's copy. It saves and restores around its own run, so the two compose as long as specs do not interleave.
- **Two db-core copies in one bundle:** the `globalThis` symbol key means both see one registry. Test it by calling the functions through a second import path if feasible; otherwise assert that the state lives at `globalThis[Symbol.for(...)]`.
- **Sink swallowed on device** (e.g. the default `console.debug` filtered out): this is why the confirmation line goes through the same sink. It is not something the code can detect.
- **Formatters:** enabling does not move `%p`/`%e` registration between copies. Lines in db-p2p keep rendering, because the specifiers are on db-p2p's own copy.

## Guards (no React Native in CI)

The fan-out logic is platform-independent. The only React Native–specific fact is that `debug`'s own `load()` finds nothing, which is upstream behaviour. So Node tests cover the logic, and nothing further is attempted for RN.

- `packages/db-core/test/logger-registry.spec.ts`: fake `DebugModule`s cover union semantics, baseline restore, pending applied to a late registrant, dedupe by identity, sink install and restore, the report and confirmation contents, array joining, and the empty set. Reset `globalThis[Symbol.for(...)]` between specs.
- `packages/db-p2p/test/logging-enable.spec.ts`: real copies. Start with a **precondition**: db-core's `debug` (via `createRequire(import.meta.resolve('@optimystic/db-core'))`) `!==` db-p2p's. If it fails, the message should say the install now dedupes (`nmHoistingLimits` changed) and that this spec no longer exercises the multi-copy case. Then, after `enableOptimysticLogging('optimystic:*')`, a db-p2p `createLogger` channel and a channel from db-core's copy both report `enabled`. Include both construction orders. Restore everything in `finally`.
- `packages/db-p2p/test/logger.spec.ts`: add a static scan in the same style as the namespace-table check. Every file under `packages/*/src` that imports `debug` must call `registerDebugModule(`. A future package that forgets to register would otherwise be silently unreachable again.

## TODO

- Write `packages/db-core/src/logger-registry.ts` per the semantics above, and export it from `packages/db-core/src/index.ts`.
- Add `registerDebugModule(...)` to all eight `debug` import sites.
- Correct the formatter NOTE in `packages/db-p2p/src/logger.ts` (copies are not shared under this repo's install).
- Write the three test additions. Run `yarn workspace @optimystic/db-core test` and `yarn workspace @optimystic/db-p2p test`, and `build` for both first if the db-p2p spec imports db-core's `dist`.
- Rewrite the enabling section of `docs/debugging.md` and fix the specifiers sentence. Run `yarn lint` (the `no-console` exemption) and `yarn lint:docs`.
