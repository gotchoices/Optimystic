description: React Native had no way to turn on Optimystic's debug logging, and nothing said so, so an empty log looked exactly like "that code never ran". There is now one call that turns our logging on across every package, prints a line confirming what it turned on, and is documented as the way to enable logging on any runtime without environment variables.
files:
  - packages/db-core/src/logger-registry.ts (the registry, `registerDebugModule`, `enableOptimysticLogging`, `disableOptimysticLogging`)
  - packages/db-core/src/index.ts (exports it)
  - packages/db-core/src/logger.ts, packages/db-p2p/src/logger.ts, packages/db-p2p-storage-{rn,web,ns,fs}/src/logger.ts, packages/quereus-plugin-optimystic/src/logger.ts, packages/reference-peer/src/cli.ts (one `registerDebugModule(...)` line each)
  - packages/db-core/test/logger-registry.spec.ts, packages/db-p2p/test/logging-enable.spec.ts, packages/db-p2p/test/logger.spec.ts (guard), packages/db-core/test/barrel-import-cycle.spec.ts
  - docs/debugging.md, docs/internals.md, docs/optimystic.md, packages/db-p2p-storage-rn/README.md, packages/reference-peer/test/README.md
----

# One call that turns on every Optimystic log channel, on any runtime

This came from GitHub issue #8, via the plan ticket `logging-cannot-be-turned-on-in-react-native`.

## What landed

The `debug` library turns channels on only from `process.env.DEBUG` (Node) or `localStorage.debug` (its browser build, which Metro bundles). React Native has neither, so every `optimystic:*` channel was silently off there. And because each Optimystic package may load its own copy of `debug` (this repo's install gives every package one), a single `require('debug').enable(...)` can't reach them all.

- **A registry.** `packages/db-core/src/logger-registry.ts` keeps its state on `globalThis[Symbol.for('@optimystic/logger-registry')]`, so two copies of db-core in one bundle still share one registry. The module has no imports.
- **Registration.** Every package's `debug` import site calls `registerDebugModule('<owner>', debug)` at load. There are eight: the seven `src/logger.ts` files and the reference-peer CLI. A copy that several packages register is stored once, with each registering package listed as an owner.
- **`enableOptimysticLogging(namespaces, { log? })`** does the following:
  - It adds our namespaces to each copy's existing set (its baseline), rather than replacing it.
  - It installs the optional `log` sink as each copy's output.
  - It remembers the settings, so a copy that registers later gets them.
  - It writes one confirmation line every time it is called.
  - It never persists anything. `debug`'s `save` hook is stubbed out around each call, so neither `process.env.DEBUG` nor `localStorage.debug` is written.
- **`disableOptimysticLogging()`** restores each copy's baseline namespaces and original sink.
- **Docs.** `docs/debugging.md` has a new "Turning logging on" section, and the other docs point to it.

## Review findings

**Checked against `debug` 4.4.3's own source** (`src/common.js`, `node.js`, `browser.js` under `packages/db-core/node_modules/debug`):
- `enable` calls `createDebug.save(...)` at call time, so stubbing `module.save` works.
- `disable()` returns names plus `-skips` and then runs `enable('')`, so capturing the baseline this way is sound.
- A channel's `enabled` getter compares its cached namespaces with the copy's current ones on every read, so channels created before the call do turn on.
- Channels write through `self.log || createDebug.log`, looked up at call time. Replacing the copy's `log` therefore redirects every channel, including `.extend()` children, because they copy the instance's `log`, which is undefined.
- `enabled()` checks skips first, so the NOTE about a `-optimystic:*` skip winning is accurate.
- The browser build's `log` is `console.debug`, and its `load()` reads `localStorage` and then `process.env.DEBUG`. The docs describe both correctly.
- No package source sets `.log` on an individual channel. That would have bypassed the `log` option. (grep for `\.log\s*=` over `packages/*/src`: only `this.log = createLogger(...)` fields.)

**Correctness and error handling: no defects found.**
- `withoutPersisting` puts `save` back in a `finally`.
- `disableOptimysticLogging` is idempotent.
- A late registrant gets its baseline captured before anything is applied.
- Calling the confirmation sink as a plain function, without its object, is safe on both builds. `debug` itself calls it through `.apply(self, …)`, never with the console as `this`.

**Dependencies.** Every package that now imports `registerDebugModule` already lists `@optimystic/db-core` as a runtime dependency (checked each `package.json`). No package declares `sideEffects: false`, so no bundler will drop a registration line. The registry module has zero runtime imports, and the barrel-cycle spec now enforces that.

**Tests.** I read both new spec files and the guard in full. Coverage is good:
- additive baseline, and last-call-wins
- restore
- late registrants
- deduplication by module identity
- sink install and restore
- the `console.log` fallback
- the second-db-core-copy case, via a `?query` import
- two real copies, with a precondition that fails loudly if the install ever dedupes `debug`

The guard walks `packages/*/src` and checks its own walk against the eight known sites. One thing is left untested, and the handoff already says so: no test lazily loads a real Optimystic package after the call (only fakes do). I accepted that; the code path is the same one the fakes exercise.

**Docs — two fixed inline, both minor:**
- In `docs/debugging.md`, the "Browsers" paragraph said `localStorage.debug` "like `require('debug').enable(...)` reaches only the copies that read it when they loaded". That wrongly suggests it misses copies: every browser copy reads it as it loads. It now says what the real downsides are: it needs a reload, and it persists into later sessions.
- In `packages/reference-peer/test/README.md`, a file the change should have touched, `DEBUG=` examples used the pre-`optimystic:` namespaces `db-p2p:*` / `db-p2p:repo-service` / `db-p2p:cluster-service`. Those match nothing. Corrected to `optimystic:*` and `optimystic:db-p2p:repo-service,optimystic:db-p2p:cluster-service`.
- I also confirmed that every filter under "Common DEBUG patterns" is an `optimystic:` filter, so the new line saying "every filter below is also a valid `enableOptimysticLogging` argument" is true.

**Tripwires, parked as `NOTE:`s and not filed as tickets:**
- The "baseline captured once per cycle" behaviour the implementer flagged is fine while apps set their own channels once at start-up. It is recorded as a NOTE on `apply` in `logger-registry.ts`, with the fix to use if an app ever toggles its channels at run time.
- The implementer's existing NOTEs were reviewed and kept as they are: the `globalThis` state shape may only change additively, and a skip already in a copy's baseline still wins.

**Source hygiene.** `logger-registry.ts` is about 225 lines of small, named functions. Its comments are long but each explains a non-obvious *why*: the persistence stub, and the `globalThis` key. Nothing to change. The registration line and its one-line comment repeat across eight sites; that is intentional, since the guard test looks for the call at each site.

**Considered and declined:** none. There were no accepted-tradeoff NOTEs at these sites.

**Major findings / new tickets:** none.

**Validation (this pass):**
- `yarn workspace @optimystic/db-core test`: 1640 passing.
- `yarn workspace @optimystic/db-p2p test`: 2705 passing, 50 pending.
- `yarn lint` and `yarn lint:docs`: clean after the edits.

The quereus-plugin and storage-package suites were not re-run. This pass changed no code they execute, only a comment and docs.

## Known gaps, carried from implement

- No React Native run; CI has no RN. The RN-specific facts are upstream `debug` behaviour.
- The confirmation line goes through `console.debug` on RN. A device log filtered above debug level drops it, along with everything else. The docs point to the `log` option for that case.
- Out of scope: the reference-peer CLI has no flag that calls the helper, and libp2p's own switch is documented but not wrapped.
