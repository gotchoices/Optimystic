description: Derive QUEREUS_ENGINE_ID from the installed @quereus/quereus version at runtime instead of a hardcoded string.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
difficulty: easy
----

## What was implemented

Replaced the hardcoded `'quereus@0.15.1'` engine ID with a runtime read of `@quereus/quereus`'s version, and updated the spec to assert against the installed version rather than a literal.

## Review findings

**Checked:** the implement diff (with fresh eyes before the handoff), the resulting source (`quereus-engine.ts`), the spec (`quereus-engine.spec.ts`), the build (`yarn build`), the full test suite (`yarn test` → 197 passing), all remaining references to `QUEREUS_ENGINE_ID` and the old version string, the plugin's `exports`/peerDep setup, and — critically — the actual runtime behavior of the *built* module under plain Node.

### MAJOR — module crashes on import under plain Node (filed as fix ticket)

`quereus-engine-id-package-json-not-exported` (in `fix/`).

The new code does `createRequire(import.meta.url)('@quereus/quereus/package.json')`. `@quereus/quereus` defines an `exports` map exposing only `.`, `./parser`, `./emit` — **not** `./package.json` — so Node's exports encapsulation makes that subpath unresolvable. Confirmed: after `yarn build`, `import('./dist/index.js')` under plain `node` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, which fails the *entire* module and every export with it. This is a hard regression: the old hardcoded string loaded fine. (Additionally, `createRequire` is CJS and quereus's `.` entry has no `require`/`default` condition, so even `_require.resolve('@quereus/quereus')` throws — CJS resolution cannot see this package at all.)

**Why 197 tests didn't catch it:** the suite runs under `node --import ./register.mjs`, which registers the `ts-node/esm` loader; that loader resolves the subpath leniently and masks the exports restriction. The shipping path (plain-Node import of `dist/`) is never exercised. The green run was a false positive.

Filed as a fix ticket (not fixed inline) because the correct remedy requires a resolution-strategy change (`import.meta.resolve` + fs walk to `package.json`, verified to return `4.3.0` under plain Node) **and** a new plain-Node smoke check — an in-mocha regression test inherits the same masking loader and would not protect against recurrence. Details, verified fix snippet, and required coverage are in the fix ticket.

### Tripwire (carried forward from implement, verified) — pre-release version format

The format-regex test `/^quereus@\d+\.\d+\.\d+$/` rejects pre-release versions (e.g. `4.4.0-alpha.1`). Parked as a `// NOTE:` at the test site (`quereus-engine.spec.ts:47`). Confirmed present and correctly scoped — genuinely conditional (only trips if quereus publishes a pre-release), so it stays a tripwire, not a ticket.

### Docs — no action

`docs/transactions.md`, `docs/partition-healing.md` show illustrative `quereus@0.5.3` examples prefixed with "e.g."; these are pre-existing and were not touched by this change and are not authoritative version claims. `docs/review.html` contains a prior review artifact referencing the original bug. None misrepresent the new reality; no update needed.

### Empty categories

- **No minor findings fixed inline** — the one substantive defect was major (breaks module load) and went to a ticket; nothing else warranted an inline touch.
- **No new backlog/blocked tickets** — the single defect is a live, reachable bug, so it went to `fix/`, not `backlog/`; no human decision or external dependency is involved.

## Test results

`yarn build` clean. `yarn test` → 197 passing, 11 pending, 0 failing (~2m). Note the false-confidence caveat above: green under the ts-node loader does not exercise the plain-Node import path.
