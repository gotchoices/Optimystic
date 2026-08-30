description: The fix that stops a commit from recording its write at the wrong revision number is fully coded and compiles; what remains is running the test suite to confirm nothing hangs or regresses, then writing the review handoff.
files:
  - packages/db-core/src/transaction/coordinator.ts (all changes landed)
  - packages/db-core/src/collection/collection.ts (all changes landed)
  - packages/db-core/test/coordinator.spec.ts (updated to new phase signatures)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (audit comment corrected)
difficulty: easy
----

# Validate the landed commit-latch + rev-threading change, then hand off to review

Continuation of `2-coordinator-commit-latch-and-rev-threading` after a budget stop. **All code
changes from that ticket's settled design are implemented and landed in the working tree; root
`yarn build` and `yarn typecheck` both pass.** Do NOT re-derive or redo the design — only
validate and hand off. The original ticket's full background lives in the completed sibling
`2-coordinator-mutates-collections-outside-their-latch` lineage; sibling tickets
`2.2-coordinator-interleaving-spec` and `2.4-collection-divergence-report-fields` carry the
repro spec and diagnostics work.

## What was implemented (verify nothing, just know it)

**collection.ts:**
- `instanceTag` — new public readonly field, 4 random bytes base64url via private static
  `newInstanceTag()`; generated in `open`/`createOrOpen` BEFORE `attachToLog` (pre-construction,
  as the diagnostics ticket 2.4 needs) and passed as a trailing constructor arg (defaulted from
  the helper for direct construction).
- `latchId` is now `Collection:${id}#${instanceTag}` — instance-scoped, with the full rationale
  comment (per-instance state only; cross-instance races belong to the transactor's optimistic
  concurrency; process-global key would deadlock the coordinator's whole-span hold against
  `CompetingWriterTransactor`-style rivals since `Latches` is non-reentrant).
- `recordCommitted(actionId, rev)` — new required `rev` param; throws on mismatch with
  `getNextRev()` ("…was pended at rev X but the collection now expects rev Y — the collection
  was refreshed mid-commit"). Doc comment updated; syncInternal's inline bump untouched.
- New `acquireLatch(): Promise<() => void>` — exposes the instance latch for the coordinator's
  span-hold; doc warns about non-reentrancy.

**coordinator.ts:**
- `applyActionsToCollection` returns `rev` (the single capture point — the number stamped on the
  log entry).
- `commitOnce` now: computes participants, then acquires every participant's instance latch in
  sorted collection-id order (comment cites StorageRepo.commit's sorted block-id discipline),
  runs the extracted `commitOnceLatched(transaction, collectionData)` body, releases all in a
  `finally`. The body threads `pendedRevs: Map<CollectionId, number>` from the apply loop into
  `coordinateTransaction` and both `recordCommitted` call sites (success fold + partial-commit
  loop). The success fold loop remains await-free (new NOTE comment marks it).
- `execute` mirrors this: `pendedRevs` threaded; latches acquired AFTER `applyActions` (which
  takes the instance latch itself via `collection.act`), deduped via `new Set`, sorted, released
  in `finally` (execute has early failure returns); both its `recordCommitted` sites pass the rev.
- `coordinateTransaction`, `pendPhase`, `commitPhase` gained a `pendedRevs` parameter;
  `pendCollection` and `commitCollection` take `rev` directly and no longer call
  `collection.getNextRev()` (the commit-side recompute was the same bug family).
- The retry loop's blanket `collection.update()` in `commit()` stays OUTSIDE the held span.

**coordinator.spec.ts:** `fakeCollections` no longer provides `getNextRev` (phases no longer call
it); new `revsFor()` helper; every direct `pendPhase`/`commitPhase` invocation and inline type
cast updated to the new signatures.

**optimystic-module.ts (~line 2945):** audit bullet corrected — live-scan serialization claim now
rests on the instance latch which the coordinator holds for the whole commit span; the
fold-loop-has-no-await claim at ~2977 is preserved (still true).

Swept: no other `recordCommitted` callers exist outside coordinator.ts (grep confirmed — tests
only mention it in comments). No subclasses of Collection. quereus-engine.spec.ts coordinators
use empty collection maps (no latch calls); transaction.spec.ts uses real Collections off Trees.

## TODO

- Run `yarn test` from the repo root, in the foreground, no output redirection (add
  `2>&1 | tee tickets/.logs/2-coordinator-commit-latch-validate.test.log` only if grepping is
  needed). The quereus-plugin two-node sweep is part of it and must stay green.
- Watch specifically for HANGS in transaction.spec.ts's "real competing writer" describe block
  (~line 4465-4830): a hang there means the instance-scoped latch key was somehow not applied or
  a latched Collection method is being called inside the held span. Those tests double as the
  non-reentrancy regression the original ticket demanded — say so in the handoff.
- Watch for new `recordCommitted` mismatch throws in any test — that throw is the tripwire; a
  firing one means some commit path bypasses the latch and must be fixed, not silenced.
- If a failure is plainly pre-existing (fails at HEAD before these edits, subsystem outside the
  diff), follow the pre-existing-failure protocol (check `tickets/.pre-existing-known.md`, else
  write `tickets/.pre-existing-error.md`) — do not chase it here.
- On green: write the review/ handoff ticket (distilled summary, use cases for testing, honest
  gaps — e.g. no NEW test exercises the latch-held-across-span property directly; the sibling
  `2.2-coordinator-interleaving-spec` ticket owns that repro) and delete this ticket.
