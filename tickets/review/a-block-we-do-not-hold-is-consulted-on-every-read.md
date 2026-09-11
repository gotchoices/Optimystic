description: A node asked for a record it does not have used to ask the rest of the network on every single read, with no limit, even on a one-machine deployment. It now remembers a confirmed "does not exist" answer for the same short freshness window a record it does hold already gets, so repeated checks for a not-yet-created record cost one network lookup per window instead of one per read.
prereq:
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (`settledAbsences` field, `absenceIsSettled`, `forgetSettledAbsences`, `get`'s per-block decision, `fetchBlockFromCluster`'s `absenceSettled` at every exit, `pend`/`commit` clearing)
  - packages/db-core/src/transactor/network-transactor.ts (comment only: what an unflagged absent now guarantees)
  - packages/db-p2p/test/coordinator-repo-absence-window.spec.ts (new, 25 cases)
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (pinned "missing block consults every read" spec flipped from 9 to 1)
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (one comment line on the swallowing-callback spec)
  - tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md (fourteenth measurement appended)
----

# A block this node does not hold gets a freshness window too

## What changed

`CoordinatorRepo.get` consults a block's cohort (the machines responsible for it) for two reasons: the block is missing locally, or it is held but may be stale. The second has been limited to one consult per `readRepairWindowMs` (10 s default) for a long time. The first had no limit, so a caller that checks for a record not yet created paid a full consult on every check. The largest field producer is GitHub issue #8: control-plane code reads an empty `Revocation` collection before every membership lookup and every insert.

The fix: a missing block skips its consult when an earlier consult, within the last window, **settled** its absence. That means the consult reached every cohort member it could ask, none of them claims the block, and it rested on a real cohort view. That is the same guarantee a held block's window gives for content ("checked with the cohort within one window"), and nothing weaker is ever served as authoritative.

- **New state:** `settledAbsences`, an `LruMap<string, number>(1000)` holding when an absence was last settled. It is deliberately **not** `lastSeenCommitMs`, which is also stamped for missing blocks whose absence is *not* confirmed (the `cohort-too-small` arm with a claim, the post-restore arm when acquisition failed). Reading that map would have served `claimed-elsewhere` absences as authoritative.
- **Required verdict field:** `fetchBlockFromCluster` now returns `{ absence, currency, absenceSettled }`. Each exit states its side:
  - no callback → `false`;
  - empty cohort → `false`;
  - solo-self → `true`;
  - `!corroborated` → `absence === 'confirmed'` (no claim and no silence);
  - `local-current` → `silenceVerdict === 'confirmed'` (never read);
  - post-restore → `false`.
- **In `get`:**
  - A present block deletes its memo.
  - A missing block whose memo is fresh (`absenceIsSettled`) skips the consult and serves the local entry as-is, with no flag and no log line.
  - After a consult of a missing block, the memo is stamped only if the block is still missing, `absence === 'confirmed'`, and `absenceSettled`. Otherwise it is **deleted**, including in the catch arm. This matters after a sampled or paranoid re-consult of a block whose memo was still fresh.
- **Modes:**
  - `paranoid` never skips.
  - `lazy` uses the window and the sample rate, mirroring `shouldReadRepair`.
  - `off` also uses the window, as a deliberate behaviour change. Before, an `off` node consulted on every missing read; leaving it unbounded would make the do-less mode do more. This is stated in `absenceIsSettled`'s doc comment.
- **Clearing on local writes:** `pend` and `commit` call `forgetSettledAbsences` as their first action. That is before `verifyResponsibility`, before routing, and whatever the outcome, so a refused, throwing or not-responsible write also clears.
- **Accepted-tradeoff `NOTE:`** on the `settledAbsences` declaration. A block created by a writer whose commit did not involve this node reads as absent for up to one window after this node settled its absence. Revisit if a caller needs tighter cross-coordinator create-visibility; the answer then is a revision floor (`feat-refresh-can-demand-a-revision-floor`), not a shorter window.
- **Comments updated:**
  - `get`'s trigger list and its NetworkTransactor coupling NOTE: an unflagged absent now means "confirmed within the last window".
  - The empty-cohort NOTE: it also returns `absenceSettled: false`.
  - The solo exit: its `lastSeenCommitMs` stamp is not what suppresses a missing block.
  - The post-restore NOTE: a failed acquisition is `claimed`, never settles, and still re-fetches every read.
  - `network-transactor.ts`: the same one-sentence correction.

## Measurements

Consults are counted by `cluster-fetch:solo-self-skip` lines on a cohort of one, and by callback invocations addressed to self on multi-peer cohorts. All reads fall inside one window.

| case | before (code before this change) | after |
|---|---|---|
| solo, 9 reads of a never-written block | **9** | **1** |
| 3-member cohort, all answer "nothing", 9 reads | 9 | 1 |
| `off` mode, solo, 9 reads | 9 | 1 |
| 1-node mesh through the real `NetworkTransactor`, 9 reads | 9 | 1 |

The before-numbers were measured by running the new spec against the unchanged code. The solo gate was written and run before `get` was touched.

## Validation run

- `packages/db-p2p`: `yarn test` → **2678 passing, 50 pending, 0 failing**.
- `packages/db-core`: `test/network-transactor.spec.ts` + `test/transactor-source.spec.ts` → 76 passing. db-core was rebuilt, because the comment edit made the stale-build guard refuse to run db-p2p's tests.
- `yarn workspace @optimystic/db-p2p build` and `tsc --noEmit` both clean.
- `quereus-plugin-optimystic/test/cold-apply-cost.spec.ts` against the new build: 7 passing, every figure at its baseline. That was expected, because its gate 4 does not see coordinator-side `findCluster` calls.

## Use cases the new spec pins (`coordinator-repo-absence-window.spec.ts`)

- **Cohort of one:**
  - the 9-reads gate (every answer an unflagged `{ state: {} }`, no `read-repair-triggered` line);
  - the window lapse re-consults;
  - paranoid consults every read;
  - `off` is windowed;
  - a sample-rate draw below the rate consults inside the window;
  - pend success, refusal and throw each clear the memo, and so do commit success and refusal;
  - a block turning up locally deletes the memo: vanish again inside the *original* window and the read consults, which proves the delete rather than the timestamp retired it;
  - a cohort that grows inside a settled window is not asked until the lapse, then is;
  - a pending-only insert inside a settled window is served as content, unflagged, with no consult;
  - `skipClusterFetch` never consults and never stamps.
- **Three-member cohort:**
  - all-"nothing" settles for one window;
  - never settle, with every read consulting and flagged:
    - partial silence → `peers-unreachable`;
    - total silence → `cohort-unreachable`;
    - a lone uncorroborated claim → `claimed-elsewhere`;
    - a corroborated claim that can't be acquired → `claimed-elsewhere`;
    - a thrown consult → `peers-unreachable`;
  - an empty cohort never settles (each read repeats its lookup);
  - settled then unsettled, two variants:
    - after the lapse, an unconfirmed consult stamps nothing;
    - on a sampled re-consult with the memo still fresh, the unconfirmed consult **deletes** it;
  - a creation elsewhere inside the window reads as absent (the accepted tradeoff, pinned out loud), then after the lapse is consulted and restored;
  - multi-block `get`: only the unsettled-absent block consults.
- **Mesh:** a 1-node mesh through `buildNetworkTransactor`, 9 reads → 1 `solo-self-skip`.

## Known gaps — reviewer, please weigh these

- **Race between an in-flight consult and a local write (not tested, not fixed).** A read's consult starts, then a local `pend`/`commit` of the same block clears the memo, and the consult then returns a settled absence and stamps it again. The re-stamped memo is served for up to one window. The harm case needs the pend to be refused *because the block exists* while the concurrently consulted cohort answered "nothing", which means an inconsistent cohort. I judged it a tripwire-level concern and did not add a per-block generation counter to close it. If the reviewer disagrees, the cheap fix is to capture a per-block "cleared at" time and skip the stamp when a clear landed after the consult started.
- **The stamp time is the consult's end, not its start.** The stamp uses `this.now()` after the consult returns, so a slow consult (up to the 1 s per-peer deadline) extends the window by up to that long. It is negligible against 10 s, but it is not exactly "within one window of the evidence".
- **The idle reconcile loop is not measured.** The ticket expects the downstream ~15 s reconcile pass to still pay one consult per absent block per pass, because 15 s is longer than the 10 s window. That comes from the interval arithmetic; I did not measure it. On a solo node the remaining per-consult cost is `findCluster`, which belongs to `plan/a-solo-node-recomputes-a-constant-answer-and-our-gate-cannot-see-it`.
- **Soft-served (non-responsible) blocks:** the memo applies to them. No dedicated test was added, per the ticket; the existing proximity specs stay green.
- **The ticket said "sixth" per-block map; it is the fifth.** Counted with `grep "new LruMap" coordinator-repo.ts`. The backlog measurement says five.

## For the human (outward-facing — not posted by the agent)

Consider replying on GitHub issue #8:

- `kjeib`'s statistic (254 `default/Revocation` consults, none preceded by a read-repair trigger) is what identified the missing-block path.
- `risavian`'s "`default/Revocation` may not be empty here" was the right control.
- The empty-collection behaviour was a real defect, though not the mechanism either of them proposed.
- This change bounds the consult rate for absent reads to one per window per block. It does not by itself fix any non-convergence they are seeing.
