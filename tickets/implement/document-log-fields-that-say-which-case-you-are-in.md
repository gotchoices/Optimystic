description: Several of our debug log lines already carry a field that tells a reader exactly which of several very different situations the line describes, but nothing tells anyone how to read those fields. People have misread our logs because of it, and one outside reporter had to take back a bug report. Write down how to read them.
prereq:
files:
  - docs/debugging.md (new section; link to it from the `coordinator-repo` row of the db-p2p namespace table)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`cluster-tx:read-repair-triggered`, `ageMs()`, `shouldReadRepair`, `lastSeenCommitMs`; `pend-cluster-complete`; `commit-stale-classify-own-action`; `commit-local-refusal-tolerated`, `confirmCommitRivalAgainstLocal`; `cluster-fetch:no-quorum`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`cluster-member:admission-reject`)
  - packages/db-p2p/src/cluster/reconcile-block.ts (`reconcile:no-rev-quorum`, `fetchAnswer`)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`cluster-tx:complete`, `cluster-tx:small-cluster-no-confident-estimate`)
  - docs/transactions.md (read-repair section; `readRepairWindowMs` / `readRepairSampleRate` config table — link to, don't duplicate)
  - docs/internals.md (already explains some of the underlying logic conceptually — link to it)
difficulty: medium
----

# Document the log fields that already say which case a line is describing

This is a documentation-only change. Split out of the plan ticket `logging-cannot-be-turned-on-in-react-native`. Its sibling, `enable-optimystic-logging-on-every-debug-copy`, handles turning logging on. The two edit different sections of `docs/debugging.md` and do not depend on each other.

## Background

GitHub issue #8 (2026-09-10). `kjeib` reported a sub-second read-repair "re-entry loop" on one block on 0.29.0. They inferred it from the gaps between consecutive `cluster-tx:read-repair-triggered` lines, then publicly retracted it after `risavian` pointed out that the line's own `ageMs` field settles the question. The "loop" was many separate reads of one busy block. We nearly filed a ticket to chase it. `risavian` worked out the meaning of `ageMs` by reading our source. Nothing we ship says it.

Gap timing cannot stand in for the field. "Window never armed" and "re-entered while still armed" look the same from the gaps alone. Only the field separates them.

## The model entry: `cluster-tx:read-repair-triggered`

Verified against `coordinator-repo.ts` during planning (`shouldReadRepair`, `ageMs`, `markBlocksSeen`). The reporter's three-row reading is **incomplete**, and the doc must use the corrected version below.

The line fires only for a block that is held locally (`isStale` requires `!isMissing`). It carries `mode` and `ageMs`. `ageMs` is `now - lastSeenCommitMs.get(blockId)`, or `undefined` when there is no stamp, and `undefined` drops the key from the logged object entirely.

| `mode` | `ageMs` | meaning |
|---|---|---|
| `paranoid` | anything | every read consults. `ageMs` tells you nothing about a defect. |
| `lazy` | **absent** | no last-seen stamp for this block. Either the window was never armed, or the stamp was **evicted**: `lastSeenCommitMs` is an LRU capped at 1000 blocks, so a node touching more than 1000 distinct blocks loses stamps. |
| `lazy` | `> readRepairWindowMs` | the window lapsed. This is a healthy, intended re-trigger. |
| `lazy` | `<= readRepairWindowMs` | if `readRepairSampleRate > 0`, this is a random sampled re-check (healthy). If the sample rate is at its default of `0`, it is a **genuine defect**: the block re-entered repair while the window was armed. |

`mode: 'off'` never emits this line. Credit `risavian` (GitHub issue #8) for spotting that the field self-classifies. Use the retracted report as the worked example of why gap timing is not enough.

## Other entries to write

A read-only sweep during planning found these. The findings were static, so **re-verify each one against the code before you document it**. If the code disagrees, document what the code does and drop anything that isn't real. Cite each with a path plus an anchor (symbol name or quoted fragment), never a line number. `yarn lint:docs` enforces that (see AGENTS.md § Documentation citations).

- **`pend-cluster-complete`** (`coordinator-repo.ts`). Read `localExecuted` together with `localVerdict` (`none|success|conflict|fault`):
  - `false`/`none` means it fell back to `storageRepo.pend`, and the next line is `pend-fallback-result`.
  - `true`/`none` means the local verdict is gone (member restart, retention, or TTL) and a success is synthesized, unless a member refusal overrides it.
  - `true`/`conflict` is a genuine retryable loss.
  - `true`/`fault` is a tolerated local divergence, and the next line is `pend-local-fault-tolerated`.
  - A non-empty `cohortRefusals` means another member's refusal overrides a local success.
- **`commit-stale-classify-own-action`**. Is `latestRev` absent or present? Absent means the latest revision is exactly the requested one and carries our action id. Present means the block has moved past it and history shows our action took the requested revision. Both classify `own-durable`.
- **`commit-local-refusal-tolerated`**. `confirmation` is `own-durable` (our own action is at the requested revision; this clears the conflict but does not count the node as a holder) or `unconfirmed` (the helper returned `undefined`: node behind, truncated history, read fault, or missing capability). A confirmed rival never reaches this line.
- **`cluster-member:admission-reject`** (`cluster-repo.ts`). The `reason` values are `self-not-member`, `no-coordinating-block`, `unbound-coordinating-block` (a malformed record, the sender's fault), and `low-confidence-downsize` (this member's own config). On the last one, a missing `confidence` means no view could be derived. A number means the view was at or below the threshold.
- **`reconcile:no-rev-quorum`** (`reconcile-block.ts`). `behind`, `noArchive` and `fetchErrors` each call for a different fix: wait for convergence, add a copy, or fix reachability.
- **`cluster-fetch:no-quorum`**. `holders`, `absent` and `silent` are read against `cohortPeers`/`required`. "1 of 2 responded" and "1 holder plus 1 confirmed non-holder" call for different operator actions, and the code comment at the site already says so.
- **`cluster-tx:complete`** (`cluster-coordinator.ts`). If `retry` is absent, no retry is pending and a `transaction-remove` line follows. If it is present, a commit retry is still chasing peers and no `transaction-remove` follows. A missing `finalPromises`/`finalCommits` means the entry was already gone.
- **`cluster-tx:small-cluster-no-confident-estimate`**. `admit: true` means it was admitted only through the `allowUnvalidatedSmallCluster` opt-in. `false` is a fail-closed rejection.

These are already well documented, so **do not** repeat them. Link to them from the new section's intro if it helps: `commit:solo-cohort`, `cluster-fetch:repair-deadlock`, `cluster-fetch:local-current`, `cluster-fetch:claim-unrefutable`, `cluster-fetch:solo-self-skip`, and the quereus-plugin `commit:collections` fields.

## Shape of the doc change

- A new `##` section in `docs/debugging.md`, placed before "Common DEBUG patterns", titled in plain words (e.g. "Reading fields that tell you which case a line is"). Give it one short intro paragraph: some lines carry a field whose value, or whose absence, already names the situation, so read it before reasoning from timing. After that, one `###` per event with a table or a short list. `read-repair-triggered` comes first.
- State plainly that an **absent** key in a logged object is meaningful. The logged object comes from the payload, and `undefined` properties do not print. Readers grepping for `ageMs=` or `ageMs:` will otherwise take "absent" as a logging glitch.
- In the `coordinator-repo` row of the db-p2p namespace table, add a pointer to the new section.
- Keep the config explanation in `docs/transactions.md` and link to it rather than restating window semantics.

## Edge cases & interactions

- **The sampling and paranoid qualifiers are the whole point.** A table that says "`ageMs <= window` = defect" without the `mode` and `readRepairSampleRate` conditions reproduces the misreading this ticket exists to prevent. The reviewer should check that row first.
- **LRU eviction is a second reason for a missing `ageMs`.** Do not describe absence as proof that the window was never armed.
- **`localRev` can also be missing** on `read-repair-triggered` (the block is held but has no `latest`). Say so briefly, and don't read anything into it for the `ageMs` table.
- **Doc-citation lint.** Every new path citation needs an anchor that actually exists in the file. Run `yarn lint:docs`.
- **`packages/db-p2p/test/logger.spec.ts`** checks the db-p2p namespace table against the code. Editing a row's description is fine, but don't rename or remove a namespace cell.
- Adjacent, **not in scope**: `tickets/backlog/bug-cohort-topic-debug-namespaces-are-documented-but-not-emitted.md` covers the cohort-topic table in the same file. Don't fold it in.

## TODO

- Re-verify each listed event and field against the code (the `read-repair-triggered` reading above is already verified).
- Write the new section in `docs/debugging.md`, `read-repair-triggered` first, with the corrected table, the credit, and the retracted-report worked example.
- Add the pointer from the `coordinator-repo` namespace row.
- Run `yarn lint:docs`, plus `yarn workspace @optimystic/db-p2p test` if you touched the namespace table.
