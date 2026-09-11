description: React Native had no way to turn on Optimystic's debug logging, and nothing said so, so an empty log looked exactly like "that code never ran". There is now one call that turns our logging on across every package, prints a line confirming what it turned on, and is documented as the way to enable logging on any runtime without environment variables.
files:
  - packages/db-core/src/logger-registry.ts (new — the registry, `registerDebugModule`, `enableOptimysticLogging`, `disableOptimysticLogging`)
  - packages/db-core/src/index.ts (exports it)
  - packages/db-core/src/logger.ts, packages/db-p2p/src/logger.ts, packages/db-p2p-storage-{rn,web,ns,fs}/src/logger.ts, packages/quereus-plugin-optimystic/src/logger.ts, packages/reference-peer/src/cli.ts (one `registerDebugModule(...)` line each)
  - packages/db-p2p/src/logger.ts (formatter NOTE corrected: copies are not shared under this repo's install)
  - packages/db-core/test/logger-registry.spec.ts (new — 23 specs, fake debug modules)
  - packages/db-p2p/test/logging-enable.spec.ts (new — 8 specs, the two real debug copies)
  - packages/db-p2p/test/logger.spec.ts (new repo-wide guard: every `debug` import site registers)
  - packages/db-core/test/barrel-import-cycle.spec.ts (logger-registry.ts added to the zero-runtime-imports list)
  - docs/debugging.md (new "Turning logging on" section; specifiers sentence corrected; one line in "Common DEBUG patterns")
  - docs/internals.md, docs/optimystic.md, packages/db-p2p-storage-rn/README.md (short pointers to the new call — not in the plan's file list)
----

# One call that turns on every Optimystic log channel, on any runtime

Came from GitHub issue #8 (reporter `risavian`), via the plan ticket `logging-cannot-be-turned-on-in-react-native`. The sibling ticket `document-log-fields-that-say-which-case-you-are-in` is independent.

## What was built

The `debug` library turns channels on only from `process.env.DEBUG` (Node) or `localStorage.debug` (its browser build, which Metro bundles). React Native has neither, so every `optimystic:*` channel was silently off there. Calling `require('debug').enable(...)` from an app doesn't reliably help, because each Optimystic package may load its own copy of `debug`. Under this repo's install (`nmHoistingLimits: workspaces`) every package does.

- **The registry** (`packages/db-core/src/logger-registry.ts`) keeps its state on `globalThis[Symbol.for('@optimystic/logger-registry')]`, so two copies of db-core in one bundle share it. The module has no imports at all.
- **Registration.** Each of the eight `debug` import sites calls `registerDebugModule('<owner>', debug)` at module load, passing the copy that file imported. The owners are `db-core`, `db-p2p`, `db-p2p-storage-rn|web|ns|fs`, `quereus-plugin` and `ref-peer`. A copy registered by several owners is stored once, with every owner listed.
- **`enableOptimysticLogging(namespaces, { log? })`** does five things:
  - On first touch, it captures each copy's existing namespaces (its "baseline").
  - It sets each copy to `baseline,ours`, which adds to what was on rather than replacing it.
  - It installs `log` as each copy's output (its sink), if one was given.
  - It remembers the settings, so copies that register later get them silently.
  - It returns a report, `{ namespaces, copies: string[][] }`.
  
  It always writes one confirmation line. That line goes through `options.log`, or else the first registered copy's sink, or else `console.log` if nothing has registered yet. A second call replaces the first call's namespaces and `log` rather than adding to them.
- **`disableOptimysticLogging()`** restores each copy's baseline and original sink, then clears the remembered settings. It is safe to call repeatedly.

## Deliberate choices the reviewer should check

- **We never let `debug` persist our namespaces. This is not in the plan.** `debug.enable` calls the copy's `save` hook. On Node that writes `process.env.DEBUG`, which has two effects:
  - A copy that loads later reads that variable as its own starting set. It would arrive with our namespaces already in what we later treat as its baseline, so disable could never turn them off on that copy.
  - Capturing a baseline through `disable()` would also delete the user's `DEBUG`.
  
  In browsers, `save` writes `localStorage.debug`, which would keep logging on after a reload. So `withoutPersisting` stubs `module.save` out around every `enable` and `disable` call the registry makes, then puts it back. `save` is an exported property of debug 4.x (`src/node.js` and `src/browser.js`), but `@types/debug` doesn't declare it, so it is optional on the `DebugModule` interface. Pinned by: the db-core spec "never persists", and the db-p2p spec "does not write process.env.DEBUG".
- **A string argument is split on commas too**, not just an array. That means `'a, b'` and `['a','b']` give the same result, `a,b`. Every entry is trimmed, and empty ones are dropped.
- **An empty namespace list** leaves every copy on its baseline. It still installs the `log` sink if one was given, and it still writes a confirmation line, which reads `nothing (empty namespace list)`.
- **A later call without `log`** puts each copy back on its original sink, following the "last call wins" rule for `{namespaces, log}`.

## Validation run

All of these were run, and all passed:

- `yarn workspace @optimystic/db-core test`: 1640 passing.
- `yarn workspace @optimystic/db-p2p test`: 2705 passing, 50 pending.
- `yarn workspace @optimystic/quereus-plugin-optimystic test`: 800 passing, 13 pending, plus its smoke check. This needed db-p2p, db-p2p-storage-fs and the plugin rebuilt first, because the build-freshness check refuses a stale `dist`.
- `yarn lint` and `yarn lint:docs`: clean.
- `tsc --noEmit` in db-p2p, all four storage packages, the quereus plugin and reference-peer: clean.
- The new specs were also re-run with the verbose reporter, to confirm they actually execute.

## Use cases to exercise

- **Two real copies** (`packages/db-p2p/test/logging-enable.spec.ts`). The spec starts with a precondition: db-core's `debug` must not be the same object as db-p2p's. If that fails, its message says the install now dedupes `debug`. After one call, channels on both copies report `enabled`, whether the logger was built before or after the call.
- **Output and restore.** With `log` passed, lines from both copies land in it, with the confirmation line first. After disable, `debug.log` is the original function object again.
- **An app's own channels survive.** A consumer's `myapp:*` on a shared copy stays on after enable and after disable.
- **`%b` and similar still render in db-p2p after enabling.** db-core's copy still has no `%b`, which pins the corrected NOTE.
- **Registry semantics, with fake modules** (`packages/db-core/test/logger-registry.spec.ts`): adding to the baseline, a second call replacing the first, restore on disable, a late registrant getting the settings silently, deduplication by module identity, sink install and restore, array joining and the empty list, and the exact confirmation-line text including `copy` vs `copies`.
  - The `console.log` fallback is covered too.
  - So is the two-db-core-copies case: the module is imported a second time under a `?query` URL, which makes Node evaluate it again, and the second instance drives the first one's entries.
- **Guard for future packages.** The new test in `packages/db-p2p/test/logger.spec.ts` walks `packages/*/src`. It fails if any file imports `debug` without calling `registerDebugModule(`. It first checks that the eight known sites were found at all, so a broken walk can't pass silently.

## Known gaps and honest caveats

- **No React Native run.** CI has no RN. The RN-specific facts are upstream `debug` behaviour, which planning established by reading `debug` 4.4.3's `load()` and `useColors()`: no filter is found at start-up, and colours are off. The fan-out logic is tested on Node only.
- **Late registrants are tested only with fakes.** No test lazily loads a real Optimystic package after the call. The logic is shared with the real path, but a real test would need a package db-p2p's tests don't depend on.
- **The confirmation line can still be invisible on device.** It goes through each copy's default sink, which is `console.debug` in the RN build. A device log filtered above debug level drops it along with every log line. The code can't detect that. The docs say that a missing confirmation line means "not called, or sink swallowed" and point to the `log` option.
- **Tripwires, recorded as code `NOTE:`s, not tickets:**
  - The `globalThis` state is shared between db-core versions in one bundle, so its shape must only ever change additively. There is a NOTE above `REGISTRY_KEY`.
  - A `-optimystic:*` skip already in a copy's baseline still wins, because `debug` checks skips first. There is a NOTE on `apply`.
- **Baseline captured once per cycle.** If an app calls `debug.enable(...)` on a shared copy between two of our enable calls, our second call reapplies the captured baseline and overwrites the app's change. The plan specified this ("the baseline stays as captured"). Flagging it in case a reviewer disagrees.
- **Out of scope.** The reference-peer CLI has no flag that calls the helper. libp2p's own switch (`enable` from `@libp2p/logger`) is documented but not wrapped.
- **Not run.** The storage-rn, storage-web and storage-ns test suites. Their change is one registration line, which does nothing unless enable is called, and their typecheck is clean.
