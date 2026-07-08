description: Fixed a crash where the Quereus plugin failed to import in normal Node apps because it read a file the Quereus package forbids; it now reads the version a supported way, guarded by a plain-Node smoke test.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts, docs/transactions.md
difficulty: medium
----

## What this was

`QUEREUS_ENGINE_ID` was derived at module load by reading `@quereus/quereus/package.json`
through CJS `createRequire`. `@quereus/quereus`'s `exports` map defines no `./package.json`
subpath and no `require` condition, so under plain Node ESM that read threw
`ERR_PACKAGE_PATH_NOT_EXPORTED` at import — taking down every export of the package
(QuereusEngine, createQuereusValidator, register, …). The shipped path (plain-Node import of
the built `dist/`) was never exercised by the test suite, so the mocha run (which loads under a
ts-node loader) stayed green while real consumers crashed.

## What shipped (implement stage)

- **`src/transaction/quereus-engine.ts`** — `resolveQuereusVersion()` replaces the
  `createRequire('.../package.json')` block: resolve the entry via `import.meta.resolve`
  (honors the `import` export condition; sync + stable since Node 20.6), then walk up ≤6
  directories to the package's own `package.json`, guarding on `pkg.name === '@quereus/quereus'`.
  Throws a clear error if unresolved. `createRequire`/`module` import removed.
- **`package.json`** — added `"node": ">=20.6.0"` to `engines`; added `test:smoke` (plain-Node
  `import('./dist/index.js')` asserting `QUEREUS_ENGINE_ID` matches `/^quereus@\d+\.\d+\.\d+$/`),
  chained into `test` after the mocha pass.
- **`test/quereus-engine.spec.ts`** — the "matches installed version" test itself read the blocked
  `./package.json` via `createRequire` and threw the same error even under ts-node; replaced with an
  `installedQuereusVersion()` helper mirroring the source's `import.meta.resolve` + upward-walk.

## Review findings

**Verdict: implementation is correct and the fix is real.** All validation reproduced green from
`packages/quereus-plugin-optimystic/`:
- `yarn build` → success; `dist/index.js` contains `import.meta.resolve("@quereus/quereus")` and
  **no** `createRequire` (confirmed the shipped mechanism actually changed).
- `yarn typecheck` → exit 0.
- `yarn test` → **308 passing, 11 pending**, then `smoke ok quereus@4.3.0`, exit 0. The smoke step
  imports the built module under **plain node with no ts-node loader** — it genuinely exercises the
  path that used to throw, so it is a true regression guard, not a self-masking test.
- `npx eslint` on both changed files → exit 0, clean.

**Checked and clear:**
- **Sibling instances of the forbidden pattern.** Grepped the repo for `createRequire` and
  `'.../package.json'` reads. The only other hit — `test/transaction-id.spec.ts:172` reading
  `../package.json` via `new URL(..., import.meta.url)` — targets the plugin's **own** package.json,
  which is not gated by any `exports` map. Not a bug; nothing else carries the defect.
- **Resolution correctness.** `import.meta.resolve('@quereus/quereus')` lands on the package's
  `dist/src/index.js`; the walk reaches the package root's `package.json` in 2 hops (well under the
  bound of 6). The `pkg.name` guard prevents a stray inner `package.json` from yielding a wrong
  version. Single-argument `import.meta.resolve` is the stable (no-flag) form — the two-arg form is
  the experimental one, and it is not used.
- **Failure mode.** Unresolvable quereus throws loudly at module load rather than emitting a bogus
  ID — the intended behavior, and the `engines` floor now declares the Node requirement.

**Fixed inline (minor):**
- `docs/transactions.md:652` presented source-mirroring code (`// In .../quereus-engine.ts`) with a
  **hardcoded** `QUEREUS_ENGINE_ID = "quereus@0.5.3"` — stale on two counts (wrong version, and no
  longer a constant since the engine ID is now runtime-derived). Updated the illustrative line to
  show `` `quereus@${resolveQuereusVersion()}` `` with a note that it tracks the installed package.
  This staleness predated this ticket (the constant→derivation switch was the prior
  `optimystic-engine-id-version-derivation` ticket, which left the doc example behind), but the doc
  names the exact file this change touches, so it was corrected here.

**Major findings / new tickets:** none.

**Tripwires (recorded, not filed — all genuinely conditional):**
- *Prerelease versions.* The regex `/^quereus@\d+\.\d+\.\d+$/` in both the smoke script and the
  format test rejects e.g. `4.4.0-alpha.1`. Parked as an in-code `NOTE:` at
  `test/quereus-engine.spec.ts:66` (format test) + the smoke script; only trips if quereus ships a
  prerelease.
- *Upward-walk bound of 6.* Fine for normal + yarn-hoisted layouts (verified). A future layout
  (deep pnpm nesting, unusual hoisting) placing the resolved entry >6 dirs below its `package.json`
  would throw loudly — never silently mis-resolve. Documented at the loop site in
  `quereus-engine.ts`.

**Non-blocking decision left as-is:** the package `test` script (and the mocha specs) require a
prebuilt `dist/`; `test` does not self-build. This matches the pre-existing monorepo convention
(`yarn build` before `yarn test`; root `test` does not build first). Not changed, to avoid altering
timing for the pre-existing mocha behavior. A reviewer running `test` against a stale/missing
`dist/` will see smoke and mocha fail for that reason, not a regression.

**Acknowledged non-independence (acceptable):** the "matches installed version" mocha test now
mirrors the module's own resolution logic, so it is a sanity check rather than a fully independent
oracle. The plain-Node smoke is the authoritative guard. The duplication between source and test is
deliberate — importing the private `resolveQuereusVersion` would couple the test to internals. Left
as-is.
