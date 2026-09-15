description: When a row's value changes but a leftover entry for the old value stays behind in a uniqueness index, that old value stays permanently reserved — inserting a new row with it is refused as a duplicate even though no row holds it any more, and retrying never helps.
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The leftover entries this depends on are themselves defects with their own tickets, so a maintainer may reasonably decide to remove the producers and never teach the write path to tolerate one; and the obvious narrow fix converts a clean constraint error into a murkier commit-time refusal, which is arguably worse than the bug.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, docs/debugging.md
----

## What happens

A secondary `unique` constraint is enforced by a point probe of the constraint's backing index tree. If that tree holds an entry no row accounts for — a *leftover*, left when a row's indexed value changed and its old entry did not follow — the probe resolves the entry to whatever row its primary key names and counts it as a collision. It never checks that the row it fetched still holds the value being probed.

The result is a value that stays reserved forever with no row holding it. `docs/debugging.md` already records this in the index-integrity section ("in a tree enforcing a `unique` column it makes a value look taken when no row holds it"), so the behaviour is known; it has not been filed until now.

Reproduced single-node, in-memory transactor. `Account(Id integer primary key, Email text null unique)` holding one row `(1, 'a@x')`. With index maintenance deliberately broken for one statement so the old entry is left behind (`stageNewEntryOnly` in `packages/quereus-plugin-optimystic/test/index-staging-patch.ts`), row 1 moves to `b@x`. A plain `select` then confirms the only row holds `b@x`. Inserting `(2, 'a@x')` is refused: `UNIQUE constraint failed: Account.Email`. There is no row with `a@x`, and no retry can change that — every retry re-probes the same leftover entry and re-refuses.

## Why it is not simply the same fix as the read path

The read-path arm of this — an index *seek* returning a row that no longer holds the value — is a separate ticket, `index-seek-must-verify-its-entries`, and its fix is a re-check at the seek: the row an entry resolves to must still imply that entry. Applying the same re-check to the uniqueness probe (`probeUniqueConstraint` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`) is **not sufficient**, and this is the part that makes the shape unsettled.

If the probe skips the leftover, the insert proceeds and stages its index entry carrying the entry guard that actually enforces uniqueness across concurrent writers (`uniquePrefixGuard` in `packages/quereus-plugin-optimystic/src/schema/index-manager.ts`): *no entry other than mine may occupy this value's whole prefix range*. The leftover sits inside that range. The tree's replace handler therefore refuses the staged entry anyway — and the clean `UNIQUE constraint failed:` error the caller gets today turns into a refusal raised at staging or commit time, which is harder to read and harder to map. A probe-only change trades one wrong answer for a worse-shaped one.

So closing this needs a decision about where the leftover goes, not just about who ignores it. Roughly, the options a maintainer would weigh:

- **Remove the producers and stop there.** Two are known: concurrent same-row writes, which `refuse-concurrent-row-change-loser` closes; and a writer that was not maintaining the index updating a row, where a later re-attach adds the new entry and never purges the old one (see the `NOTE:` on `backfillIndexTrees`). The second survives that ticket, so this stays reachable — but if that producer is also closed, the tolerated-leftover machinery is dead weight.
- **Purge on discovery.** The probe knows the entry is a leftover at the moment it fetches the row; it could stage its removal. That is the first write this codebase would do from a read-shaped path, and there is no orphan-repair entry point yet — the notes on `reconcileMaintainedIndexes` and `hasNoRowsToBackfill` anticipate one and it does not exist.
- **Narrow the guard.** Make the entry guard claim something a leftover cannot satisfy on the rival's behalf. This is the deepest change and touches the concurrency semantics the guard exists for.

## What would make this ready to work

A choice among those three, with the commit-path consequence of each spelled out. Until then this is a known, documented, reachable wrong answer with a loud failure mode — the caller is refused rather than silently given bad data — which is why it is filed here rather than ahead of the read-path fix.
