description: A write could be reported as saved when only its log record was stored and the table data it changed never was, so the row was silently lost on every machine. The writer's retry now finishes the half-stored write before reporting it saved, and refuses with a named error when it cannot.
files:
  - packages/db-core/src/collection/collection.ts (`completeOwnEntry`, `tornFromRefusal`, `retainInFlightAttempt`, `InFlightAttempt`, `inFlightAttempt`; changes in `updateInternal`, `syncAttempts`, `beginInFlightAction`, `consumeOwnEntry` doc)
  - packages/db-core/src/collection/struct.ts (`TornActionError`, `TornActionReason`)
  - packages/db-core/src/transaction/coordinator.ts (`commit` retry loop; `commitOnceLatched` retains failed attempts)
  - packages/db-core/src/testing/test-transactor.ts (`TailLandsButReportsStale` added; `TestTransactor.pend`/`.commit` now mirror the real own-revision handling; `CommitLandsButReportsStale` doc corrected)
  - packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/repo/coordinator-repo.ts (NOTE comments only)
  - packages/db-core/test/own-entry-completes-the-action.spec.ts (new), packages/db-core/test/collection-own-action-replay.spec.ts, packages/db-core/test/coordinator-own-action-replay.spec.ts
  - packages/db-p2p/test/half-landed-write-is-finished.spec.ts (new, real 3-node mesh)
  - docs/internals.md, docs/correctness.md, packages/db-core/docs/collections.md
difficulty: hard
----

# What was wrong

A write touches its collection's **log tail** (the block recording "action X at revision N changed these blocks") and its **data blocks**. `NetworkTransactor.commit` commits the tail first and sweeps the rest only if the tail answered success. A failed tail answer does not mean the tail is absent: the durability gate answers `commit-not-durable` when fewer than a majority hold the revision, even though some members stored it. The writer then cancelled (dropping the data blocks' pending records everywhere), refreshed, found its own log entry, and treated that as proof the write was saved. `sync()` returned success, the revision advanced, and every data block stayed at its old revision on every node.

# The rule now enforced

**A sync or a transaction commit reports success only if every block the action's log entry names holds that action's revision. Finding the entry proves only that the tail landed.**

# How

- Every failed attempt is retained verbatim on the collection (`retainInFlightAttempt`: transforms, revision, tail id, block digests), tied to the in-flight action mark and cleared with it.
- When a refresh finds the write's own entry, `completeOwnEntry` re-sends that retained attempt at the **same action id and revision** before the entry is consumed. The storage tiers already treat a block holding exactly that action at exactly that revision as satisfied (`isOwnRevision`), so the re-send lands precisely the missing blocks and is a no-op for the rest. It runs before `updateInternal` changes anything, so any throw leaves staged actions, tracker and revision untouched.
- The re-send's `WriteDurability` is what `sync()` reports. Before, this path returned `undefined`, which is the documented answer for "nothing was written".
- When finishing fails, `TornActionError` (collection, action id, revision, blocks, `reason`): `rival-holds-revision` (permanent; the refusal confirmed a committed revision under another action via `staleAt` or non-empty `missing`), `completion-refused` (can clear; both write paths retry **the refresh, never a new attempt**, against the existing attempt budget and deadline, and rethrow it when that runs out), `transforms-not-held` (own entry found with blocks missing and no retained attempt at its revision).
- It is never re-driven at a new revision, and the staged actions are left in place.
- `TransactionCoordinator.commit` follows the same rule: `commitOnceLatched` retains each non-committed participant's attempt before restoring its tracker, and the retry loop retries the refresh while finishing is refused.

The ticket's open question is answered: **the coordinator (session-mode) path had the same hole.** With the finish step disabled, the new one- and two-collection coordinator cases fail with the inserted block never landing while `commit()` resolves.

# Why retained rather than rebuilt

A rebuilt attempt re-appends the log entry with a fresh timestamp, so its tail differs byte-for-byte from the one already stored under the same `(action, revision)`; a replica that had not yet stored the tail would store the second version. Re-sending verbatim avoids that on this path. The ordinary same-revision retry still rebuilds — filed separately, see below.

# Validation run

All from the repo root, all passing: `yarn lint`, `yarn lint:docs`, `yarn build`, typecheck of db-core and db-p2p, `yarn workspace @optimystic/db-core test` (1712 passing), `yarn workspace @optimystic/db-p2p test` (2924 passing, 63 pending — existing skips; the only db-p2p test change is the one new spec file), `yarn workspace @optimystic/quereus-plugin-optimystic test` (966 passing, 13 pending). The db-core and db-p2p runs are of the final tree. The plugin run predates one later edit, which added only a code comment.

Each new regression test was seen **failing** first:

- `own-entry-completes-the-action.spec.ts` before the fix: row reads back `undefined`, durability `undefined`, no named error.
- The coordinator cases and the mesh spec with the finish step temporarily short-circuited to reproduce the old behaviour: the inserted block never lands / the row reads back `undefined` on the real mesh after `replace()` resolved.
- The mesh spec with `StorageRepo.pend`'s own-revision carve-out temporarily disabled: fails with `TornActionError`, so the spec really does cover that arm.

All three temporary switches were removed; `grep` finds no marker in any `src`, `test` or db-core `dist`, and `storage-repo.ts` has no diff against HEAD.

# Use cases for the reviewer to test

- Tail-only landing, existing collection (tree): row readable on the writer and on a fresh reader; one revision; durability reported.
- Same, through `TransactionCoordinator.commit`, one and two collections.
- Same on the 3-node mesh, read from a node that never saw the tear; tree still writable afterwards (no pending record left standing on the tail).
- Whole action landed but reported failed (`CommitLandsButReportsStale`): still logged once, one revision, and the re-send is an idempotent no-op.
- Brand-new collection whose first commit lands only its tail: the header never landed, so the entry is not visible; recovery is the ordinary same-revision retry.
- A rival commits between the torn attempt and the refresh: `TornActionError` / `rival-holds-revision`; rival's row present, torn row absent, action still staged, log holds no second copy.
- Finishing refused once then accepted: still one revision and one entry.
- Finishing refused forever: `TornActionError` / `completion-refused`, not `SyncRetryExhaustedError`; revision not advanced.
- Own entry found with no retained attempt and a block missing: `transforms-not-held`; nothing consumed.

# Known gaps — please probe these

- **A rival that touched only the log tail still makes the write unfinishable.** Every commit touches the tail, and the transactor must commit the tail first at our revision, so once any rival has committed after the torn tail, the re-send is refused even if the rival never touched our data blocks. The writer is told by name, but the log keeps an entry for a write whose data never landed, permanently. This is the ticket's stated design; nothing cleans up or marks such an entry.
- **After `TornActionError`, a caller that calls `sync()` again gets a new action id**, and the actions are logged a second time at a later revision (the data then lands once). Documented on the error and in `collections.md`; nothing prevents it.
- **Partial multi-collection commit.** A participant reported as failed in `CoordinatorPartialCommitError` may itself be half-landed. The caller is told it failed, so the rule holds, but nothing finishes it once `commit()` exits and the marks are cleared. Separately, when one participant is finished on refresh and another is torn, the torn one surfaces as `TornActionError`, not as `CoordinatorPartialCommitError`. Untested.
- **The coordinator's re-send carries no block digests** (they are computed from the live tracker, gone by then); members fall back to corroboration. The sync path retains its digests.
- **`tornFromRefusal` reads `staleAt` / `missing` as "a rival committed".** I read `StorageRepo.pend` and `StorageRepo.commit`: both set the writer's own revision aside before building either field, and `CoordinatorRepo.classifyStaleRejection` excludes it from `staleAt` and sends no `missing`. I did not read every other place a `missing` list is assembled or merged (`ClusterMember`, `NetworkTransactor`'s aggregation beyond `staleFromBatches`). A producer that listed the writer's OWN action in `missing` would turn a finishable write into a permanent refusal — loud, not silent, but wrong.
- **`TornActionError.blockIds` is an over-approximation** on a refused re-send: every block the entry names except the tail, because the refusal does not say which are missing.
- **The status-read fallback** (`getStatus`, used only with no retained attempt at the entry's revision) judges by each block's latest revision, so a landed block that a later action superseded reads as missing. Errs loud. Parked as a `NOTE:` at the site.
- **The re-send always costs a full pend and commit round**, even when everything had landed. Parked as a `NOTE:` on `completeOwnEntry`.
- **`TestTransactor` behaviour changed for every spec that uses it**: a same-action retry at the same revision is now satisfied instead of refused, mirroring `StorageRepo`. No existing spec depended on the old refusal (full suite green), but it is a shared double.
- **Three `landedCommits === 1` assertions were rewritten**, not just renumbered. The re-send is a successful commit that writes nothing, so that counter can no longer tell "finished" from "replayed"; they now assert the storage revision (a replay takes a second revision). Worth checking I did not weaken them.
- Not covered by this ticket, unchanged: `NetworkTransactor.commit`'s tolerated arm still answers `success: true` with abandoned blocks named in `durability.torn` (callers must use `isFullyDurable`), and `TransactionCoordinator.execute()` has no retry, so it never consumed and was left alone.

# Downstream confirmation — not done, needs a human

With optimystic rebuilt (`yarn build`), from `../sereus/packages/integration-tests` run `npx vitest run --reporter=verbose src/scenarios/strand-chat-participants-converge.integration.ts -t "IMMEDIATELY"` at least 10 times. Expect no `_fk_Message_ParticipantId` failure. **Set expectations honestly:** in that two-member scenario finishing can itself keep being refused as `commit-not-durable` while the joiner's own member still lacks the log tail (`backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold`). If so, the run will now fail loudly with `TornActionError` (`completion-refused`) instead of silently losing the row — that is this ticket working, and the remaining failure belongs to that backlog ticket. Then tell sereus so it can revisit `tickets/blocked/device-shape-join-write-blocked-on-optimystic-read-after-write.md`.

# Board changes made here

- Filed `backlog/bug-a-retried-write-can-store-two-versions-of-one-log-revision` (`repro: static`): the ordinary same-revision retry rebuilds the log entry with a new timestamp, so two members can store different bytes under one `(action, revision)`. Different root cause and site from this ticket; not fixed here.
- Appended an arm to `backlog/debt-torn-commit-mesh-coverage-drops-no-blocks`: the new mesh spec is the test it asks for; only "move the tear helper into the shared mesh harness" remains open.
- No pre-existing test failures were seen.
