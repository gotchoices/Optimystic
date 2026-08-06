----
description: Ten files inside the db-core package used to import from the package's own top-level export file, which made the modules load in a circle; they now import directly from the modules that define what they need, and a test keeps it that way.
files: packages/db-core/src/chain/chain.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/collections/diary/diary.ts, packages/db-core/src/collections/tree/collection-trunk.ts, packages/db-core/src/log/log.ts, packages/db-core/src/testing/test-transactor.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transform/cache-source.ts, packages/db-core/src/transform/tracker.ts, packages/db-core/test/root-barrel-import-cycle.spec.ts, packages/db-core/test/source-scan.ts, docs/internals.md
difficulty: medium
----

## What changed

**1. Ten runtime imports of `packages/db-core/src/index.ts` re-pointed at defining modules.**

`src/index.ts` re-exports everything under `src/`. Ten modules *inside* `src/` imported from it,
so each depended on the file that depended on it — Node evaluated the group as a cycle, and entry
order decided which parts were half-built. Each import was re-pointed at the module that actually
defines the symbol:

| File | Was | Now |
|---|---|---|
| `chain/chain.ts` | `Atomic` + 3 types from `../index.js` | `Atomic` from `../transform/atomic.js`; types stay type-only on `../index.js` |
| `collection/collection.ts` | 7 names from `../index.js` | split across `../log/log.js`, `../transform/{atomic,tracker,cache-source,helpers}.js`, `../transactor/transactor-source.js` |
| `collections/diary/diary.ts` | `Collection` | `../../collection/collection.js` |
| `collections/tree/collection-trunk.ts` | `apply, get` | `../../blocks/helpers.js` |
| `log/log.ts` | `Chain, entryAt` | `../chain/chain.js` |
| `testing/test-transactor.ts` | 16 inline-`type` names + `ensuredMap`, `Latches` | clause-level `import type` for the 16; `../utility/ensured.js`, `../utility/latches.js` for the two runtime names |
| `transaction/coordinator.ts` | `Log, blockIdsForTransforms` | `../log/log.js`, `../transform/helpers.js` |
| `transactor/network-transactor.ts` | 10 names | `../transform/helpers.js`, `../transform/{tracker,cache-source}.js`, `./transactor-source.js`, `../log/log.js`, `../utility/groupby.js` |
| `transform/cache-source.ts` | `applyOperation` | `./helpers.js` |
| `transform/tracker.ts` | 5 names | `./helpers.js`, `../utility/ensured.js` |

None of the ten turned out to be an awkward-to-reach case; every symbol had an unambiguous defining
module, so no layering problem surfaced. **Clause-level type-only imports of `../index.js` were
deliberately left alone** — 27 of them remain, and with `verbatimModuleSyntax` (`tsconfig.base.json`)
they are erased whole and create no runtime edge. This is the ticket's stated position
("Type-only imports are fine either way"), not an oversight; it is also the main judgment call a
reviewer might want to revisit.

**2. Guard spec broadened and renamed.**
`test/registrar-import-cycle.spec.ts` → `test/root-barrel-import-cycle.spec.ts`. The old first
assertion was scoped to two names (`registerBlockType`, `registerCollectionType`); it now asserts
*no runtime import of the root barrel at all* from anywhere under `src/`. The detector was also
widened from "named-binding import clauses only" to every static module edge: named, default,
namespace (`import * as`), star re-export (`export * from`), and bare side-effect (`import '...'`).
Second assertion (registry modules have zero runtime imports) kept, now using the wider detector.
`test/source-scan.ts`'s doc comment updated for the rename.

**3. `docs/internals.md`** gained "Common Pitfalls → 6. Importing a Package's Own Root Barrel from
Inside It", with the symptom, the fix, the `verbatimModuleSyntax` exemption, and a `NOTE:` tripwire
that the guard covers only db-core.

## Validation performed

All from `packages/db-core` unless noted.

- `yarn build` (db-core) — clean. `yarn build` (repo root, all 11 packages) — clean.
- `yarn test` (db-core) — **1357 passing**.
- `yarn test` (repo root, all packages) — green; totals 1357 / 1540 / 53 / 50 / 45 / 44 / 12 / 125 / 420 / 6 / 258, 56 pending, `Done in 5m 6s`.
- `yarn lint` (repo root) — clean.
- **Standalone-spec runs** (the failure mode the original bug produced — passes in-suite, dies alone):
  each of `root-barrel-import-cycle`, `diary`, `tree`, `collection-type-registry`, `collection`,
  `log`, `chain`, `network-transactor`, `transactor-source`, `coordinator`, `simulation` run alone
  via `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/<name>.spec.ts"` — all pass.
- **Guard proven to fire end-to-end**, not just on synthetic strings: wrote
  `src/blocks/__probe.ts` containing `import { apply } from "../index.js";`, ran the guard spec →
  `1 failing`, message named the probe file and the exact statement. Probe deleted.
- **Cross-package sweep** (the ticket's "worth checking the other packages" note): ran a
  resolve-based scan of every `packages/*/src` for runtime imports of that package's own
  `src/index.ts`, counting named / default / namespace / star-re-export / side-effect forms and
  excluding clause-level `import type`. **All 11 packages: 0.** No follow-up ticket filed; the
  tripwire in `docs/internals.md` records what to do if that changes.

## Known gaps / where to push

- **Test floor, not ceiling.** The only *new* test is the broadened guard spec, which is a
  source-text scan — it proves the shape is gone, not that behavior is unchanged. The behavioral
  evidence is the pre-existing 1357-test db-core suite plus the standalone runs above. There is no
  test that would catch a *wrong* re-point (importing the right name from the wrong module) beyond
  what tsc and the existing suite already catch.
- **The detector is a regex, not a parser.** `moduleEdges()` in the guard spec uses two regexes
  anchored at statement start. Self-tests cover the forms above plus the negatives (type-only,
  subtree barrels, bare specifiers, dynamic `import()`, a specifier inside a string literal), but
  an adversarial reviewer should try to construct a real TS import form that slips past —
  e.g. unusual whitespace, or a comment interleaved in the clause (`import /* x */ { a } from …`),
  which is *not* covered by a self-test.
  AGENTS.md forbids a "half-baked janky parser"; the counter-argument here is that this is a
  detector over a closed set of statement shapes with negative self-tests, not a parser feeding
  downstream logic — worth a second opinion.
- **Dynamic `import()` is deliberately not flagged.** Reasoning: lazily evaluated, so it cannot
  participate in module-initialization order. Recorded as an "allowed" self-test with that comment.
  If a reviewer disagrees, that is a one-line policy change.
- **27 clause-level `import type ... from "../index.js"` remain under `src/`.** Correct under
  `verbatimModuleSyntax` and blessed by the ticket, but it means the *textual* dependency on the
  root barrel is still widespread; anyone who flips a compiler option here would resurrect the
  cycle wholesale. Not defended by any test.
- **Pre-existing, not mine:** `packages/db-core/src/transactor/network-transactor.ts:687` —
  `commitBlock(blockId, blockIds, ...)` never reads `blockIds`. The editor flags it (TS 6133);
  `tsc` and eslint both pass, so nothing gates on it. Verified identical at HEAD
  (`git show HEAD:...` — same signature, same line), so it predates this ticket. Left alone;
  AGENTS.md would want it `_blockIds` or removed.
