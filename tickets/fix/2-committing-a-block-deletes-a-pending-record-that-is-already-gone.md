description: Since the change that stopped a stale pending record from blocking later writes, every commit spends one extra storage operation deleting a record that has already been moved, so a solo insert costs about 14% more storage work than before. It is wasted work, not a wrong result.
files:
  - packages/db-p2p/src/storage/block-storage.ts (`setLatest` ~line 335, `sweepDeadClaims` ~237, `recordClaim` ~215, `recoverLatest` ~379, `promotePendingTransaction` ~280)
repro: downstream (measured, exact)
severity: cost
likelihood: always
----

# What was measured

Reported 2026-09-17 by sereus (`sereus-83`); its ticket is `../sereus/tickets/blocked/solo-insert-cost-rose-with-upstream-pending-claims.md`. Sereus's solo-strand cost-budget specs count raw-storage operations and are now over their ceiling.

| | before `9cbc7427` | at `2a1bfedb` |
|---|---|---|
| solo insert | 80 | 99 |
| solo launch | 78 | 88 |

Sereus attributed the whole increase, exactly: 80 + 11 + 8 = 99.

- **(a) +11 insert, +8 launch: a delete that does nothing.** `BlockStorage.setLatest` calls `sweepDeadClaims(meta, latest.rev)` after `promotePendingTransaction` has already **moved** the committing action's own pending record. That action's recorded claim equals `latest.rev`, so the sweep treats it as a dead record at or below the new latest and issues `deletePendingTransaction` for a record that is no longer there. The code comment above the call says as much: "The committing action's own record was just moved by `promotePendingTransaction`, so its claim goes here".
- **(b) +8 insert: the claim written first at pend time.** `savePendingTransaction` now writes the claim into metadata before the record. Sereus accepts this as intended crash ordering, and it should stay.

# Proposed fix (sereus's, checked against the code)

In `setLatest`, drop the committing action's own claim before sweeping:

```ts
BlockStorage.recordClaim(meta, latest.actionId, undefined);
await this.sweepDeadClaims(meta, latest.rev);
await this.storage.saveMetadata(this.blockId, meta);
```

Do the same in `recoverLatest`, where every recovered revision's action has been confirmed promoted. `setLatest`'s existing `saveMetadata` already persists the change, so this adds no write.

**Must still hold:**
- any **rival** record claiming a slot at or below the new latest is still deleted (that is the dead-claim sweep `a-member-that-missed-a-commit-refuses-every-later-write` depends on)
- the pend-time order stays metadata first, record second
- `pendingRevs` keeps its shape

**Expected after:** solo insert 88, solo launch about 80.

# Before implementing

Reproduce the count here rather than trusting the downstream figure alone. A test that counts raw-storage calls around one commit on a single node should show one `deletePendingTransaction` for the committing action today and none after. Then check that `member-missed-commit-heals-at-commit.spec.ts` and `pending-claim.spec.ts` still pass: removing the own claim must not stop a genuinely dead rival from being swept.
