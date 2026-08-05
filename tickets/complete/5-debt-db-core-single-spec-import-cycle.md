description: Fixed a module load-order bug in db-core that made three test files crash instantly when run alone (they only worked as part of the whole suite), and added a permanent guard so the bug class can't come back.
files: packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/collections/diary/struct.ts, packages/db-core/src/collections/tree/struct.ts, packages/db-core/test/registrar-import-cycle.spec.ts, packages/db-core/test/source-scan.ts, packages/db-core/test/no-fret-import.spec.ts, packages/db-core/src/collection/collection-type-registry.ts, packages/db-core/src/blocks/block-types.ts
----

## What was wrong

Three db-core spec files (`test/collection.spec.ts`, `test/invalidation-client.spec.ts`,
`test/read-view-pinned.spec.ts`) crashed before any test ran when launched standalone:

```
ReferenceError: Cannot access 'collectionTypes' before initialization
```

Root cause: `src/collections/diary/diary.ts`, `src/collections/diary/struct.ts`, and
`src/collections/tree/struct.ts` imported `registerCollectionType`/`registerBlockType`
through the package root barrel (`../../index.js`) instead of directly from the modules that
define them. When a spec's first import happened to reach a subtree the root barrel also
re-exports, the loader's cycle handling skipped the barrel's re-export of that subtree — so the
registry module's `const collectionTypes = new Map()` never ran before a top-level
`registerCollectionType(...)` call touched it (temporal-dead-zone `ReferenceError`). The
confirmed import trace and the six-module comparison table (three modules already importing
directly and never crashing vs. three importing through the barrel) are in the implement-stage
ticket text at commit `d5d55da`.

## What changed

Three import fixes — each swaps a root-barrel import of a registrar function for a direct
import from the defining module:

- `diary.ts`: `registerCollectionType` from `../../collection/collection-type-registry.js`.
- `diary/struct.ts`: `registerBlockType` from `../../blocks/block-types.js`.
- `tree/struct.ts`: both of the above, plus its remaining root-barrel names (`BlockId`,
  `CollectionHeaderBlock`) converted to `import type`, so nothing in that file runtime-imports
  the root barrel anymore.

This works because `collection-type-registry.ts` and `block-types.ts` have zero runtime imports
(only `import type`, which is erased under this repo's `verbatimModuleSyntax: true`). A module
with no runtime imports can never be mid-evaluation when something imports it, so a direct
import always sees its module-scope `Map` already initialized.

Guard test `packages/db-core/test/registrar-import-cycle.spec.ts` asserts (1) no file under
`src/` runtime-imports either registrar from the root barrel, and (2) the two registry modules
have zero runtime imports — the invariant the whole fix rests on. Two further cases run the
same detector over synthetic sources so it cannot rot into a no-op.

Review pass added `packages/db-core/test/source-scan.ts` (shared `tsFiles` walker) and
tightened the guard — see findings below.

## Verification

From `packages/db-core`, re-run after this review pass:

- Three previously-crashing specs standalone: 46 / 4 / 8 passing, no load-order error.
- Full suite `test/**/*.spec.ts`: **1357 passing**, 0 failing.
- `npx tsc --noEmit -p tsconfig.json`: exit 0, no output.
- `npx eslint packages/db-core/src packages/db-core/test` (repo lint is `eslint .`): exit 0, clean.
- Guard sanity check: temporarily reverted `diary/struct.ts` to the root-barrel import — assertion 1
  failed naming the exact file and specifier; restored, green again.

## Review findings

### Checked

Implement diff read first, before the handoff summary. Scrutinized: the three source edits
against the stated TDZ mechanism; the guard spec for detector correctness, false negatives, and
self-test integrity; DRY against the sibling guard `test/no-fret-import.spec.ts`; whether the
fix addresses the class or only the instances; cross-package blast radius; docs. Ran lint, the
full suite, typecheck, standalone specs, and a revert-based guard sanity check.

### Fixed inline (minor)

- **Detector missed two real violation forms.** `IS_ROOT_BARREL` pattern-matched
  `^(\.\./)+index\.js$`, so a file sitting directly in `src/` importing `./index.js` — the root
  barrel's own sibling — was invisible to it, and `export { registerBlockType } from
  "../../index.js"` (a runtime edge, and re-export style is exactly what the handoff flagged as
  the thing that could change) was never parsed. Replaced the pattern match with specifier
  resolution against `src/index.ts`, and widened `IMPORT_RE` to cover `export … from` and the
  `import Foo, { bar } from …` default-prefix form. Both new forms are now in the detector
  self-tests. No violations existed under either form — this closes holes, it did not uncover bugs.
- **Self-tests exercised a copy of the logic, not the logic.** The parse → root-barrel → registrar
  decision was written out three times (once in the real assertion, twice in the self-tests), so
  an edit to the real assertion's loop would not have been covered by the cases meant to protect
  it. Extracted `registrarViolations(text, file)`; all three call sites now run the same function.
- **`tsFiles` duplicated verbatim** between `registrar-import-cycle.spec.ts` and
  `no-fret-import.spec.ts`. The implement ticket asked for the helper to be reused and it was
  copied instead. Extracted to `test/source-scan.ts`; both specs import it. (No shared home
  existed before — `test/` already holds flat non-spec helpers like `test-block-store.ts`, so
  this follows the existing convention.)
- **Stale doc comment**: `IMPORT_RE` was documented as matching "`import`/`export … from`" when
  it only matched `import`. Now accurate, and the comment states *why* clause-level `import type`
  is the only form treated as erased (under `verbatimModuleSyntax`, an inline `import { type X }`
  still emits a runtime module edge — the implementer got this right; it just wasn't written down).

### Filed as new work (major)

- **`backlog/debt-db-core-src-imports-own-root-barrel.md`** — the fix removes the *symptom* for
  the two registries, not the cycle. Ten modules under `packages/db-core/src/` still runtime-import
  the package root barrel (measured; the grep and the file list are in the ticket). Per
  architecture-first, the invariant that retires the class is "no `src/` module runtime-imports its
  own package root barrel", enforced by widening the guard's first assertion from two names to any
  runtime import — that is what the ticket asks for, citing this crash as the evidence. Filed to
  `backlog/` rather than `fix/`: nothing is broken today, and the ticket carries an honest decline
  argument. Board checked first (`grep -rl` over all working stages) — no open ticket claimed any
  of these sites.

### Verified as non-issues

- **Cross-package exposure**: none. `registerBlockType`/`registerCollectionType` are referenced
  nowhere outside `packages/db-core/src` and its tests, so no other package's module graph is
  affected and the db-core-only guard is correctly scoped.
- **Other module-load-time side effects**: swept `src/` for top-level registrar calls — eight sites,
  all in the six modules the implement ticket already tabled. The two registries are the only
  module-scope mutable state reached at load time, so the fix does cover the whole of today's class.
- **Docs**: nothing in `docs/` or `AGENTS.md` documents import/barrel conventions, so no doc went
  stale. The invariant is stated where it is enforced (the guard spec's header comment); making it
  a written repo-wide rule belongs with the backlog ticket above, not here.

### Tripwires

None. The one conditional-looking concern — "a future module-load-time side effect could fall into
the same trap" — is not conditional: the cycle exists in the tree today and ten files participate
in it. That is present-tense structure, so it went to a ticket rather than a `NOTE:`.

### Considered and declined

- **Process-spawn-per-spec guard** (launch `node` once per spec to prove standalone loading).
  The implement ticket already weighed and rejected this as too slow for the unit suite; 78 spawns
  against a suite that currently runs in 12s is not a trade worth making. The source scan catches
  the described class at negligible cost. Not re-litigated.
- **Lazy-initializing the registry maps.** Would hide the TDZ instead of removing the cycle.
  Recorded in the implement ticket as the fallback if a future change ever forces a runtime import
  into either registry module; the new backlog ticket makes that even less likely to be needed.
