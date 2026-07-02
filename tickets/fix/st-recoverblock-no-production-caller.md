description: There is a repair routine that fixes a block left in a bad state by a crash, but nothing in the running system ever calls it — only tests do. So if a node crashes at the wrong moment, that block stays stuck and every retry fails until a human intervenes.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts
difficulty: medium
----

# `recoverBlock` has no production caller — the crash state it repairs permanently wedges the block

`storage-repo.ts` has a `recover()` / `recoverBlock` routine (`storage-repo.ts:477-481`) that
repairs a specific crash state, but no production code path invokes it — only tests call
`recover()`.

The unrepaired crash state: a commit crashes after the pend was durably promoted but before
`setLatest` landed. On retry, `commit()` fails with "Pending action not found" (the pend was
already promoted, so it is gone), and the idempotent-replay partition does not catch it because
`latest.rev < request.rev` (the `setLatest` that would have advanced `latest` was lost). The
block is wedged: every retry re-hits the same failure, and only a manual `recover()` — which
nothing in production issues — clears it.

Expected behavior: the system detects and repairs this state on its own. When a commit finds
the pend missing but `getRevision(request.rev)` + `getTransaction` show the action was durably
promoted, it should invoke `storage.recover()` and re-partition (or run `recover()` lazily on
first access to the block after startup) so the block becomes committable/readable again
without human intervention.

After the fix, forcing the promote-landed-but-`setLatest`-lost state and then retrying the
commit (or reading the block) repairs it automatically rather than failing indefinitely.

## Reproduction notes

- Simulate the crash window: durably promote a pend, drop the `setLatest`, then retry the
  commit and assert it recovers instead of throwing "Pending action not found" forever.
- The existing test-only `recover()` callers show the repair mechanics; the gap is the missing
  production trigger.

Interaction: cleaner detection of this state is aided by honest `meta.ranges`
(`st-pend-seeds-open-ended-ranges`), but the missing-caller fix stands on its own.

Suggested-fix hint: in `commit()`, when the pend is absent but the revision + transaction show
the action durably promoted, call `recover()` and re-partition — or run `recover()` lazily on
first post-startup access to the block.
