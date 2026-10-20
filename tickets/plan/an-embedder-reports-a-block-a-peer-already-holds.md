description: An application that delivers blocks to a joining peer itself (Sereus's join catch-up) has no typed way to tell Optimystic the peer now holds them, so the under-replication drain re-sends each of those blocks one request at a time seconds later (42 and 91 duplicate full-block requests per join in Sereus's measurement), and the rebalance growth arm does the same on storage-profile nodes; add a typed node attachment that records a peer as holding a block at a revision.
architecture: docs/internals.md#write-path-local-changes
files: packages/db-p2p/src/repo/under-replication-drain.ts, packages/db-p2p/src/repo/i-under-replication-ledger.ts (`satisfy`), packages/db-p2p/src/cluster/rebalance-monitor.ts (`recordBlockHolders`), packages/db-p2p/src/libp2p-node-base.ts (`underReplicationLedger` attached untyped, rebalance wiring), packages/db-p2p/src/optimystic-node.ts (`OptimysticNodeAttachments`)
----
# An embedder reports a block a peer already holds

Filed from sereus (`tickets/blocked/optimystic-embedder-cannot-report-block-holders`, written by its `join-backfill-pushes-once-and-is-waited-for` implement pass). No GitHub issue yet.

## What happens

Sereus's peer-join catch-up (`peer-join-backfill.ts`) pushes a newly connected peer every block it lacks, up to 64 blocks per `block-transfer` request. Optimystic tracks holders in two places, and neither hears of those pushes:

- **The under-replication drain.** A block committed while its writer had no connected cohort is owed to the members that missed it. When one connects, the drain pushes each owed block, one request per block, and clears an entry only on its own successful push.
- **The rebalance monitor** (storage-profile nodes). Its growth arm pushes a joiner every block whose cohort it entered, unless it already counts the joiner as a holder. It learns holders from this node's own commits and pushes and from pushes it receives (`recordBlockHolders`).

The ledger is attached as an untyped property (`(node as any).underReplicationLedger`, with `satisfy(blockId, peerIds, heldRev)`); the rebalance monitor is not attached. `OptimysticNodeAttachments` carries neither.

## Measured (sereus `message-cost-accounting`, 2026-10-20, Optimystic 1.16.0 linked at `72ac338c`, in-memory storage, loopback)

- Strand case (transaction profile, so no rebalance): Sereus's backfill delivers the founder's 42 blocks in one request (`accepted=42`); about 7 s later the drain pushes the same 42 again, one request each (`under-replication-drain pass:done trigger=identify entries=42 ... pushed=42`).
- Invite case (storage-profile owner): the backfill delivers 99 control blocks (64 + 35); afterwards the drain pushes 91 of them one at a time (64, then 27 at the 30 s recheck) and the rebalance growth arm 90 (`reason=rebalance`). Sereus now turns the growth reaction off where its backfill runs; the drain's share remains.

Over a public relay each duplicate is a relayed full-block request (#39's comment shows one such frame taking 8 s).

## Proposal (from the sereus ticket)

A typed node attachment in `OptimysticNodeAttachments`:

```ts
/**
 * Record that `peerId` holds `blockId` at revision `rev` or later, as learned by the embedder (an
 * application-level push it made and the peer accepted). Satisfies the under-replication ledger's
 * entry for that peer when `rev` covers it, and records the peer as a holder in the rebalance monitor.
 */
reportBlockHeld(blockId: BlockId, rev: number, peerId: string): Promise<void>;
```

The ledger's `satisfy` already has the needed semantics; the attachment reaches it and `recordBlockHolders`. Sereus would call it per accepted block from its backfill reply handling.

**Rejected in sereus's planning:** calling the untyped `underReplicationLedger.satisfy` directly (unstable internal, leaves rebalance uninformed); turning the drain off where the backfill runs (the drain also delivers a write that missed a then-connected member on its 30 s recheck); pushing after the drain (delays the joiner's first sync).

## TODO

- Plan the attachment: whether a report must be verified (a certified push the embedder made is trustworthy only as far as the embedder; decide whether `rev` must be checked against local storage), and its effect on a ledger entry whose owed revision is newer than `rev`.
- Name the test: a ledger entry satisfied by a report is not pushed by the next drain pass.
