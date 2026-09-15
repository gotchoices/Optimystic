description: A test in the core package imported a cryptography library the package never listed as a dependency (it only worked by accident of the local install layout), and a new repo-wide check now catches any package doing that again; review the point fix, the new check, and the two other real instances it caught.
files: packages/db-core/package.json, packages/db-core/test/reactivity/recover.spec.ts, packages/quereus-plugin-optimystic/package.json, scripts/check-undeclared-deps.mjs, package.json (root `lint:deps` script), AGENTS.md (§ Dependencies)
difficulty: easy
----

# What was done

Implement stage found this work already landed in commit `1ae87282` ("ticket(fix):
a-package-can-import-a-dependency-it-does-not-declare") — the fix stage implemented and verified it
directly rather than only researching, per that ticket's own note. This review ticket is the required
implement → review handoff and the one place to look for what changed and what to check.

## The point fix

`packages/db-core/test/reactivity/recover.spec.ts` imports `@noble/curves/ed25519.js`.
`packages/db-core/package.json` declared `@noble/hashes` but never `@noble/curves` — it only resolved
because Yarn's `node_modules` linker happens to nest a copy under `packages/db-core/node_modules` for
one of db-core's libp2p `devDependencies`. Fixed by adding `"@noble/curves": "^2.0.1"` to
`packages/db-core/package.json`'s `devDependencies` — the same range every other workspace in this
repo uses for it.

## The class-wide guard

New script `scripts/check-undeclared-deps.mjs`, following the shape of the two existing dependency
guards documented in `AGENTS.md` § Dependencies (`scripts/check-libp2p-majors.mjs`, the `yarn
constraints` config): plain `.mjs`, no dependencies, no build step.

It reads every `packages/*/package.json`, walks that workspace's own `src/` and `test/` (via `git
ls-files`, so a local `node_modules`/`dist` can never be scanned as if it were source), extracts every
bare import specifier (`import ... from`, `export ... from`, dynamic `import(...)`, `require(...)`),
and fails if the specifier's package name is not a Node builtin and not declared in that workspace's
own `dependencies` / `devDependencies` / `peerDependencies` / `optionalDependencies`.

Comments and backtick template literals are blanked before scanning (both produced false positives
during development — a JSDoc `{@link import(...)}` and a spec file whose fixture arrays contain
import-syntax *strings* used to test its own import-detecting regex). Plain quoted strings are left
alone, since that is the real shape of an import specifier.

Wired into `yarn lint:deps` (chained after `check-libp2p-majors.mjs`, before `yarn check`'s build
step) and documented in `AGENTS.md` § Dependencies alongside the other two guards.

**Why a script and not an ESLint rule** (the ticket that requested this asked for a rule first if a
maintained one fits): recorded as an accepted-tradeoff `NOTE:` at the top of
`scripts/check-undeclared-deps.mjs` now (added during this stage — it previously lived only in the
implement ticket's prose, which does not survive ticket archival). Revisit condition is stated there:
if a maintained ESLint rule later covers this cleanly, replacing the script is reasonable.

## Real instances the first run found and fixed

Two more real undeclared imports, both test-only, in `packages/quereus-plugin-optimystic`:

- `test/collection-factory-key-network.spec.ts` imports `@libp2p/peer-id`.
- `test/two-node-secondary-index-libp2p.integration.spec.ts` imports `@multiformats/multiaddr`.

Neither was declared in `packages/quereus-plugin-optimystic/package.json`. Fixed by adding both to its
`devDependencies`, at the ranges every other workspace in the repo uses for them (`^6.0.4` and
`^13.0.1`).

# Validation run

Already done by the fix stage (per its ticket notes, not re-verified line-by-line here):
- `yarn lint:deps`, `yarn lint`, `yarn lint:docs` — pass.
- `yarn workspace @optimystic/db-core typecheck` and `test` (1640 passing) — pass.
- `yarn workspace @optimystic/quereus-plugin-optimystic typecheck`, `build`, `test` (800 passing, 13
  pending) plus `test:smoke` — pass.

Re-verified this stage, after adding the accepted-tradeoff `NOTE:` comment to
`check-undeclared-deps.mjs` (the only change made in this stage — a comment, no behavior change):
- `yarn lint:deps` — `check-libp2p-majors: 5 guarded packages, 10 installed versions, each on its
  expected major`; `check-undeclared-deps: 827 files across 11 packages — every import is declared.`
- `yarn lint` (eslint, repo-wide) — clean.
- `yarn lint:docs` — `45 documents, 100 anchored citations, 602 file mentions, 341 links — all
  resolve` (confirms the AGENTS.md edit and the ticket-slug reference in the new `NOTE:` still
  resolve).
- `yarn build` (all 11 workspaces via `yarn workspaces foreach`) — all succeed.
- `yarn typecheck` (all 11 workspaces) — all succeed.

**Not run this stage or the fix stage:** `yarn test` and `yarn test:integration` across the full
11-workspace monorepo (i.e. the remaining two legs of `yarn check`, beyond the two touched packages'
own test suites already run). This change touches only manifests, a new standalone script, and docs —
no package's runtime source — so the risk from the untested packages is low, but it has not been
empirically confirmed end-to-end. If review time allows, running `yarn test` for the remaining 9
workspaces (excluding `db-core` and `quereus-plugin-optimystic`, already verified) would close this
gap; `test:integration` is the more expensive tier and is the more reasonable one to skip given the
change's shape.

# Use cases for the reviewer

- Confirm the guard actually catches what it claims to: temporarily add an undeclared bare import to
  any `packages/*/src` or `test` file and run `node scripts/check-undeclared-deps.mjs` — it should
  name the file, the specifier, and the missing package, then exit non-zero. Revert the temporary
  edit afterward.
- Confirm it does *not* false-positive on the two cases that motivated the comment/template-literal
  blanking: `packages/db-core/src/matchmaking/wire.ts`'s JSDoc `{@link import(...)}`, and
  `packages/db-core/test/no-fret-import.spec.ts`'s fixture strings. Both are already in the tree and
  the clean 827-file run above covers them, but worth knowing why they don't trip the check if you're
  auditing the regex logic.
- Confirm the two `quereus-plugin-optimystic` devDependency additions use the same version ranges as
  the rest of the repo (`^libp2p/peer-id@^6.0.4`, `^multiformats/multiaddr@^13.0.1`) — grep
  `packages/db-p2p/package.json` or `packages/reference-peer/package.json` for the same two packages.
- `node scripts/check-undeclared-deps.mjs --help` documents usage inline, matching the sibling
  scripts' convention.

# Separate observation for the reviewer to route

This repo's `.yarnrc.yml` is gitignored (`.gitignore:94`) and not tracked, so a fresh clone installs
with Yarn's default Plug'n'Play linker rather than the `node_modules` linker the maintainers'
checkouts apparently use — which is *why* the original bug (`@noble/curves` resolving without being
declared) was invisible in normal local development and only surfaced in a fresh-worktree install.
This is a human decision (commit a `.yarnrc.yml` that pins the `node_modules` linker for everyone, vs.
leave it machine-specific) — not something the fix or implement stage should change unilaterally.
Flagging here so review can route it (most likely a `blocked/` ticket, since "should we standardize
the linker" is a decision only a human should make, not a `backlog/` shape-is-settled item).

# Tripwires and accepted tradeoffs recorded in code

- `scripts/check-undeclared-deps.mjs`, top-of-file `NOTE:` (added this stage): accepted tradeoff —
  standalone script instead of an ESLint rule, with the reasons and a stated revisit condition (a
  maintained rule that covers this cleanly without the listed costs).
- `scripts/check-undeclared-deps.mjs`, `stripCommentsAndTemplates` docstring: known false-positive
  source (a `//` line comment or a regex literal containing quote characters can still misread as an
  import) — deliberately left unhandled because it only ever adds a finding to chase down, never hides
  a real undeclared dependency. Not re-recorded as a separate finding here; it's already inline at the
  site.
