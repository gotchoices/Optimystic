description: Review doc-only correction of architecture.md overstatement (reactivity/matchmaking reframed design-only) + new Doc Sync Status table.
prereq:
files: docs/architecture.md
effort: low
----

## What changed

Doc-only edit to `docs/architecture.md` §"Cohort Topics, Reactivity, and Matchmaking" (~L233+).

The false claim **"Two applications run on the substrate today:"** was removed. The section now:

1. States the cohort-topic substrate, reactivity, and matchmaking are **specified / design-only with zero implementation today**, and that a **simulator phase validates the design's quantitative claims before the core protocols land**, with forward links to cohort-topic.md / reactivity.md / matchmaking.md.
2. Reframes the reactivity and matchmaking bullets as **designed** behavior ("designed to fan out…", "Designed for…") rather than running behavior.
3. Adds a clarifying paragraph that what exists in code is the **single-node, in-process** `IBlockChangeNotifier` primitive (`change-notifier.ts` / `storage-repo.ts` / `network-transactor.ts` + Quereus bridge), reaching only same-process listeners, and that the networked push-tree is built **on top of** it (bridge = separate ticket `local-change-notifier-bridge`).
4. Adds a new `### Implementation / Doc Sync Status` subsection with a per-subsystem table (cohort-topic substrate, reactivity, matchmaking) — all cells `pending` across Simulator validation / Mock-tier e2e / Real-libp2p e2e — plus a note that later tickets (`*-core-module-fret-integration`, `*-e2e-mock-tier`, `substrate-e2e-real-libp2p-tier`) flip cells to `done`.

## Review focus / validation

- Confirm `docs/architecture.md` no longer asserts any of the three subsystems are implemented/running. Grep for residual "run on the substrate today" / "fan out through" present-tense phrasing.
- Confirm the Doc Sync Status table has all-`pending` rows for the three subsystems and renders as valid Markdown.
- Confirm forward links resolve to existing files: `docs/cohort-topic.md`, `docs/reactivity.md`, `docs/matchmaking.md` (all referenced; verify they exist).
- Verify the local-primitive paragraph's file paths/symbols match the codebase: `IBlockChangeNotifier`, `CollectionChangeEvent`, `packages/db-core/src/transactor/change-notifier.ts`, `packages/db-p2p/src/storage/storage-repo.ts`, `network-transactor.ts`'s `localChangeNotifier`.

## Known gaps / honesty notes

- Doc-only change; no build/test run (no code touched). `yarn build` remains unaffected.
- I did not re-verify the design-only claim by re-grepping all wire types (`RegisterV1`, etc.) — relied on the ticket's prior verification (2026-06-02). A reviewer may want to re-run that grep to confirm zero matches still holds.
- The ticket's out-of-scope items (partition-healing Document-Map fix via `audit-partition-healing-doc-links`; any source code) were left untouched.

## Done when (met)
- Overstatement removed ✓
- Doc Sync Status table present, all-pending ✓
- Doc-only, no build/test impact ✓
