description: The Quereus plugin's main entry used to read a file from disk when it loaded, which broke browser and React Native builds of any app importing from it. The Quereus version it needed is now fixed when the plugin is built, and a new test fails if the main entry stops bundling for a browser. Review the change.
architecture: docs/correctness.md
files:
  - packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts (`QUEREUS_ENGINE_ID` and its comment; the Node imports and `resolveQuereusVersion()` are gone)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-version.ts (new, generated, committed)
  - packages/quereus-plugin-optimystic/scripts/write-quereus-version.mjs (new: build-time version lookup; exports `installedQuereusVersion`)
  - packages/quereus-plugin-optimystic/scripts/smoke.mjs (new: `test:smoke`, replaces the inline one-liner)
  - packages/quereus-plugin-optimystic/test/browser-bundle.spec.ts (new: the regression guard)
  - packages/quereus-plugin-optimystic/test/quereus-engine.spec.ts (installed-version test: actionable failure message)
  - packages/quereus-plugin-optimystic/package.json (`build`, `dev`, `test:smoke`, `esbuild` devDependency)
  - yarn.lock (one line: the plugin workspace's new `esbuild` entry)
  - packages/quereus-plugin-optimystic/README.md (§ Transaction Engine, § Error Handling, § Development)
  - docs/correctness.md (Theorem 4, step 1)
  - docs/transactions.md (§ 3. Quereus Transaction Engine code sample)
  - tickets/implement/rn-bundle-check-covers-the-quereus-plugin.md (appended measurement 4 only)
----

# What changed

`QUEREUS_ENGINE_ID` (`quereus@<version>`) used to be computed when the module loaded. The code called `import.meta.resolve('@quereus/quereus')` and read `package.json` from disk with `node:fs`. That put `node:fs`/`node:url`/`node:path` and `import.meta` in the root entry's graph. Browsers cannot resolve the first three, and Hermes (React Native's JavaScript engine) rejects `import.meta` at compile time.

The version is now fixed when the plugin is built:

- `scripts/write-quereus-version.mjs` resolves the installed `@quereus/quereus` version with the same walk-up logic that used to run at load time. It writes `src/transaction/quereus-version.ts` (`export const QUEREUS_VERSION = '4.19.4';` under a "generated, do not edit" header). It rewrites the file only when the contents differ, ignoring CRLF vs LF, so an unchanged build leaves the file's timestamp alone. It prints one line naming the version and whether the file changed.
- `build` (and `dev`) run the script before `tsup`, so `yarn build`, `yarn check` and `yarn pub` all regenerate it.
- The generated file is committed. Typecheck, the specs that import `src`, and the new esbuild spec (which bundles `src`) work without a build. A Quereus bump shows up as a one-line diff.
- `quereus-engine.ts` imports `QUEREUS_VERSION`. Its comment says the id names the Quereus the plugin was built against, and why. A `NOTE:` says to read the version from `@quereus/quereus` if that package ever exports one.

**What this changes in meaning** (now documented in README § Transaction Engine and in `docs/correctness.md` Theorem 4 step 1): the id names the Quereus the plugin build was compiled against, not the one installed at runtime. Two nodes running the same plugin build agree on the id even with different Quereus installs inside the peer range. If those installs execute a statement differently, the operations-hash check (Theorem 4 step 5) is what refuses it. Two plugin builds compiled against different Quereus versions now refuse each other with `Unknown engine`, even if both nodes now run the same Quereus.

# Guards left behind

- **`test/browser-bundle.spec.ts`** (runs in `yarn test`). It uses esbuild's JavaScript API to bundle `src/index.ts` and `src/plugin.ts` with `platform: 'browser'` and fails on any unresolved import, listing `file: message` for each. It also sets `supported: { 'import-meta': false }` and `logOverride: { 'empty-import-meta': 'error' }`, so any `import.meta` fails the test too. I checked with a scratch fixture that the override also reports `import.meta` inside `node_modules` code. Without it, esbuild demotes that warning to debug level for `node_modules` files. Before the fix, the whole graph had exactly one `import.meta`: the one in `quereus-engine.ts`. I checked by bundling without the flag and searching the output. So the assertion covers the whole graph, not only this package. **Checked that it fails first**: against the old `quereus-engine.ts` it failed with exactly four problems (`node:fs`, `node:url`, `node:path`, `import.meta`), all in that file. It takes about 0.5 s.
- **`test/quereus-engine.spec.ts` › should match the installed @quereus/quereus version** stays as it was. Its failure message now names the fix (`yarn workspace @optimystic/quereus-plugin-optimystic build`). Checked by editing the version in `dist/index.js` to `4.19.3`: the message appears.
- **`test:smoke`** is now `node scripts/smoke.mjs`. It imports `dist/index.js` under plain Node (no TypeScript loader), as before, and now also compares the id with the installed Quereus version, not just its format. It reuses `installedQuereusVersion` from the build script. Checked with the same edited `dist`: it exits 1 with a message naming the rebuild command.
- `esbuild` is declared as a plugin devDependency (`^0.27.0`, the range tsup already pulls in; 0.27.2 is installed). `yarn install` added one line to `yarn.lock`.

# Validation run

- `yarn workspace @optimystic/quereus-plugin-optimystic build`: ok.
- `yarn workspace @optimystic/quereus-plugin-optimystic test`: 993 passing, 13 pending, `smoke ok quereus@4.19.4`.
- `yarn typecheck` (all workspaces), `yarn lint`, `yarn lint:deps`, `yarn lint:docs`: all clean.
- The ticket's own repro: esbuild with `platform: 'browser'` on `export { PartialCommitError, QUEREUS_ENGINE_ID } from '@optimystic/quereus-plugin-optimystic'` (which resolves the built `dist`) now bundles with no errors (about 3.7 MB).
- **React Native, one-off, no stubs.** A scratch entry imported the real `dist/index.js` and `dist/plugin.js`. It ran through `packages/rn-bundle-check`'s Metro config, with `C:/projects/quereus` added to `watchFolders` (the harness change the next ticket makes), and then through that check's `compile` (legacy `hermesc`). **Both steps passed**, and the bundle contains the plugin (`QUEREUS_VERSION = "4.19.4"`). No harness files were changed. The measurement is appended to `rn-bundle-check-covers-the-quereus-plugin`, which makes this permanent in `yarn check:rn`.
- Not run: the full `yarn check` and `yarn test:integration`. The change touches only this package's version constant, and the whole plugin suite was run.

# Decisions and known gaps (for the reviewer)

- **`engines.node >=20.6.0` was left alone.** It was added only for the runtime `import.meta.resolve`, and the runtime no longer needs it. Two things still rely on Node 20.6, both development-only: the build script (synchronous `import.meta.resolve`) and `register.mjs` (`module.register`). The ticket said to leave it unless nothing relies on it. A reviewer could reasonably argue that `engines` describes consumer runtime needs and should be dropped. I did not, because of the ticket's instruction.
- **A Quereus bump without a rebuild** is caught by the engine spec and by the smoke check, with a message naming the fix. It is *not* caught by `register.mjs`'s build-freshness check: `src` did not change, so `dist` does not look stale. That is expected. The version test is the guard for it.
- **`tsup --watch` (`dev`)** regenerates the version once at start, not on a later Quereus reinstall. Fine for a dev loop.
- **The browser spec proves the graph bundles. It does not run it**, and it applies neither Metro's resolver nor Hermes. The spec header says so and points at `yarn check:rn`, which does not yet cover the plugin (the `rn-bundle-check-covers-the-quereus-plugin` ticket).
- `docs/review.html` still has an old finding about a hardcoded engine id. It is a dated review record, so I did not edit it.
- **No separate `/errors` subpath**, as the ticket decided. `PartialCommitError` now imports from the root entry on every platform. README § Error Handling says so and shows the import.

# Downstream note, for the reply to sereus (`sereus-83`)

Once this ships in a release, sereus can drop the `no-restricted-imports` rule in `eslint.config.mjs` that keeps the plugin's root entry out. They can also drop the `LEGACY_PARTIAL_COMMIT_ERROR_NAME` name match in `cadre-core/src/control-write-retry.ts` and use `import { PartialCommitError } from '@optimystic/quereus-plugin-optimystic'` with `instanceof`. That change is theirs to make, not this repo's.

# Review checklist

- Read `browser-bundle.spec.ts`. Does `logOverride` really promote `import.meta` from `node_modules`? To confirm, add `export const u = import.meta.url;` to any file in the graph and run the spec.
- Is the new wording of Theorem 4 step 1 in `docs/correctness.md` accurate against `TransactionValidator.validate` in `packages/db-core/src/transaction/validator.ts` (the `Unknown engine` refusal and the operations-hash comparison)?
- Confirm that `yarn pub` publishes `src/transaction/quereus-version.ts` (`files` includes `src`) and never needs `scripts/` at install time (it does not: `scripts/` is build-time only and is not in `files`).
