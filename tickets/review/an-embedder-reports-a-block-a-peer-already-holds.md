description: An application that delivers blocks to a peer itself (Sereus's join catch-up) can now tell the node "this peer holds this block", so the node stops owing that peer a copy and stops re-sending the block one request at a time; review the new node method, the shared confirmed-copy rule it uses, and the docs.
architecture: docs/internals.md#write-path-local-changes
files: packages/db-p2p/src/repo/owed-copies.ts (new), packages/db-p2p/src/repo/under-replication-drain.ts, packages/db-p2p/src/libp2p-node-base.ts (`heldCopyDeps` / `reportBlockHeld` after the drain block; `attachments` literal), packages/db-p2p/src/optimystic-node.ts (`OptimysticNodeAttachments.reportBlockHeld`), packages/db-p2p/src/repo/coordinator-repo.ts (import only), packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/cluster-repo.ts (`BlockHoldersSink` doc), packages/db-core/src/transactor/change-notifier.ts (`BlockDurabilityReachedEvent` docs), packages/db-p2p/test/under-replication-drain.spec.ts, packages/db-p2p/docs/repo.md, docs/internals.md, docs/debugging.md
----
# An embedder reports a block a peer already holds

Filed from sereus: its peer-join catch-up pushes a joining peer every block it lacks, many per request, and Optimystic then re-sent the same blocks one request at a time — the under-replication drain about 7 s later, and on storage-profile nodes the rebalance growth arm too — because neither knew the embedder's push had landed.

## What was built

**`node.reportBlockHeld(blockId, rev, peerId): Promise<void>`** on `OptimysticNodeAttachments` (always present). `peerId` is `PeerId.toString()`. It does two things, in this order:

1. Calls the existing late-bound `onBlockHolders` sink with `{ blockIds: [blockId], holders: [peerId] }` — the embedder is now the fifth producer of rebalance holder evidence. A no-op where no rebalance monitor was built; self is ignored by the monitor.
2. Awaits `recordHeldCopy` (the ledger half) in the new `packages/db-p2p/src/repo/owed-copies.ts`.

It is attached through the typed `attachments` literal in `createLibp2pNodeBase`, outside the drain's `enabled` gate (disabling the drain stops pushing, not recording).

**`owed-copies.ts`** now holds what the drain and the report share, so they cannot drift:

- `resolveOwedPeers(entry, selfId, keyNetwork)` — the drain's former private `owedPeers`, unchanged.
- `takeConfirmedCopies(deps, entry, owed, confirmed, heldRev, collectionId?)` — the former `recordConfirmed` body plus the post-`cleared` emit that used to sit in `drainEntry`: name an unnamed entry with the resolved cohort, `satisfy` with the revision guard, emit only on `cleared` (after the deletion). Logging stays with each caller.
- `recordHeldCopy(deps, blockId, rev, peerId)` → `'not-owed' | 'cleared' | 'owed' | 'absent'`:
  - self → `not-owed`, nothing read;
  - no entry → `absent`;
  - entry records a revision above `rev` → `owed`, nothing written (`report:older-copy`). **Beyond the ticket's text:** this check runs *before* naming, so a copy that cannot satisfy the entry does not name an unnamed one either — the drain keeps resolving its cohort afresh. Same comparison `satisfy`'s `heldRev` rule makes.
  - cohort solo / unresolved / not containing `peerId` → `not-owed`, nothing written;
  - otherwise `takeConfirmedCopies(entry, owed, [peerId], rev)`; logs `report:cleared`, `report:satisfied`, or `report:settled-elsewhere`.
- `BlockDurabilitySink` moved here; `under-replication-drain.ts` re-exports it so the package barrel is unchanged; `coordinator-repo.ts` imports it from its new home.

The event fired from a report carries no `collectionId` (documented on `BlockDurabilityReachedEvent.collectionId`).

## Tests added

Both in `packages/db-p2p/test/under-replication-drain.spec.ts`, `describe('an embedder report')`, over the real in-memory ledger and the spec's existing fakes:

- **"clears an entry that could not name its members, and the next pass pushes nothing"** — the strand shape (unnamed `local` entry, cohort `{self, peerX}`): report → `cleared`, entry gone, one event; a drain pass with `peerX` connected pushes nothing and fires no second event. A plain `satisfy` would not have covered this.
- **"leaves the entry unnamed when the cohort does not contain the reported peer"** — cohort `{self, peerY}`, report for `peerX` → `not-owed`, entry byte-for-byte unchanged, no event; the next pass still pushes to `peerY`.

The drain's existing 25 specs pass unchanged over the moved logic.

## Validation run

- `yarn workspace @optimystic/db-core build`, then `yarn workspace @optimystic/db-p2p typecheck` — clean.
- `yarn test` in db-p2p — 3505 passing, 73 pending, 0 failing.
- `yarn lint:docs` — all resolve. eslint on every touched source file — clean.
- `yarn workspace @optimystic/db-p2p build` — done, so downstream packages see a fresh build.
- **Not run:** `yarn test:integration` (no behaviour change on the drain path; `small-deployment-lifecycle.integration.spec.ts` exercises the drain over real sockets if a reviewer wants it), and the other workspaces' suites.

## Known gaps / things to look at

- **No test for the `older-copy` early return** (report at a revision below the entry's). It is a guard mirroring `satisfy`'s rule, which the ledger spec covers; a reviewer may want one if they consider the "don't name on an older copy" behaviour part of the contract.
- **No test for the node attachment or the rebalance sink call** — glue, per the ticket.
- **Log order shift in the drain:** the event is now emitted inside `takeConfirmedCopies`, so it fires before the drain's `entry:cleared` line rather than after. The event still fires after the ledger deletion.
- **The drain's in-memory failure/abandon counters** for a peer a report satisfied are left until `pruneState` drops the block — accepted in the ticket (they affect only pushes to peers still owed).
- **Rebalance timing:** a report arriving after a monitor check already reported the peer `grown` does not stop that reaction's push (existing `NOTE:` covers the shape). Sereus disables the growth reaction where its catch-up runs.
- **A report racing a drain push** of the same entry: the ledger's per-block ordering decides which `satisfy` clears it and fires the one event; the in-flight push is not recalled. Verified by inspection only.
- `recordHeldCopy` is not exported from the package barrel; the host surface is the node attachment.

## Docs updated

`packages/db-p2p/docs/repo.md` (new **An embedder's report** paragraph; event producers sentence), `docs/internals.md` (Holder evidence → five producers; UnderReplicationDrain → one sentence on the report), `docs/debugging.md` (`under-replication-drain` row → the `report:` lines), plus the producer-count comments in `rebalance-monitor.ts`, `cluster-repo.ts` and `libp2p-node-base.ts`.
