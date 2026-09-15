description: A test in the core package imported a cryptography library the package never listed as a dependency, and a new repo-wide check now catches any package doing that again.
files: packages/db-core/package.json, packages/db-core/test/reactivity/recover.spec.ts, packages/quereus-plugin-optimystic/package.json, scripts/check-undeclared-deps.mjs, package.json (root `lint:deps` script), AGENTS.md (§ Dependencies), scripts/check-libp2p-majors.mjs (sibling guard, same pattern)
difficulty: easy
----

# What was done (fix stage did the implementation directly — this is a small, well-scoped change)

The root cause and the class-wide guard were both straightforward enough that the fix stage
implemented and verified them directly rather than just researching. This ticket exists so the
required implement → review handoff still happens, and so a reviewer has one place to look.

## The point fix

`packages/db-core/test/reactivity/recover.spec.ts` imports `@noble/curves/ed25519.js`.
`packages/db-core/package.json` declared `@noble/hashes` but never `@noble/curves` — it only
resolved because Yarn's `node_modules` linker happens to nest a copy under
`packages/db-core/node_modules` for one of db-core's libp2p `devDependencies`. Added
`"@noble/curves": "^2.0.1"` to `packages/db-core/package.json`'s `devDependencies` — the same range
every other workspace in this repo uses for it (`packages/db-p2p/package.json`,
`packages/quereus-plugin-crypto/package.json`).

## The class-wide guard

Added `scripts/check-undeclared-deps.mjs`, following the shape of the two existing dependency
guards described in `AGENTS.md` § Dependencies (`scripts/check-libp2p-majors.mjs`,
`yarn.config.cjs` constraints): plain `.mjs`, no dependencies, no build step.

It reads every `packages/*/package.json`, walks that workspace's own `src/` and `test/` (via
`git ls-files`, same approach as `scripts/check-doc-citations.mjs` — never a filesystem walk, so a
local `node_modules`/`dist` can't be scanned as if it were source), extracts every bare import
specifier (`import ... from`, `export ... from`, dynamic `import(...)`, `require(...)`), and fails
if the specifier's package name is not a Node builtin and not declared in that workspace's own
`dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`.

Comments (`/* ... */`) and backtick template literals are blanked before scanning — not because
they can contain real imports, but because they produced false positives during development: a
JSDoc `{@link import("@optimystic/db-p2p").verifyPeerSig}` in `packages/db-core/src/matchmaking/wire.ts`,
and `packages/db-core/test/no-fret-import.spec.ts`'s fixture arrays of import-syntax *strings* used
to test its own import-detecting regex. Plain `'...'`/`"..."` strings are left alone — that's the
actual shape a real import specifier takes.

**Why a script and not an ESLint rule:** the ticket that requested this asked for an ESLint rule
first if a maintained one fits the repo's deliberately narrow flat config (see the SCOPE comment in
`eslint.config.js` — it avoids the `typescript-eslint`/`@eslint/js` recommended presets on purpose).
`eslint-plugin-import`'s `no-extraneous-dependencies` is the closest fit, but it adds a new
dependency, needs resolver configuration to follow this repo's NodeNext-style
`@noble/curves/ed25519.js` subpath specifiers, and its flat-config support has been uneven. Given
the small size of the problem, a standalone script matching the sibling guards' own established
pattern was faster to get right and easier for the next reader to audit than diagnosing resolver
behavior in a third-party plugin. If a maintained rule later covers this cleanly, replacing the
script is a reasonable follow-up — not required now.

Wired into `yarn lint:deps` (chained after `check-libp2p-majors.mjs`, before `yarn check`'s build
step), and documented in `AGENTS.md` § Dependencies alongside the other two guards.

## Real instances the first run found and fixed

The first run (after the comment/template-literal fix removed the false positives above) found two
more real undeclared imports, both test-only:

- `packages/quereus-plugin-optimystic/test/collection-factory-key-network.spec.ts` imports
  `@libp2p/peer-id`.
- `packages/quereus-plugin-optimystic/test/two-node-secondary-index-libp2p.integration.spec.ts`
  imports `@multiformats/multiaddr`.

Neither was declared in `packages/quereus-plugin-optimystic/package.json`. Added both to its
`devDependencies`, at the same ranges every other workspace in the repo uses for them (`^6.0.4` and
`^13.0.1` — see `packages/db-p2p/package.json`, `packages/reference-peer/package.json`).

After these two fixes, `node scripts/check-undeclared-deps.mjs` passes clean: 819 files across 11
packages.

## Verification already done

- `yarn lint:deps` (constraints + libp2p-majors + the new check) — passes.
- `yarn lint` (eslint) — passes.
- `yarn lint:docs` — passes (AGENTS.md edit didn't break any citation).
- `yarn workspace @optimystic/db-core typecheck` — passes.
- `yarn workspace @optimystic/db-core test` — 1640 passing.
- `yarn workspace @optimystic/quereus-plugin-optimystic typecheck` — passes.
- `yarn workspace @optimystic/quereus-plugin-optimystic build` — passes.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 800 passing, 13 pending, plus its
  `test:smoke` step — all green (this one took ~5 minutes; it fans out into live TCP/FRET meshes).

# TODO

- [ ] Run `yarn check` (or as much of it as fits the time budget) for final confidence before
      handing to review — the individual pieces above are verified, but the full pre-release gate
      (all 11 workspaces' build + typecheck + test + test:integration) has not been run end to end
      for this change.
- [ ] In the review handoff, flag the separate observation from the original ticket: this repo's
      `.yarnrc.yml` is gitignored (`.gitignore:94`) and not tracked, so a fresh clone installs with
      Yarn's default Plug'n'Play linker rather than the `node_modules` linker the maintainers'
      checkouts apparently use — which is *why* the original bug was invisible locally. That is a
      human decision (commit it vs. leave it machine-specific), not something to change unilaterally
      here.
