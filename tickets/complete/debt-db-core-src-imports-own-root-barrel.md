description: Files inside the db-core package used to import from barrel files that re-export those same files, which made the modules load in a circle; they now import directly from the modules that define what they need, and a test keeps it that way.
files: packages/db-core/src/btree/btree.ts, packages/db-core/src/chain/chain.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/collections/tree/collection-trunk.ts, packages/db-core/src/log/log.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/test/barrel-import-cycle.spec.ts, packages/db-core/test/source-scan.ts, docs/internals.md

## What the finished work is

A "barrel" is an `index.ts` that re-exports the other files in its directory. When a module
imports a barrel that sits at or above it, that barrel re-exports the module itself — so the
module depends on a file that depends on the module. Node evaluates the whole group as one cycle,
and whichever module is entered first decides which parts of the group are still half-built when
the rest runs. This had already produced a real failure (`debt-db-core-single-spec-import-cycle`):
three specs died with `ReferenceError: Cannot access 'collectionTypes' before initialization` when
run alone and passed inside the full suite.

The finished state: **no module under `packages/db-core/src/` imports, at runtime, a barrel that
re-exports it** — neither the package root barrel (`src/index.ts`) nor its own subtree's
(`src/log/index.ts` seen from `src/log/log.ts`). Importing a *sibling* subtree's barrel
(`src/blocks/index.js` from `src/btree/`) stays fine; it does not re-export the importer, so there
is no cycle. Clause-level `import type` / `export type` is exempt — TypeScript erases those
statements whole, leaving no runtime module edge.

`packages/db-core/test/barrel-import-cycle.spec.ts` enforces it. The detector resolves each
specifier and flags any runtime edge landing on an `index.js` in an ancestor-or-self directory,
across every static import form (named, default, namespace, star re-export, bare side-effect).
Dynamic `import()` is deliberately not flagged — it is evaluated lazily, so it cannot participate
in module-initialization order. `docs/internals.md` § "Common Pitfalls → 6. Importing a Barrel
That Re-exports You" documents the symptom, the fix, and the type-only exemption.

## Implement stage (commit d40a826)

- Ten runtime imports of `src/index.ts` from inside `src/` re-pointed at defining modules:
  `chain/chain.ts`, `collection/collection.ts`, `collections/diary/diary.ts`,
  `collections/tree/collection-trunk.ts`, `log/log.ts`, `testing/test-transactor.ts`,
  `transaction/coordinator.ts`, `transactor/network-transactor.ts`, `transform/cache-source.ts`,
  `transform/tracker.ts`. Every symbol had an unambiguous defining module; no layering problem
  surfaced.
- `test/registrar-import-cycle.spec.ts` → `test/root-barrel-import-cycle.spec.ts`, broadened from
  "two registry symbols" to "no runtime import of the root barrel from anywhere under `src/`", with
  the edge detector widened from named-binding clauses to every static import form.
- `docs/internals.md` pitfall section added.

## Review stage (this pass)

- Generalized the invariant from *root* barrel to *any barrel that re-exports the importer*, and
  fixed the three remaining instances that the narrower rule had allowed (below).
- Renamed the guard `root-barrel-import-cycle.spec.ts` → `barrel-import-cycle.spec.ts` to match.
- Removed a dead parameter in `network-transactor.ts`.

## Review findings

**Checked:** the full implement diff read before the handoff summary; the ten re-points against
their new defining modules; the guard spec's detector against adversarial import forms; whether
the chosen invariant covers the defect class; the `verbatimModuleSyntax` claim the type-only
exemption rests on; every other package for the same pattern; `docs/internals.md` and
`test/source-scan.ts` for stale references; source hygiene of the touched files; repo build, lint,
and the full test suite.

### Major — the invariant was narrower than the defect class (fixed in this pass)

The implementation guarded "no runtime import of the *root* barrel". But the mechanism has nothing
to do with the barrel being the root one — any barrel at or above a module re-exports it, so a
*subtree* barrel is the same cycle at smaller radius. The guard spec listed exactly that case as
an **allowed** self-test (`import { apply } from "../index.js"` — "subtree barrel, not the root
one"), so the class was explicitly blessed rather than overlooked.

A resolve-based scan of all 11 packages under the broadened rule found three live instances, all
in db-core, all cycles:

| Site | Was | Now |
|---|---|---|
| `src/collection/collection.ts:10` | `CollectionHeaderVanishedError, SyncRetryExhaustedError` from `./index.js` | `./struct.js` |
| `src/log/log.ts:7` | `LogDataBlockType, LogHeaderBlockType` from `./index.js` | `./struct.js` |
| `src/btree/btree.ts:1` | `Path, PathBranch` from `./index.js` | `./path.js` (the three types stay type-only on `./index.js`) |

The `collection/` one is not academic: `collection/index.ts` re-exports
`collection-type-registry.js`, the module whose module-scope `Map` caused the original
`ReferenceError`. The root-barrel fix removed one cycle through that registry and left another.

Rather than file three point fixes, the guard's rule was replaced (`isRootBarrel` →
`isSelfReexportingBarrel`): resolve the specifier; if it lands on an `index.js` whose directory is
an ancestor-or-self of the importing file, it is a violation. This subsumes the root barrel (`src/`
is above everything under it) and needs no barrel-contents graph walk. A barrel that deliberately
omitted the importer would be flagged without being a cycle today — that is the safe direction
(adding the file to the barrel later would make it one) and the fix, importing the defining module,
is always available. Reasoning recorded in the spec's doc comment.

Re-ran the scan after the fix: **all 11 packages, 0 violations** under the broadened rule — a
stronger result than the implement stage's root-only sweep.

### Minor — dead parameter in `network-transactor.ts` (fixed in this pass)

The implementer flagged `commitBlock(blockId, blockIds, …)` never reading `blockIds` and correctly
identified it as pre-existing (confirmed present at `d40a826^`), then left it. Reading the call
sites showed the local `allBlockIds` computed in `commit()` existed *only* to feed that ignored
parameter, so it was dead too. No behavioural bug — the non-tail blocks are committed separately
via `remainingBlocks`. Both the parameter and the local were removed; `commit()`'s two call sites
updated.

### Verified — the implementer's stated gaps

- *"No test would catch a wrong re-point (right name, wrong module)."* Lower risk than stated:
  the barrels are all `export *`, so under ES-module semantics a name exported by two modules is
  ambiguous and excluded from the star export entirely. In practice each re-exported name has one
  defining module, and `tsc` verifies every new specifier actually exports the name it is asked
  for. The build plus the 1357-test db-core suite are the behavioural evidence.
- *"27 clause-level `import type … from "../index.js"` remain; flipping a compiler option would
  resurrect the cycle wholesale."* Overstated, no action needed. A clause-level `import type` is
  erased by TypeScript in **every** mode, not only under `verbatimModuleSyntax`; that flag governs
  the *inline* `import { type X }` form and un-annotated type-only imports. The 27 are not a
  compiler-flag hazard. (`verbatimModuleSyntax: true` confirmed at `tsconfig.base.json:19`.)
- *"The detector is a regex, not a parser — is that the janky-parser AGENTS.md forbids?"* Verdict:
  acceptable. It recognises a closed set of statement shapes, its output drives nothing but a test
  assertion, its failure direction is a missed violation rather than corrupted downstream data, and
  it carries negative self-tests. The prohibition targets parsers whose output feeds program logic.
  Two adversarial forms were tried against it: an interleaved comment inside the clause
  (`import /* x */ { a } from …`) **is** caught — added as a forbidden self-test; a comment closing
  on the same line *before* the keyword is **not** (see tripwire below).
- *"Dynamic `import()` deliberately not flagged."* Agreed — lazy evaluation cannot affect
  module-initialization order. Left as-is.

The guard was also proven to fire end-to-end on the newly-covered case, not just on synthetic
strings: a probe file `src/log/__probe.ts` containing `import { LogDataBlockType } from
"./index.js";` made the spec fail naming the probe and the exact statement. Probe deleted.

### Tripwires (recorded in code, not filed as tickets)

- **Detector misses an import preceded on the same line by a closing block comment.** `NOTE:` at
  `moduleEdges()` in `packages/db-core/test/barrel-import-cycle.spec.ts`. No file in the repo is
  written that way; if that style appears, strip comments before matching rather than widening the
  statement anchor (widening re-admits matches inside string literals).
- **The guard only scans db-core.** `NOTE:` already in `docs/internals.md` from the implement
  stage, kept: the other ten packages were re-swept clean under the broadened rule; if one grows
  the pattern, lift the spec into a shared per-package check rather than copying it.
- **Only *structural* cycles are caught.** The rule covers barrels that re-export the importer by
  construction. A cycle routed through a *sibling* subtree's barrel (A → `b/index.js` → `b/x.ts` →
  A) would need a full module-graph walk and is not detected. None exists today; noted here rather
  than in code because it is architectural with no single site.

### New tickets filed: none

No finding needed one. The two real findings were both small enough to resolve in this pass, and
resolving the major one at the invariant level (widen the guard's rule) retires the whole class
rather than the three instances — so there is no residual work to queue. The three conditional
concerns are recorded as tripwires above, which is deliberately not ticket work.

### Docs

`docs/internals.md` § 6 rewritten from "Importing a Package's Own Root Barrel from Inside It" to
"Importing a Barrel That Re-exports You", covering the root and subtree cases and stating
explicitly that a sibling subtree's barrel is fine. `test/source-scan.ts`'s doc comment updated for
the spec rename. Grepped the repo for the old spec names — the only remaining hits are stale
`dist/` build artifacts, regenerated on build.

## Validation

From repo root unless noted; all in the final post-review state.

- `yarn build` (all 11 packages) — clean, `Done in 19s`.
- `yarn lint` (`eslint .`) — clean, exit 0, no output.
- `yarn test` (all packages) — green: 1357 / 1540 / 53 / 50 / 45 / 44 / 12 / 125 / 420 / 6 / 258
  passing, 56 pending, 0 failing, `Done in 5m 1s`. Identical totals to the implement stage, so the
  review-stage edits regressed nothing.
- **Standalone spec runs** (the original failure mode: passes in-suite, dies alone) from
  `packages/db-core` via `node --import ./register.mjs node_modules/mocha/bin/mocha.js
  "test/<name>.spec.ts"` — `btree` 38, `collection` 46, `log` 19, `chain` 31, `diary` 12, `tree`
  25, `collection-type-registry` 11, `network-transactor` 35, `coordinator` 12, plus
  `barrel-import-cycle` 4. All passing.
- **Cross-package scan** under the broadened ancestor-or-self-barrel rule: 11 packages, 0
  violations.
