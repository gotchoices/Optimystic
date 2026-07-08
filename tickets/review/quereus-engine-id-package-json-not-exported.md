description: Fixed a crash where the Quereus plugin failed to import in normal Node apps because it read a file the Quereus package forbids; it now reads the version a supported way and has a plain-Node smoke test guarding it.
files: packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts, packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts
difficulty: medium
----

## What this was

`QUEREUS_ENGINE_ID` was derived at module load by reading `@quereus/quereus/package.json`
through CJS `createRequire`. `@quereus/quereus`'s `exports` map defines no `./package.json`
subpath and no `require` condition, so under plain Node ESM that read throws
`ERR_PACKAGE_PATH_NOT_EXPORTED` at import — taking down every export of the package
(QuereusEngine, createQuereusValidator, register, …). The shipped path (plain-Node import of
the built `dist/`) was never exercised by the test suite, so 197+ green tests hid it.

## What changed

**`src/transaction/quereus-engine.ts`** — replaced the `createRequire(...)('.../package.json')`
block with `resolveQuereusVersion()`: resolve the package entry via `import.meta.resolve`
(honors the `import` export condition quereus defines; sync + stable since Node 20.6), then
walk up ≤6 directories from the resolved file to the package's own `package.json`, guarding on
`pkg.name === '@quereus/quereus'`. Throws a clear error if not found. No hardcoded version, no
pre-20.6 fallback. `createRequire`/`module` import removed.

**`package.json`** —
- Added `"node": ">=20.6.0"` to `engines` (declares the `import.meta.resolve` floor; there was
  no prior `node` floor).
- Added `test:smoke`: `node --input-type=module -e "import('./dist/index.js') …"` that asserts
  `QUEREUS_ENGINE_ID` matches `/^quereus@\d+\.\d+\.\d+$/`, printing `smoke ok …` or `THROW …`.
  This runs the **built** module under **plain node with no ts-node loader** — the only way to
  exercise the shipped path.
- Chained it into `test` (`… mocha … && npm run test:smoke`) so it runs after the mocha pass.

**`test/quereus-engine.spec.ts`** — the "should match the installed @quereus/quereus version"
test *itself* read `@quereus/quereus/package.json` via `createRequire` — the exact forbidden
pattern. **The ticket's premise that the ts-node/esm loader masks this was wrong:**
`createRequire` enforces `exports` encapsulation *even under ts-node*, so this test threw
`ERR_PACKAGE_PATH_NOT_EXPORTED` too (confirmed: it was the sole failure after the source fix).
Replaced it with an `installedQuereusVersion()` helper using the same encapsulation-safe
`import.meta.resolve` + upward-walk. `createRequire`/`module` import removed from the test.

## Validation performed (all from `packages/quereus-plugin-optimystic/`)

- `yarn build` → success; emitted `dist/index.js` verified to contain `import.meta.resolve("@quereus/quereus")`
  and **no** `createRequire` (esbuild target node16 does not down-level `import.meta.resolve`).
- `npm run test:smoke` → `smoke ok quereus@4.3.0` (the shipped plain-Node path — the real regression guard).
- `yarn typecheck` → clean (exit 0).
- `yarn test` → **308 passing, 0 failing, 11 pending**, then `smoke ok quereus@4.3.0`, exit 0.
  (Before the fix the same run was 307 passing / 1 failing on the test-file `createRequire`.)

Installed: Node v24, `@quereus/quereus` 4.3.0.

## Use cases the reviewer should confirm

- **Primary contract:** a plain-Node ESM app can `import('@optimystic/quereus-plugin-optimystic')`
  without throwing, and `QUEREUS_ENGINE_ID === 'quereus@4.3.0'`. `npm run build && npm run test:smoke`
  is the fast reproduction; also try a raw `node -e "import('./dist/index.js').then(m=>console.log(m.QUEREUS_ENGINE_ID))"`.
- **Version tracks the installed package**, not a constant — bump `@quereus/quereus` and the ID follows.
- **Loud failure, not silent wrong value**, if quereus can't be resolved (delete/rename the dep → expect the thrown error, not a bogus id).

## Known gaps / things to poke (tests are a floor, not a ceiling)

- **`test` and the mocha specs require a prebuilt `dist/`** — the package `test` script does not
  build, and both mocha (`import '../dist/index.js'`) and smoke import from `dist/`. This is the
  pre-existing monorepo convention (`yarn build` before `yarn test`; root `test` is
  `workspaces foreach -At run test`, which does **not** build first). No new hazard vs. the prior
  mocha behavior, but a reviewer running the package `test` against stale/missing `dist/` will see
  smoke (and mocha) fail for that reason, not a real regression. **Decision for the reviewer:**
  leave as convention, or make `test` self-building (`npm run build && …`) — I left it as convention
  to avoid changing timing for the pre-existing mocha and to match the rest of the monorepo.
- **The "matches installed version" mocha test now mirrors the module's own resolution logic**, so
  it is not a fully independent oracle — it confirms the derivation runs and yields a matching
  semver, not that the walk algorithm is correct against an external source. The plain-Node smoke
  is the true guard; treat the mocha test as a smoke-level sanity check.
- **Version regex `/^quereus@\d+\.\d+\.\d+$/` rejects pre-releases** (e.g. `4.4.0-alpha.1`) in *both*
  the smoke script and the existing format test (there is already a `NOTE:` at
  `test/quereus-engine.spec.ts` on the format test). Tripwire: if quereus ships a prerelease, both
  need loosening. Parked as this note + the existing code NOTE, not a ticket — it is conditional.
- **Upward walk is bounded at 6 levels.** Fine for normal + yarn-hoisted layouts (verified). If a
  future package layout (deep pnpm nesting, unusual hoisting) placed the resolved entry >6 dirs
  below its `package.json`, resolution throws loudly — it never silently mis-resolves. Tripwire,
  parked here; the bound is documented at the loop site in `quereus-engine.ts`.

## Review findings

- Ticket premise correction: ts-node/esm does **not** mask the `createRequire('.../package.json')`
  read; the test file hit the same throw and was fixed alongside the source. Called out above so
  the reviewer doesn't trust the original "tests are a false positive only under plain node" framing.
- Tripwires recorded (not filed as tickets): prerelease-version regex (in-code `NOTE:` at the
  format test + smoke script), and the 6-level walk bound (documented at the loop site).
- Open decision (non-blocking): whether the package `test` should build `dist/` itself vs. relying
  on the monorepo's build-before-test convention.
