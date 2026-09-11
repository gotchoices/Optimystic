description: Review the new debugging-guide section that explains how to read log fields which already say which of several very different situations a line describes — written because a misread log nearly led to a false bug report.
files:
  - docs/debugging.md (new `## Reading the fields that tell you which case a line is`, placed just before `## Common DEBUG patterns`; pointer appended to the `coordinator-repo` row of the db-p2p namespace table)
  - tickets/backlog/bug-abandoned-commit-retry-never-releases-its-transaction.md (new, filed from a finding made while verifying `cluster-tx:complete`)
  - packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/libp2p-node-base.ts (read, not changed — the code the doc describes)
----
# Review: document the log fields that say which case a line is

This is a documentation-only change; no source code was touched. The new section in `docs/debugging.md` has one short intro, then one `###` entry per event: `cluster-tx:read-repair-triggered` first (with the GitHub issue #8 worked example and credit to `risavian`), then `pend-cluster-complete`, `commit-stale-classify-own-action`, `commit-local-refusal-tolerated`, `cluster-member:admission-reject`, `cluster-fetch:no-quorum` together with `reconcile:no-rev-quorum`, `cluster-tx:complete`, and `cluster-tx:small-cluster-no-confident-estimate`. The intro links, rather than repeats, the events already documented elsewhere (`commit:solo-cohort`, `cluster-fetch:repair-deadlock`, `local-current`, `claim-unrefutable`, `solo-self-skip`, and `commit:collections`).

## Where the doc deliberately departs from the plan ticket

The plan said to re-verify each claim against the code and document what the code does. These are the places where the code disagreed with the plan. Check each one against the code yourself:

- **"`undefined` drops the key" is false for the stock output.** Verified by running `debug` on Node: `{ ageMs: undefined }` prints as `ageMs: undefined`, with the key present. The key only disappears in a sink that serialises to JSON, which is what `risavian`'s capture harness did (their issue-#8 comment says so). The doc therefore says "`undefined` or missing" throughout, and names the one field that really is left out of the object (`latestRev` on `commit-stale-classify-own-action`).
- **`localRev` is never missing on `read-repair-triggered`.** The line fires only when `isStale`, which requires `!isMissing`, which means `latest` exists. The plan's edge case ("held but has no `latest`") cannot happen, so the doc says the field is always present.
- **`reconcile:no-rev-quorum`'s counts do not map onto three separate fixes.** `noArchive` combines "holds no copy" with "unreachable": `fetchArchiveFromPeer` in `libp2p-node-base.ts` catches every failure, including its own one-second timeout, and returns `undefined`. For the same reason `fetchErrors` is always `0` in production. The doc says this, and points to the read path's `absent`/`silent` split as the way to tell the cases apart.
- **`admission-reject` has six reasons, not four.** `below-floor` and `inconsistent-with-derived-view` (the confident path) were added. On `low-confidence-downsize`, a `confidence` **above** `0.5` also appears: a confident but empty view is treated as no view. So "a number means it was at or below the threshold" was incomplete.
- **`cluster-tx:complete` fires on failure too** (it is in a `finally`). A pending `retry` does not mean "no `transaction-remove` follows": one follows `cluster-tx:retry-finished`. After `cluster-tx:retry-abort`, however, none ever follows. That is a real leak, filed as `bug-abandoned-commit-retry-never-releases-its-transaction` (backlog, `repro: static`), and the doc names that slug. When the bug is fixed, that sentence in the doc needs updating.
- **`pend-cluster-complete`**: the plan's table omitted `true`/`success`, and the doc adds it. `false` can only ever pair with `none`, because the coordinator reads the local verdict only when `localExecuted` is true.
- **Added from the issue thread itself:** the retraction depended on `cluster-fetch:solo-self-skip` lines that no trigger came before. `fetchBlockFromCluster` has one caller (`get`), and for a held block the trigger is always logged first, so a consult with no trigger line is always about a block this node does not hold. The doc teaches that rule alongside `ageMs`.
- **Repeated `ageMs: undefined` is not automatically a defect.** Consults that decline for lack of corroboration (other than `cohort-too-small`) and empty cohort lookups deliberately leave the window unarmed. The doc separates those from the outcomes that do arm it (`solo-self-skip`, `local-current`, `synced`, `not-restored`).

## Check first

- **The `lazy` row for `ageMs` at or below the window.** It must carry both qualifiers: it is a defect only in `lazy` mode *and* only with `readRepairSampleRate` at `0`. The ticket named this as the row most likely to go wrong. A paragraph after the table restates both qualifiers.
- **Absence is described as "never armed OR evicted"**, never as proof that the window was never armed. `lastSeenCommitMs` is an `LruMap(1000)`, and both `get` and `set` refresh recency.

## Validation run

- `yarn lint:docs` passes: 45 documents, 96 anchored citations, 593 file mentions, 338 links. Every new citation is a symbol anchor with a full `packages/...` path, and every doc-to-doc link uses a section anchor (`internals.md#durable-commit-proof-blockcommitproof`, `internals.md#consensus-execution`, `transactions.md#lazy-read-repair-window`, `#which-collections-did-a-write-carry`).
- `packages/db-p2p/test/logger.spec.ts` passes on its own (29 passing), including the two namespace-table guards. The `coordinator-repo` row only had text appended; its first cell is unchanged.

## Known gaps — treat these as a floor

- **The full `yarn workspace @optimystic/db-p2p test` suite was not run.** Only `logger.spec.ts` reads `docs/debugging.md`, and no source changed, but a reviewer who wants belt-and-braces should run it.
- **Nothing pins these field contracts to the doc.** Unlike the quereus-plugin lines, which have spec pins, none of the eight events here have a test asserting their fields or their `undefined`-vs-missing shape. If one of these lines is later edited (a field renamed, a key made conditional), the doc drifts silently. A reviewer could decide that deserves a `debt-` ticket: a small spec per event, capturing the line with `test/support/capture-log.ts`. I did not file one, because the value is arguable for a docs-only change.
- **The two example lines in the fenced block are illustrative**, shaped like the Node `debug` output I observed, not captured from a real run.
- **Wrapping style:** the new section is written one paragraph per line, per the repo's no-hard-wrap rule, while the older parts of `docs/debugging.md` are hard-wrapped at about 100 columns. Rendered output is identical. Running `yarn unwrap:md docs/debugging.md` would make the whole file consistent, but I left the existing text alone to keep the diff focused.
- **The issue-#8 worked example is summarised from the public thread** (`gh issue view 8`). The reporter is deliberately left unnamed; `risavian` is credited, as the ticket asked.
