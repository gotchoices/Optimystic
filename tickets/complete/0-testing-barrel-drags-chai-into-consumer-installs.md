description: Anyone who installed a package depending on db-p2p could not load it at all — it crashed looking for a test-assertion library (chai) that is deliberately not shipped to consumers. Fixed by splitting the shared export list so the test-only helper lives on its own import path, plus a new automated check that stops the same mistake recurring on any published entry point.
prereq:
files: packages/db-p2p/src/testing/index.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/package.json, packages/db-p2p/test/testing-entry-runtime-deps.spec.ts, packages/db-p2p/docs/storage.md, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-rn/test/leveldb-storage.spec.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts, packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts, packages/db-p2p-storage-fs/README.md
difficulty: easy
----

# Complete — chai no longer reachable from any consumer-facing entry point

## What was wrong

`@optimystic/db-p2p` publishes an entry point called `./testing`. Its export list bundled two
unrelated things: `mesh-harness.ts` (in-process multi-node test mesh, built entirely on runtime
dependencies, and imported by *production* code in the Quereus plugin) and
`raw-storage-conformance.ts` (a shared assertion suite that imports `chai`). Because `chai` is a
devDependency, it is not installed for anyone who merely installs the package — so importing
`@optimystic/db-p2p/testing` crashed at load time with `Cannot find package 'chai'`.

## Fix as shipped

- `src/testing/index.ts` re-exports only `./mesh-harness.js`.
- `package.json` gained an `exports` subpath `./testing/conformance` pointing directly at
  `raw-storage-conformance.js`, so backends that want the conformance suite opt into `chai`
  explicitly. `chai` remains a devDependency.
- The four storage-backend suites (`-fs`, `-rn`, `-web`, `-ns`) and the `-fs` README were
  repointed to the new subpath.

That much landed in the implement stage. Everything below is this review pass.

## Review findings

### Correctness of the diff — no defects found

Read the full implement-stage change with fresh eyes before the handoff summary. Note for the
record: commit `ab06122` (`ticket(implement)`) contains **only the ticket file move** — the code
change actually landed one commit earlier, in `adff411` (`ticket(fix)`). The handoff described the
change accurately, but a reviewer following the stated "read the implement diff" path sees nothing.

The change itself is minimal and correct. No scope creep. Independently confirmed:

- `chai` appears exactly once in `packages/db-p2p/src` — in `raw-storage-conformance.ts`. Nothing
  reachable from `./`, `./rn`, or `./testing` touches it.
- Every reference to the conformance suite repository-wide was repointed. The two remaining
  importers of the plain `./testing` barrel (`collection-factory.ts`,
  `two-node-multi-collection-commit.spec.ts`) only want mesh-harness symbols, which are still
  exported.
- The three other harnesses in `src/testing/` (cohort-topic, matchmaking, reactivity) were never in
  the barrel and import no devDependency, so they were correctly left alone.

### Second live defect found and fixed in this pass — undeclared `@noble/*` dependencies

Same bug class, on the **main** entry point rather than `./testing`. `src/cohort-topic/peer-sig.ts`
imports `@noble/curves/ed25519.js` and `src/matchmaking/query-transport.ts` imports
`@noble/hashes/utils.js`, but `packages/db-p2p/package.json` declared neither. Both resolve in this
repo only because Yarn hoists them out of a libp2p transitive dependency into
`packages/db-p2p/node_modules` — an accident of the install layout, not a guarantee. A consumer on a
strict installer (pnpm), or one whose libp2p version resolves a different major of `@noble/*`, gets
the same class of load-time failure this ticket exists to fix.

Fixed inline: declared `"@noble/curves": "^2.0.1"` and `"@noble/hashes": "^2.0.1"` — the versions
already resolved here and already declared by `db-core`, `quereus-plugin-crypto`, and
`quereus-plugin-optimystic`. `yarn install` added two lockfile lines and resolved no new packages.

### Test coverage — the implementer's tests did not cover this at all, so a guard was added

The four repointed backend suites prove the *new* path works, but nothing anywhere asserted the
*old* path stays clean — a single stray `export * from './raw-storage-conformance.js'` would have
silently reintroduced the bug, and nothing in `yarn check` or `scripts/release-preflight.mjs`
(a typed-confirmation gate only — it validates no packaging at all) would have caught it.

Added `packages/db-p2p/test/testing-entry-runtime-deps.spec.ts`: for every `exports` subpath except
the explicitly devDependency-based `./testing/conformance`, it walks the **source** import graph
(not `dist`, so it holds with or without a build) from that subpath's entry file and asserts every
bare specifier it reaches is a declared runtime `dependency`. It only counts specifiers that survive
to runtime — whole-statement `import type` / `export type` are skipped, which is exactly right under
the repo's `verbatimModuleSyntax: true`.

Two things worth stating about this guard: it is what **found** the `@noble/*` defect above, and it
was mutation-checked — temporarily re-adding the conformance re-export to the barrel makes it fail
with `"chai"` in the diff, and the file was restored immediately after.

### Docs — one stale statement found and fixed

Treated all docs as out of date and read every file mentioning the conformance suite or the
`./testing` entry:

- `packages/db-p2p/docs/storage.md:93` said the conformance suite is "exported from the `./testing`
  entry" — false after the fix. **Fixed**, and it now states *why* the split exists.
- `docs/internals.md:698`, `packages/db-p2p/docs/storage.md` elsewhere, `docs/cohort-topic.md`,
  `docs/matchmaking.md`, `docs/optimystic.md`, `docs/reactivity.md` — all reference harnesses by
  *source path* (`src/testing/…`), which is unchanged and still accurate. No edit needed.
- `packages/db-p2p-storage-fs/README.md` was already updated by the implementer; the `-rn`, `-web`,
  and `-ns` READMEs never mentioned the import specifier, so nothing to update there.

### Packaging gap the implementer flagged — closed, by a better check than the one proposed

The handoff flagged that no literal `npm pack` + external install was done, correctly noting it
would prove nothing because `"@optimystic/db-core": "workspace:^"` cannot resolve from a tarball
packed straight from this tree. Agreed — but the *useful* half of that check was still worth doing:
an `exports` target that is not actually packed is a broken subpath. Ran `yarn pack --dry-run` and
confirmed all four targets (`dist/src/index.js`, `dist/src/rn.js`, `dist/src/testing/index.js`,
`dist/src/testing/raw-storage-conformance.js`) plus their `.d.ts` files are included by the `files`
field. Gap closed; no ticket needed.

### The `exports` subpath shape — confirmed as the right long-term choice

The handoff asked whether the file should instead move out of `src/testing/` entirely. It should
not: external backends consume the conformance suite, so it must ship under `src/`, and
`packages/db-p2p/test/kv-raw-storage.spec.ts` imports it by relative path. Moving it would relocate
the problem, not remove it. The subpath split is correct.

### Design question the handoff deferred to review — dropped, no ticket filed

Production code (`collection-factory.ts`'s `mesh-test` transactor) importing from a barrel named
`testing` was flagged as a smell worth possibly filing. **Decision: drop it, do not file.** The
barrel is now provably free of devDependencies *and* that property is enforced by a test, so the
concern is naming taste rather than a correctness risk, and there is no defect to describe. Renaming
a published entry point is a breaking change with no user-visible benefit. The reason production
code depends on this barrel is now documented at the site (`src/testing/index.ts`) so the constraint
travels with the file.

### Tripwires recorded (conditional — deliberately not tickets)

- `./testing/conformance` points straight at a single module rather than a barrel. Fine for one
  helper; if a second devDependency-based helper is ever added it should get a
  `src/testing/conformance/index.ts` barrel instead of a third subpath. Parked as a `NOTE:` in
  `packages/db-p2p/src/testing/index.ts` beside the export.

### Checked and clean — nothing found

- **Resource cleanup / error handling / performance**: not applicable. The diff is an export-list
  edit, a `package.json` change, and import-specifier updates — no runtime logic changed.
- **Type safety**: `verbatimModuleSyntax` + `Node16` resolution across the monorepo; the new subpath
  carries an explicit `types` condition, and the full build passes.
- **Source hygiene**: `src/testing/index.ts` is one export plus a comment that earns its length (it
  states the invariant, the reason, and the enforcing test). The new spec is 118 lines of small
  named functions with no comment blocks standing in for structure.

## Validation run in this pass

All from a clean tree, all green:

- `yarn build` (every workspace) — success.
- `yarn lint` (eslint, monorepo) — exit 0, no warnings.
- `yarn workspace @optimystic/db-p2p test` — **1510 passing, 44 pending** (was 1506; +4 from the new
  guard spec).
- `db-p2p-storage-fs` 52 passing / 1 pending, `-rn` 44 passing, `-web` 43 passing, `-ns` 49 passing.
- `quereus-plugin-optimystic` smoke test — passes.
- Mutation check of the new guard — fails with `"chai"` when the bug is reintroduced.
- `yarn pack --dry-run` — all `exports` targets present in the tarball.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Not verified

A true external install of a published tarball into a fresh project. It is not runnable from this
tree (`workspace:^` dependency), and it is a release-time concern rather than a code concern. The
source-graph guard plus the pack listing cover the same ground for anything the repo controls.
