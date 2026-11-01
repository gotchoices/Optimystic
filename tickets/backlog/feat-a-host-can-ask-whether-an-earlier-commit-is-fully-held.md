description: An application can learn that a commit reached every group member only by staying online and listening on the machine that saved it; it cannot ask "is this earlier commit held by everyone now?" after a restart, or for a commit another machine coordinated. Add a way to ask.
prereq: a-sql-commit-learns-when-it-becomes-fully-held
architecture: packages/db-p2p/docs/repo.md#the-under-replication-drain-and-the-full-replication-event
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/durability-follower.ts (from the prereq — the commits it reports `followed: false`)
  - packages/db-p2p/src/repo/i-under-replication-ledger.ts (`get` — the local half of an answer)
  - packages/db-core/src/transactor/network-transactor.ts (`NetworkTransactor.getLineage`, which already asks every cohort member about a block directly)
  - packages/db-core/src/network/struct.ts (`WriteDurability.blockRevs`, `recordedBy`)
tradeoffs: The commits it would cover are uncommon in the small groups the use case comes from (a writer there almost always coordinates its own write and stays running), and asking every cohort member about every block of every pending commit is real network traffic, so a maintainer could reasonably wait until a host reports a "not yet delivered" mark that never clears.
----

# A host can ask whether an earlier commit is fully held

Follow-on to GitHub issue #26. After `a-sql-commit-learns-when-it-becomes-fully-held`, a SQL commit saved below full replication gets an `onCommitFullyHeld` call when its copies reach every cohort member — but only when the plugin can follow it, which it reports as `SqlCommitDurability.followed`. Three kinds of commit come back `followed: false` or are lost from following, and for each the host has no way to clear a "pending" mark:

1. **A commit another machine coordinated** (its `recordedBy` names another node, or no node): the full-replication event fires on that machine, not here.
2. **A commit from before a restart**: the follower is in memory. The under-replication ledger survives a restart (when the node has a `kvStore`), and the drain still fires the events, but nothing maps them back to commits the app still shows as pending.
3. **A commit whose holders were unknown** (`overall` absent), or whose collection mixed full and below-full cohort answers.

## What a host needs

A query: given what the app kept from a commit report — its blocks and revisions (`WriteDurability.blockRevs`, which a host can persist beside its own pending mark) — answer, per block, whether every member of the block's current cohort holds that revision or a later one. "All of them" lets the host clear the mark; anything else keeps it.

Candidate mechanisms to weigh in planning:

- **Ask the cohort** — a per-block "do you hold revision ≥ r?" round to every member, in the shape `NetworkTransactor.getLineage` already uses (asks each member directly, no coordinator round, no promotion). Works for all three cases; costs one round per block per query.
- **Ask the local ledger** — "is block X still owed by this node?" (`IUnderReplicationLedger.get`). Free, and enough for case 2 when this node coordinated; useless for case 1.
- **Both**, local first.

Open question for planning: whether the plugin should run such a query itself on a timer for `followed: false` commits, or expose it for the host to call (the host knows which marks it is still showing; the plugin, after a restart, does not).
