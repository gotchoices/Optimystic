description: A test in the core package imported a cryptography library the package never listed as a dependency (it only worked by accident of the local install layout); that is fixed, and a new repo-wide check now fails if any package imports something it does not declare.
files: packages/db-core/package.json, packages/quereus-plugin-optimystic/package.json, scripts/check-undeclared-deps.mjs, package.json (root `lint:deps` script), AGENTS.md (§ Dependencies), yarn.lock
----

# What landed

- **Point fix:** `packages/db-core/test/reactivity/recover.spec.ts` imports `@noble/curves/ed25519.js`, but `packages/db-core/package.json` never declared `@noble/curves`. It only resolved because the `node_modules` linker nested a copy there for a libp2p devDependency. It is now in db-core's `devDependencies` at `^2.0.1`, the range every other workspace uses.
- **Class-wide guard:** `scripts/check-undeclared-deps.mjs`, chained into `yarn lint:deps` (and so into `yarn check`). For each `packages/*` workspace, it takes the tracked JS/TS files (listed through `git ls-files`), extracts every bare import, re-export, dynamic `import()` and `require()` specifier, and fails if a specifier's package is neither a Node builtin nor declared in that workspace's own `dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies`. It is documented in AGENTS.md § Dependencies next to the other two dependency guards.
- **Two more real instances the guard caught**, both in `packages/quereus-plugin-optimystic` test files: `@libp2p/peer-id` (`^6.0.4`) and `@multiformats/multiaddr` (`^13.0.1`), now declared as devDependencies.
- The top of the script records an accepted-tradeoff `NOTE:` explaining why this is a standalone script and not an ESLint rule, with its revisit condition.

# Review findings

Diffs read first: `1ae87282` (fix stage, which did the actual work) and `cc916c23` (implement stage, which added only the accepted-tradeoff NOTE comment).

**Correctness of the guard — checked, one real defect found and fixed.**
- Built an independent oracle: TypeScript's own scanner (`ts.preProcessFile`, which handles comments, strings, templates and regex literals properly) run over every scanned file, compared with the script's extraction. Result: 0 missed and 0 extra specifiers over all 827 original files, and again over all 841 after widening the scope (below).
- Defect: the old comment stripper blanked `/* */` comments and template literals in two separate passes, and ignored quoted strings and `//` comments. The docstring claimed this "only ever adds a finding, never hides an undeclared dependency". That claim was false. I confirmed with a probe that a lone backtick in a `//` comment blanked everything up to the next backtick, which hid a real `import pad from 'left-pad'`. A `/*` inside a quoted string (say, a glob like `'src/*.ts'`) could do the same. **Fixed:** replaced it with one left-to-right pass that matches strings, templates, line comments and block comments together, so whichever opens first wins; strings are kept, the rest blanked. Probes now pass for: a backtick in a line comment, a glob string, a URL string (`'http://…'`), a JSDoc `{@link import(...)}`, and an import-shaped template fixture. The docstring now states the one remaining gap honestly (regex literals).
- Negative test: planted an untracked file with an undeclared import. The script named the file, the specifier and the manifest, and exited 1. Removed the file afterwards; a clean run exits 0. `--help` works.

**Robustness — two minor defects, fixed.**
- A file git still indexes but that was deleted in the working tree (not yet staged) made `readFileSync` throw, crashing the script. Such files are now skipped (only `ENOENT`; other errors still throw). Found by reading the code, not reproduced: deleting a tracked file would disturb the shared working tree.
- During a conflicted merge, `git ls-files --cached` lists a path once per index stage, which would repeat findings. Paths are now deduplicated.

**Coverage — minor gap, fixed.** The scan covered only `src/` and `test/`, which skipped each package's `register.mjs`, `tsup.config.ts` and `db-p2p/.aegir.js`. It now covers every tracked JS/TS file in a workspace, `.cjs` included (841 files, up from 827). All currently declare what they import (`tsup` is declared in both packages that use it). I updated AGENTS.md, the script header and the `--help` text to match. Not covered, by design: string module names passed to APIs, such as `register('ts-node/esm', …)`. `ts-node` is declared in every package that does this anyway.

**Manifests and lockfile — checked, no issues.** The added ranges match every other workspace (`@noble/curves ^2.0.1`, `@libp2p/peer-id ^6.0.4`, `@multiformats/multiaddr ^13.0.1`). The `yarn.lock` diff only adds dependency edges to the two workspaces' own entries, with no resolution changes. `yarn constraints` passes, and its single-blessed-range rule for `@libp2p/peer-id` is satisfied.

**Duplication (DRY) — noticed, left alone.** `trackedFiles()` is nearly the same in `check-doc-citations.mjs` and `check-undeclared-deps.mjs`. It is about 12 lines, and the sibling guards follow a deliberate "each script stands alone, no shared module" convention (see the script header), so extracting a shared helper isn't worth breaking that. No ticket.

**Types, performance, resource cleanup — nothing to report.** It's a plain `.mjs` lint script: synchronous reads, no handles to close, and one `git` subprocess. The whole `lint:deps` chain runs in seconds.

**Docs — checked.** AGENTS.md § Dependencies has been updated for the wider scope. The script header, docstrings and help text match what the script now does. `yarn lint:docs` passes.

**Tripwires recorded:**
- `scripts/check-undeclared-deps.mjs`, `NOTE:` on `stripCommentsAndTemplates`: regex literals are not recognised, so one containing a backtick, `//` or `/*` could hide a later import. None exist today (the TypeScript comparison matched on every file). If a miss is ever suspected, re-run that comparison or switch extraction to `ts.preProcessFile`.
- Accepted tradeoff kept as-is: standalone script instead of an ESLint rule (NOTE at the top of the script). Its revisit condition has not tripped.

**Routed elsewhere:**
- New `blocked/decide-whether-to-commit-the-yarn-linker-setting`: `.yarnrc.yml` is gitignored because it holds secrets, so fresh clones install with Yarn's default Plug'n'Play linker, while maintainer checkouts use `nodeLinker: node-modules` (confirmed locally by reading only that key). That mismatch is how this bug stayed hidden. Whether to standardize is a maintainer decision.

**Validation run this stage (after the fixes):**
- `yarn lint` — clean.
- `yarn lint:docs` — 45 documents, 100 anchored citations, 602 file mentions, 341 links, all resolve.
- `yarn lint:deps` — constraints pass; `check-libp2p-majors`: 5 guarded packages, 10 installed versions, each on its expected major; `check-undeclared-deps`: 841 files across 11 packages, every import declared.
- Not run: `yarn test` / `yarn test:integration` for the 9 workspaces besides db-core and quereus-plugin-optimystic. The earlier stages ran those two packages' suites (db-core 1640 passing; plugin 800 passing, 13 pending, plus smoke). No package's runtime source changed, and the lockfile change only adds declared edges without changing resolutions, so the other workspaces' tests cannot be affected by this diff. The earlier stages ran `yarn build` and `yarn typecheck` across all 11 workspaces, and my changes this stage touch only the lint script and docs.
