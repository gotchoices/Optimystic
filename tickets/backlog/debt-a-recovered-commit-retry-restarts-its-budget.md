description: After a node restarts, a background retry it was in the middle of starts counting its attempts from zero again instead of picking up where it left off, so a member that is simply never coming back can be chased forever across restarts and a log line reports the wrong attempt number.
architecture: packages/db-p2p/docs/cluster.md#commit-retry-loop
files: packages/db-p2p/src/repo/cluster-coordinator.ts (`recoverTransactions`, `scheduleCommitRetry`), packages/db-p2p/test/cluster-coordinator.spec.ts (`ClusterCoordinator recovery clock seam`), packages/db-p2p/docs/cluster.md (`Commit Retry Loop`)
difficulty: easy
tradeoffs: A maintainer may reasonably decide that a restart genuinely deserves a fresh budget, in which case the fix is to stop persisting the attempt count and to correct the log line instead; and a node whose key-value store is in memory still recovers nothing, so a deployment that has not supplied a durable one is unaffected either way.
----

# A recovered commit retry restarts its budget

## Background, for a reader with no context

When a coordinator finishes a write, some machines in the group may have missed the final message. The coordinator then retries in the background, a fixed number of times with growing delays, and gives up after the last attempt — giving up is what frees the bookkeeping it was holding and what tells an operator, in the log, that a machine is not coming back.

The background retry survives a restart: the node writes it to a store, and the number of attempts already spent goes in with it on every attempt. That count is never read back.

## The two arms

Both are in `recoverTransactions` in `packages/db-p2p/src/repo/cluster-coordinator.ts`, where it hands a recovered transaction to `scheduleCommitRetry`. Both were read from the code during the review of `bug-abandoned-commit-retry-never-releases-its-transaction`, not run.

**The attempt count is written and never read.** Recovery builds its in-memory entry with no retry attached, so `scheduleCommitRetry` reads no previous attempt and schedules attempt 1, at the initial delay, however many attempts the store says were already spent. Two consequences. The budget restarts on every restart, so a machine that is permanently gone is chased indefinitely by a node that restarts often, and the give-up the retry loop promises never arrives. And the recovery log line reports the stored attempt number while the very next line reports the attempt actually scheduled, so the two contradict each other on the same transaction.

The comment at that call site says the retry is scheduled "from where we left off", and the attempt count is persisted for no other purpose, so resuming looks like the intent. Whoever picks this up should confirm that with the maintainer before choosing between the two fixes in `tradeoffs:` — restoring the count, or dropping it and correcting the log.

**A recovered retry with nobody left to chase is never released.** This arm is conditional and costs nothing today. `scheduleCommitRetry`, handed an empty list of machines to chase, calls the release helper — which does nothing unless a retry is already armed, and on the recovery path none is. The entry and its stored state would then be held for the life of the process: exactly the leak that `bug-abandoned-commit-retry-never-releases-its-transaction` closed, through the one door that ticket's single release site does not cover. It cannot happen from anything this code writes, because an empty list is rejected before the state is ever stored; it needs a stored state written by another version or corrupted in place. Whichever fix the first arm takes should leave this door shut too.

# Arm: this path is reachable on every serving node now (2026-11-23)

`implement/a-node-keeps-its-transaction-state-where-it-keeps-the-rest` made every serving node build its transaction-state store over its own key-value store, so `recoverTransactions` runs at every node start rather than never. The first arm above is therefore live wherever a node is given a durable key-value store and restarts with a commit broadcast in flight: the attempt budget restarts, and the two log lines contradict each other. The second arm stays conditional for the reason it already states — nothing this code writes can produce the empty chase list it needs.
