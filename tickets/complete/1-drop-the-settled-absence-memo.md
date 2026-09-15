description: A node could report a record it had just written as never created, because it remembered "this record does not exist" for ten seconds. That memory is removed, so every read of a missing record asks the machines responsible for it again, and the log line those reads produce on a one-machine node is limited to once per ten seconds per record.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (memo removed from `get`, `fetchBlockFromCluster`, `pend`, `commit`; rate-limited `cluster-fetch:solo-self-skip` at the solo-self exit via `soloAbsenceNamedThisWindow`; accepted-tradeoff NOTE above `get`'s consult loop)
  - packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts (the issue #20 reproduction, now the regression gate)
  - packages/db-p2p/test/coordinator-repo-absence-window.spec.ts
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-core/src/cluster/structs.ts
  - docs/transactions.md, docs/internals.md, docs/debugging.md
  - tickets/backlog/feat-a-cohort-member-remembers-a-settled-absence.md, tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md
----

# What was built

GitHub issue #20: on beta.3 a node wrote a record through a remote coordinator, then 158 ms later read the collection's header block as "never created" through its own coordinator. The cause was the settled-absence memo in `CoordinatorRepo`. When `findCluster` returned only this node, a read of a missing block remembered the absence for `readRepairWindowMs` (10 s). Two kinds of change outlived that memory:
- writes that reached this node's storage without passing through `CoordinatorRepo.pend/commit`, such as cohort-member writes through `ClusterRepo`;
- a cohort view that grew after the absence was remembered.

The memo is removed entirely. A block missing locally now consults its cohort on every read, in every read-repair mode, as it did on beta.2. Nothing on the wire changed.

- `coordinator-repo.ts` changes:
  - Removed `settledAbsences`, `absenceIsSettled`, `forgetSettledAbsences`, and the `absenceSettled` result field.
  - An accepted-tradeoff `NOTE:` above `get`'s consult loop says why no absence is remembered, what a future memo would need (bound to the cohort view it was settled under, and cleared by every writer of local storage), and which spec is its gate.
- **Solo-self log line rate limit.**
  - For a block this node does **not** hold, `cluster-fetch:solo-self-skip` and the read-repair stamp that exit sets are both skipped while the stamp is at most one window old. The result is once per block per window, and the "continuous reads" spec case pins it.
  - A held block reaches that exit only when read-repair already chose to consult. It still logs and stamps every time, so its line keeps pairing with `cluster-tx:read-repair-triggered`.
- **Specs.** The bypass spec's `REPRODUCES` cases now pass and stay as the gate. The `cohort of one` section of the absence-window spec was rewritten: every read consults, the log line appears once per window, all modes consult, a grown cohort is asked on the next read, and pending-only content is served. The three-member section is unchanged.
- **Cost.** A cold schema apply makes a fixed five extra cohort lookups at every scale. Gate 4 in `cold-apply-cost.spec.ts` still passes: 2.68 lookups per object against a 2.9 ceiling at small scale, and 2.22 against 2.6 at large. The ceilings were not moved.
- **Docs and comments.** `docs/transactions.md`, `docs/internals.md` and `docs/debugging.md`, the knob doc comments in `structs.ts`, and the `NetworkTransactor.get` comment now describe the no-memo behaviour.

# Review findings

## Checked and found correct

- **Diff read first** (`git show b3db565a`): every memo site is gone.
  - `grep settledAbsence|absenceSettled|absenceIsSettled|forgetSettledAbsences` over `packages/` finds nothing.
  - Every `fetchBlockFromCluster` exit returns `{ absence, currency }`.
  - `get`'s catch no longer touches memo state.
  - `pend` and `commit` start at `verifyResponsibility` again.
- **The rate-limit deviation from the implement ticket is accepted.** The ticket's literal version rate-limited off a stamp refreshed on every consult. A block read more often than once per window would then be named once per burst and never again. Withholding the stamp together with the line gives true once-per-window.
  - The pairing is actually tighter than before: every `solo-self-skip` line now implies a stamp. `docs/debugging.md` relies on that when it lists `solo-self-skip` among the "outcomes that stamp".
  - The held-block path is unchanged. The spec case "paranoid mode still consults on every read" still asserts 5 lines for 5 reads.
- **Side effect of withholding the stamp:** a block that arrives locally after a solo probe carries an older stamp, so its first held-block read-repair can only come sooner. That is the safe direction.
  - The remaining cost is pre-existing and already documented in the arming NOTE at the solo exit and in `docs/transactions.md` § Lazy read-repair window: a missing block stamped under a self-only view, then delivered at an old revision by a member commit, is served without a consult for the rest of that window.
  - This change only narrows that cost, so no action.
- **Stamp readers:** `lastSeenCommitMs` is read only by `shouldReadRepair` (present blocks only), `ageMs` (the trigger log line and the new helper), and the test seam. So withholding the stamp for a missing block cannot suppress a consult.
- **Docs:** read `docs/transactions.md` § Lazy read-repair window and its knob table, `docs/internals.md` (the unflagged-absent rows and the solo-cohort paragraph), and `docs/debugging.md` (the `read-repair-triggered` entry and the issue #8 worked example). All match the new behaviour.
  - `packages/quereus-plugin-optimystic/README.md` mentions only held-block staleness, which is unaffected.
  - `tickets/.garden-report.md` is a dated log and was left as history.
- **Board:** the `feat-a-cohort-member-remembers-a-settled-absence` backlog ticket has an honest update section, and its Background stays as history. `tickets/.pre-existing-known.md` no longer lists the reproduction.

## Fixed in this pass (minor)

- **Source hygiene.** The solo-self exit carried a 14-line comment block for a one-line decision, on top of an already long arming comment. The decision now lives in a named helper, `CoordinatorRepo.soloAbsenceNamedThisWindow(blockId, localRev)`, whose doc comment holds the rationale and the shared-stamp tripwire. The exit keeps a two-line pointer. Behaviour is unchanged.
- **Debt ticket measurement.** `debt-freshness-state-scattered-across-coordinator-repo`'s fifteenth measurement now records the post-review size (`wc -l packages/db-p2p/src/repo/coordinator-repo.ts` → **2851**) and names the helper as the site of the new coupling.

## Tripwires (recorded, not ticketed)

- **Shared stamp.** The stamp is shared with every other exit that marks a block seen, so a missing block stamped by another exit inside the window is not named until that stamp lapses. Parked as a `NOTE:` on `soloAbsenceNamedThisWindow`, written by implement and moved there in review.
- **Gate 4 headroom.** Small-scale headroom in `cold-apply-cost.spec.ts` is down to about 8% (2.68 against 2.9). If more re-reads of not-yet-existing blocks join the apply path, gate 4 trips at small scale first. The spec's TIMING comment already names the removed memo as the source of the five extra lookups, so nothing further was added.
- **`findCluster` lookup counts.** The lookup-count assertions in the absence specs assume `isResponsibleForBlock` caches its proximity lookup, via the 60 s `responsibilityCache`. If blocked `writer-and-servers-disagree-on-where-a-block-lives` option D2(b) changes that check, those counts shift by one per block. The spec harness comments already say so.

## Considered and declined

- **Clock stepping backwards.** A wall clock that steps backwards makes `ageMs` negative, which suppresses the diagnostic line until the clock catches up. `shouldReadRepair` has the identical property for held blocks. The effect is one missing log line and never a skipped consult, so it gets no ticket and no NOTE.
- **A spec for the arrival side effect** (a block arriving after a solo probe read-repairs sooner). Not added: it is safe-direction behaviour with no correctness consequence to guard, and pinning it would freeze an incidental detail.
- **Mixed versions.** A beta.3 peer keeps its own memo until it upgrades. Nothing in this repo can change that.

## Major findings

None, so no new tickets. The architectural class behind issue #20 (a per-node memo that no write path can invalidate) is already owned by `feat-a-cohort-member-remembers-a-settled-absence` and `debt-freshness-state-scattered-across-coordinator-repo`. The accepted-tradeoff NOTE in `get` points any future memo at `coordinator-repo-absence-write-bypass.spec.ts` as its gate.

## Validation (after the review edit)

- `yarn eslint` on every file the change touched: exit 0.
- `yarn typecheck` in `packages/db-p2p`: exit 0.
- `packages/db-p2p` rebuilt (`yarn clean && yarn build`).
- The four affected `db-p2p` specs run five times in a row, 71 passing each time, including the three mesh cases in the bypass spec.
- `fresh-node-ddl-multi.spec.ts` (Scenario B, the multi-peer memo's historical failure) run 20 times in a row: 20 passed.
- Full `db-p2p` suite (`node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter dot`): **2708 passing, 50 pending, 0 failing**.
- Full `quereus-plugin-optimystic` suite (same command with `--exit`): **800 passing, 13 pending, 0 failing**.
- `yarn lint:docs`: 97 anchored citations, 600 file mentions and 340 links all resolve.
- No pre-existing failures surfaced.
