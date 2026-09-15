description: A node could report a record it had just written as never created, because it remembered "this record does not exist" for ten seconds. That memory is removed, so every read of a missing record asks the machines responsible for it again, and the log line those reads produce on a one-machine node is limited to once per ten seconds per record.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (memo removed from `get`, `fetchBlockFromCluster`, `pend`, `commit`; rate-limited `cluster-fetch:solo-self-skip` at the solo-self exit; new accepted-tradeoff NOTE above `get`'s consult loop)
  - packages/db-p2p/test/coordinator-repo-absence-write-bypass.spec.ts (the issue #20 reproduction, now the regression gate)
  - packages/db-p2p/test/coordinator-repo-absence-window.spec.ts (`cohort of one` section rewritten; `three-member cohort` section byte-for-byte unchanged)
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts (one case rewritten)
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (one comment)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (gate 4 TIMING comment and printed baselines; ceilings unchanged)
  - packages/db-core/src/transactor/network-transactor.ts (comment above `hasValidResponse`)
  - packages/db-core/src/cluster/structs.ts (three read-repair doc comments back to their pre-memo wording)
  - docs/transactions.md, docs/internals.md, docs/debugging.md
  - tickets/.pre-existing-known.md (reproduction entry removed)
  - tickets/backlog/feat-a-cohort-member-remembers-a-settled-absence.md, tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md
difficulty: medium
----

# What was built

GitHub issue #20: on beta.3 a node wrote a record through a remote coordinator and, 158 ms later, read the collection's header block as "never created" through its own coordinator. The cause, reproduced at unit and mesh level, was the settled-absence memo in `CoordinatorRepo`. When `findCluster` returned only this node, a read of a missing block remembered the absence for `readRepairWindowMs` (10 s). Two kinds of change outlived that memory: writes that reached this node's storage without passing through `CoordinatorRepo.pend/commit` (cohort-member writes via `ClusterRepo`), and a cohort view that grew.

The memo is gone entirely (option (d) in the implement ticket). A block missing locally now consults its cohort on every read, in every read-repair mode, as beta.2 did. Nothing on the wire changed.

## `coordinator-repo.ts`

- Removed the `settledAbsences` map and both its NOTEs, `absenceIsSettled`, `forgetSettledAbsences` and its calls at the top of `pend` and `commit`, the `absenceSettled` field on `fetchBlockFromCluster`'s result at every exit, and in `get` the memo branch, the stamp after the consult (with its in-flight-race NOTE), the `consultStartedAt` capture, and the delete in the catch.
- `get`'s comments now say that an unflagged absent means the cohort was consulted for this read. An **accepted-tradeoff NOTE** above the consult loop records why an absence is never remembered, what a future memo would need (bound to the cohort view it was settled under, and cleared by every writer of local storage), and which spec gates it.
- `fetchBlockFromCluster`'s final-exit NOTE, about a failing acquisition re-fetching on every read, is restored to its pre-memo wording.

## The solo-self log line is rate-limited

This differs from the implement ticket's literal instruction, so review it deliberately.

At the solo-self exit:

```ts
const namedThisWindow = localRev === undefined && (this.ageMs(blockId) ?? Infinity) <= this.readRepairWindowMs;
if (!namedThisWindow) this.log('cluster-fetch:solo-self-skip', { blockId });
...
if (!namedThisWindow) this.markBlocksSeen([blockId]);
```

- **It applies only to a block this node does not hold** (`localRev === undefined`). A held block reaches this exit only when read-repair already chose to consult: the window lapsed, a sample fired, or the mode is `paranoid`. So its line and stamp are unchanged, and the line still pairs one-to-one with `cluster-tx:read-repair-triggered`. If the limit applied to held blocks too, the solo-window spec's "paranoid mode still consults on every read" case (5 lines) would break, along with the capture-reading method in `docs/debugging.md`. The ticket required that spec to stay green apart from one case.
- **For a missing block, the stamp is withheld on in-window re-entries**, not just the line. The ticket said to leave `markBlocksSeen` at that exit untouched and to rate-limit off "the stamp the exit already sets". But that stamp is refreshed on every consult, so a block read more often than once a window would stay fresh forever and never be named again after its first read. That is once per burst, not the ticket's "once per block per window". Withholding the stamp gives true once-per-window, and the new spec case "a block read continuously is named once per window, not once per burst" (26 reads a second apart → 3 lines) pins it.
  - Side effect: a block that later *arrives* locally carries an older stamp, so its first held-block read-repair can come sooner than before. That is the safe direction.
  - The stamp is otherwise inert for a missing block, since `get` asks `shouldReadRepair` only about present blocks. The rewritten solo-window case pins that.
- **Tripwire (NOTE at the site):** the stamp is shared with every exit that marks a block seen. A missing block that another exit stamped inside the window (for example `not-restored` on a multi-peer view, then the view shrinks to self) is not named until that stamp lapses.

# Specs

## `coordinator-repo-absence-write-bypass.spec.ts`

- All cases kept. The `REPRODUCES` prefixes and the fails-at-HEAD header text are removed, and the header now records that seven cases failed at beta.3 and why the file stays.
- `armMemo` is now `probeAlone`.
- Consults are counted by `findCluster` lookups, not log lines, because the line is rate-limited:
  - the member-pend case asserts one lookup on the next read, and **zero** solo lines on that read (one line across the probe and the read, the probe's);
  - the in-flight case asserts one lookup on the next read.

## `coordinator-repo-absence-window.spec.ts`

- The `cohort of one` section's memo cases are gone. In their place:
  - nine reads in one window → nine unflagged absents, 1 + 9 lookups (the proximity lookup is cached), zero callback invocations, one solo line, no read-repair trigger;
  - continuous reads are named once per window;
  - every mode (`off`, `lazy`, `paranoid`) consults on every read;
  - a cohort that grows inside the window is asked on the very next read, and its claim surfaces as `claimed-elsewhere`, which inverts the old accepted tradeoff;
  - a pending-only insert is served as content, unflagged, and consults.
- The 1-node mesh case asserts one solo line across nine reads.
- The `three-member cohort` section is unchanged (checked with `git diff -U0`: no hunk in its line range).
- Harness knobs used only by removed cases are dropped (sample rate and draw, lookup duration, pend/commit answers, `drop`); `callbackCalls` is added.

## `coordinator-repo-solo-read-repair-window.spec.ts`

"A missing block is never suppressed by the held-block stamp": nine in-window reads of a missing block → 1 + 9 lookups, one line, no trigger.

## `cold-apply-cost.spec.ts`

Removing the memo added a fixed **five** cohort lookups per cold schema apply at every scale (54→59, 144→149, 142→147), from repeat reads of blocks that do not exist yet. Gate 4 still passes:

| scale | lookups per object | ceiling |
|---|---|---|
| small | 2.68 | 2.9 (headroom down from about 18% to about 8%) |
| large | 2.22 | 2.6 |
| scaled | 2.23 | small × 1.05 |

The printed `MEASURED` baselines (diagnostic only, not asserted) and the TIMING comment, which credited the memo, are updated. The ceilings were not moved.

# Validation run

- `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter dot` in `packages/db-p2p`: **2708 passing, 50 pending, 0 failing** (54 s). Log: `tickets/.logs/drop-the-settled-absence-memo.db-p2p.test.log`.
- The same command with `--exit` in `packages/quereus-plugin-optimystic`: **800 passing, 13 pending, 0 failing**. Log: `tickets/.logs/drop-the-settled-absence-memo.quereus.test.log`.
- The five directly affected db-p2p specs run together: 81 passing.
- `yarn typecheck` (all workspaces): exit 0.
- `yarn lint:docs`: all 97 anchored citations, 600 file mentions and 340 links resolve.
- `db-core` and `db-p2p` were rebuilt (`clean && build`), because dependent test runs refuse stale `dist`.

# Gaps and things for the reviewer to check

- **The rate-limit deviation above** is a judgement call; the alternatives are the ticket's literal version (once per burst) or a dedicated per-block log stamp (new state).
- **The mesh cases in the bypass spec ran twice in total** (targeted run and full suite), not in a loop. The reproduction stage reported them deterministic, but a short loop would be cheap assurance.
- **`fresh-node-ddl-multi` Scenario B** ran once, inside the full suite; it was not looped.
- **Lookup-counting assertions depend on `isResponsibleForBlock`'s `responsibilityCache`**: 60 s of real time, caching the proximity lookup per block. If that proximity check changes (blocked `writer-and-servers-disagree-on-where-a-block-lives`, option D2(b)), those counts shift by one per block. The specs' harness comments say so.
- **The performance bound was not re-measured**; it comes from the implement ticket: 0.009 ms per solo `findCluster`, and 0.0115 vs 0.0098 ms per missing-block read through `NetworkTransactor` on a 1-node mesh.
- **The in-flight unit case no longer exercises a race**, since there is no stamp. It is kept per the ticket, as "the next read still consults".
- **Mixed versions:** a beta.3 peer keeps its own memo and can still serve a stale absent for one window until it upgrades. Nothing to do here.

# Board edits beyond the ticket's literal list

- `debt-freshness-state-scattered-across-coordinator-repo`: instead of deleting the fourteenth measurement's `settledAbsences` mention (history), a **fifteenth measurement** was appended. It records 2840 lines (2940 at HEAD, `wc -l`), four `LruMap`s, the memo's removal, and the new coupling where `lastSeenCommitMs` rate-limits a log line.
- `feat-a-cohort-member-remembers-a-settled-absence`: the requested cross-reference section was appended. Its `description:` and `files:` were also corrected, because they claimed a one-machine deployment still remembers absences and named symbols that no longer exist.
- `docs/debugging.md` (not listed in the ticket): the issue #8 worked example said `solo-self-skip` "fires for every consult". It now says that was true on that release, and that the line no longer counts consults for a block the node does not hold.
- `coordinator-repo-unavailable.spec.ts` (not listed): one comment still described the memo.

# Use cases the gate pins

- A record created through another coordinator is visible through this node on the next read after this node's view grows, whether the write reached this node as a pending-only member record, reached it not at all, or reached it as pend but not commit.
- `Tree.open` through a node that probed while alone finds a tree created elsewhere 158 ms later (mesh).
- Repeatedly probing a never-created record on a one-machine node asks nobody, answers an unflagged absent each time, and logs one `cluster-fetch:solo-self-skip` per record per 10 s.
