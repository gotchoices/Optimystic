description: The Quereus plugin's "is this a half-saved commit?" check used to work only because of a build setting nobody was watching; that setting is now pinned down with a test, and the check itself no longer needs to assume it.
architecture: docs/transactions.md
files:
  - packages/quereus-plugin-optimystic/src/plugin.ts (new re-exports: `PartialCommitError`, `CoordinatorPartialCommitError`, `SyncRetryExhaustedError`, `TornActionError`)
  - packages/quereus-plugin-optimystic/tsup.config.ts (comment next to `splitting: true`)
  - packages/quereus-plugin-optimystic/test/browser-bundle.spec.ts (new `describe('plugin error class identity', ...)`, two specs)
  - packages/quereus-plugin-optimystic/README.md (§ Error Handling: `./plugin`-entry import example added)
----

# What changed

The plugin builds two entry points (`index.js`, the root; `plugin.js`, the one most hosts load the plugin through — `tsup.config.ts`, `splitting: true`). `PartialCommitError` (`src/optimystic-adapter/txn-bridge.ts:188`, thrown at line 1094 by the legacy multi-tree commit's fallback sweep) was defined once and re-exported only from the root entry. A host that loads via `./plugin` but imports the error class from the root entry was relying on both entries resolving to the SAME class object — true today only because `splitting: true` puts shared code in one chunk both entries pull from. A different `splitting` value, or any other change that stops the two entries sharing that chunk, would silently break `instanceof` for every host doing this, with nothing here or downstream failing loudly.

Reported 2026-09-17 by sereus's review of its own change (`76cb6880`): sereus loads the plugin via `./plugin` and classifies retries with `err instanceof PartialCommitError` imported from the root entry.

**Fix, two parts:**

1. `src/plugin.ts` now re-exports `PartialCommitError` itself, plus three db-core errors the retry guidance in `docs/transactions.md` tells callers to classify on: `CoordinatorPartialCommitError` (commit-phase split under the coordinator), `SyncRetryExhaustedError` and `TornActionError` (both from `db-core/src/collection/struct.ts`). A host that loads via `./plugin` can now import error classes from the same place, with **no cross-entry assumption at all** — even if the entries ever stop sharing a chunk.

2. A new regression pair in `test/browser-bundle.spec.ts` (`describe('plugin error class identity', ...)`) asserts, against the **built** `dist/index.js` and `dist/plugin.js`:
   - `PartialCommitError` imported from each entry is the exact same constructor (`===`).
   - An error constructed via the `./plugin` entry's own export is `instanceof` the root entry's export.

   I verified the test has teeth by temporarily building with `splitting: false`: both new assertions failed (`AssertionError: expected [Function PartialCommitError] to equal [Function PartialCommitError]`, and the `instanceof` check), confirming each entry got its own copy of the class as the ticket predicted. Restored `splitting: true` and rebuilt; both pass again.

**Decision on the db-core re-exports** (the ticket asked me to weigh this): re-exporting `@optimystic/db-core`'s classes from `./plugin` does **not** reintroduce the two-copies problem. `db-core` is listed in `tsup.config.ts`'s `external: [...]`, so tsup never bundles it — I confirmed in the built output (`dist/chunk-*.js`) that both the plugin's internal code and the new re-export just `import { CoordinatorPartialCommitError, SyncRetryExhaustedError, TornActionError } from '@optimystic/db-core'`, unbundled. `db-core` itself builds with plain `tsc` (no bundler, no splitting) and publishes one `.` entry point (`packages/db-core/package.json`), so Node's module resolution hands every importer — this package's `index.js`, its `plugin.js`, and any other workspace package — the same loaded module instance. The residual "dual package hazard" (two different *installs* of `@optimystic/db-core` in the dependency tree) is a generic node_modules/workspace concern, not something this package's own build can cause, so I did not add a test for it.

3. `tsup.config.ts` now has a comment next to `splitting: true` stating the invariant and pointing at the spec that enforces it.

4. README § Error Handling gained an example importing `PartialCommitError` from `./plugin`, and a line naming the three db-core classes now re-exported there.

# Validation run

- `npm run build` (in `packages/quereus-plugin-optimystic`): ok. Confirmed in `dist/plugin.d.ts` and `dist/plugin.js` that all four classes are exported.
- `npm run typecheck`: clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/browser-bundle.spec.ts" --reporter spec --exit`: 3 passing (the existing browser-bundle guard plus the two new identity specs).
- **Teeth check**: rebuilt with `splitting: false` — both new specs failed with the expected assertion errors; rebuilt with `splitting: true` restored — both pass. `git diff -- tsup.config.ts` afterward showed only the intended comment (confirmed the temporary edit left no residue).
- Full suite: `npm test` (mocha + `test:smoke`) — **995 passing, 13 pending** (pending count matches the pre-fix baseline recorded in `tickets/complete/the-plugin-entry-loads-node-file-system-modules.md`; the 2 new specs bring 993→995), `smoke ok quereus@4.19.4`.
- Not run: `yarn check:rn` (Metro/Hermes), `yarn test:integration`, the full monorepo `yarn check`/`yarn lint`/`yarn lint:deps`/`yarn lint:docs`. The change is scoped to this package's exports, its build config comment, and its README; I did not touch anything React-Native-specific or any other workspace.

# Decisions and known gaps (for the reviewer)

- **Why construct the "thrown through the plugin entry" error by hand instead of driving a real multi-tree commit failure** (as `legacy-commit-atomicity.spec.ts` / `two-node-unique-value-race.spec.ts` do with injected transactor failures and real trees): after this fix, `plugin.js`'s `PartialCommitError` export is a direct re-export of the exact same class reference `TransactionBridge` throws at `txn-bridge.ts:1094` — not a wrapper or reimplementation. Constructing it via `new (plugin.js's export)(...)` is the same class identity check as catching a real thrown one, without duplicating the heavier multi-node/file-storage scaffolding those other specs already use to cover the *behavior*. This new spec is scoped to the *build/identity* hazard, which is what the ticket was about. If a reviewer wants belt-and-suspenders coverage that drives an actual throw, `two-node-unique-value-race.spec.ts` already does (it imports `PartialCommitError` from `../dist/index.js` and catches a real one — it just doesn't cross-check against `../dist/plugin.js`, since until now `plugin.js` didn't export the class at all).
- **`docs/transactions.md` was not edited.** It already documents the "Legacy (single-node) commit" section this error belongs to and the retry-classification guidance for the db-core errors; nothing there was inaccurate, so I only cited it (in code comments and here) rather than changing it. If the reviewer thinks the doc should now mention that `./plugin` also exports these classes, that's a small addition, not a correction.
- **No new `/errors` subpath was added** — same call the prior related ticket made (see `tickets/complete/the-plugin-entry-loads-node-file-system-modules.md`, "Decisions and known gaps"): error classes live on the two existing entries, not a third one.

# Downstream note, for the reply to sereus (`sereus-83` / `sereus-ef`)

Once this lands, sereus can import `PartialCommitError` (and, if useful, `CoordinatorPartialCommitError` / `SyncRetryExhaustedError` / `TornActionError`) from `@optimystic/quereus-plugin-optimystic/plugin` — the same entry they already load the plugin through — instead of the root entry. Both entries now export the identical class either way, and it's now backed by a build-output test rather than a `splitting` setting nobody was watching, so keeping the root import is also fine if they prefer not to churn it.

# Reviewer checklist

- Confirm `dist/chunk-*.js` (or whatever tsup names the shared chunk on your build) still shows `CoordinatorPartialCommitError`, `SyncRetryExhaustedError`, `TornActionError` imported (not inlined) from `@optimystic/db-core` — that's the basis for the "safe to re-export" call above.
- Read `src/plugin.ts`'s new header comment — does the "dual package hazard" caveat undersell or oversell the residual risk?
- Optional: try the teeth check yourself (`splitting: false`, rebuild, run `test/browser-bundle.spec.ts`, rebuild with `splitting: true`) to independently confirm the guard fires.
