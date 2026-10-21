description: An application that delivers blocks to a joining peer itself (Sereus's join catch-up) has no way to tell Optimystic the peer now holds them, so Optimystic sends each of those blocks again, one request at a time, seconds later; add a typed node handle that records "this peer holds this block", which takes the peer off the owed-copies record and tells the rebalance monitor not to push to it.
architecture: docs/internals.md#write-path-local-changes
files: packages/db-p2p/src/repo/under-replication-drain.ts (`owedPeers`, `recordConfirmed`, `drainEntry`'s cleared-event emit — to be moved out), packages/db-p2p/src/repo/owed-copies.ts (new), packages/db-p2p/src/repo/i-under-replication-ledger.ts (`satisfy`, `name` — semantics used as-is), packages/db-p2p/src/cluster/rebalance-monitor.ts (`recordBlockHolders` doc: a fifth producer), packages/db-p2p/src/cluster/cluster-repo.ts (`BlockHoldersSink`), packages/db-p2p/src/libp2p-node-base.ts (`blockHoldersTarget` / `onBlockHolders`, the drain construction block, the `(node as any).underReplicationLedger` attachment), packages/db-p2p/src/optimystic-node.ts (`OptimysticNodeAttachments`), packages/db-core/src/transactor/change-notifier.ts (`BlockDurabilityReachedEvent.collectionId` doc), packages/db-p2p/test/under-replication-drain.spec.ts, packages/db-p2p/docs/repo.md, docs/internals.md, docs/debugging.md
----
# An embedder reports a block a peer already holds

Filed from sereus (`tickets/blocked/optimystic-embedder-cannot-report-block-holders`). Sereus's peer-join catch-up (`peer-join-backfill.ts`) pushes a newly connected peer every block it lacks, up to 64 per request. Optimystic tracks who holds what in two places, and neither hears of those pushes:

- **The under-replication ledger and its drain** (`UnderReplicationDrain`). A block committed while the writer had no connected cohort is recorded as owed to the members that missed it; when one connects, the drain pushes each owed block, one request per block, and takes a peer off an entry only on its own confirmed push.
- **The rebalance monitor's growth arm** (storage-profile nodes). It pushes a newly co-responsible peer every block whose cohort it entered, unless it already counts that peer as a holder, which it learns through `recordBlockHolders` (the `BlockHoldersSink`).

Measured in sereus (`message-cost-accounting`, Optimystic 1.16.0): after the catch-up delivered 42 blocks in one request, the drain pushed the same 42 again one at a time about 7 s later; in the storage-profile case the drain re-pushed 91 of 99 and the growth arm 90. Over a public relay each duplicate is a relayed full-block request.

## Design

### The handle

One new member of `OptimysticNodeAttachments` in `packages/db-p2p/src/optimystic-node.ts`, always present:

```ts
/**
 * Record that `peerId` holds `blockId` at revision `rev` or later, as learned by the embedder — for
 * example from a block push the embedder made itself and the peer accepted. Two effects:
 *
 *  - the rebalance monitor counts `peerId` as holding the block, so its growth arm does not push it
 *    there (when the monitor runs on this node; otherwise nothing);
 *  - the under-replication ledger's entry for the block, when it owes `peerId` a copy of a revision
 *    at or below `rev`, no longer owes it; an entry left with nobody owed is removed and the
 *    full-replication event fires for it, exactly as when this node's own push is confirmed.
 *
 * The report is taken on the embedder's word: nothing is checked against the peer or local storage.
 * A wrong report costs the peer a copy it should have received, until a later commit to the block
 * records a new shortfall or the peer leaves the cohort and rejoins.
 *
 * Resolves once the ledger has been updated. Rejects only on a fault reading or writing the ledger.
 * Reporting this node's own peer id does nothing.
 */
reportBlockHeld(blockId: BlockId, rev: number, peerId: string): Promise<void>;
```

`peerId` is `PeerId.toString()` (the `12D3KooW…` form), matching the ledger's `missingPeerIds` and the rebalance monitor's peer sets.

### Decisions settled here

**No verification of the report.** The embedder is in-process and owns the node; its report is evidence of the same kind the node already accepts from a remote peer — a receiving peer's reply that it persisted a push is what both `pushBlockToPeers` and `RebalanceMonitor.recordGrowthOutcome` count as confirmation, and Sereus's evidence is exactly such a reply. Checking `rev` against local storage would buy nothing: a peer may legitimately hold a newer revision than this node (this node is behind), and the ledger's own revision guard already decides whether a copy covers an entry. Rejected: requiring a commit proof or re-reading the peer (adds a round trip per block — the cost this ticket exists to remove).

**An entry recording a newer revision than `rev` is left alone.** That is `IUnderReplicationLedger.satisfy`'s existing `heldRev` rule: a copy of an older revision says nothing about a newer shortfall. The drain then pushes the newer revision as before. A `rev` above the entry's satisfies it (a later revision supersedes an earlier one).

**An entry that never named its missing members is named first, but only for a peer it owes.** Sereus's strand case is exactly this shape: the founder wrote alone, knowing no other member, so the entry's `missingPeerIds` is empty ("unknown"), and `satisfy` on an unknown set is a no-op by contract. The report path therefore does what the drain does at push time: re-resolve the block's cohort through `findCluster`, and when `peerId` is in it, `name` the entry with the resolved members (excluding self) and then `satisfy`. When the cohort resolves to this node alone, cannot be resolved, or does not contain `peerId`, the report writes nothing to the ledger — naming freezes the set the drain will push to, and the report is not evidence about anyone else. (When the cohort is `{self, peerId}`, naming then satisfying empties the entry and fires the event — the strand case's outcome.)

**One implementation of "a peer confirmed a copy", shared by the drain and the report.** Move the drain's private `owedPeers` and `recordConfirmed` (and the emit that follows a `cleared` status in `drainEntry`) into exported functions in a new `packages/db-p2p/src/repo/owed-copies.ts`, and have the drain call them. Suggested shape:

```ts
export type Owed =
	| { kind: 'solo' }
	| { kind: 'unresolved' }
	| { kind: 'peers'; peerIds: string[]; named: boolean };

/** Who an entry still owes: named members as recorded; an unknown set re-resolves the cohort now. */
export function resolveOwedPeers(entry: UnderReplicatedEntry, selfId: string, keyNetwork: Pick<IKeyNetwork, 'findCluster'>): Promise<Owed>;

/** Take confirmed peers off the entry (naming it first when unnamed); fire the event when THIS call cleared it. */
export function takeConfirmedCopies(deps: { ledger; emit: BlockDurabilitySink }, entry, owed: Owed & { kind: 'peers' }, confirmed: readonly string[], heldRev: number, collectionId?: CollectionId): Promise<SatisfyOutcome['status']>;

/** The ledger half of `reportBlockHeld`. */
export function recordHeldCopy(deps: { ledger; keyNetwork; selfId: string; emit: BlockDurabilitySink }, blockId: BlockId, rev: number, peerId: string): Promise<'not-owed' | SatisfyOutcome['status']>;
```

Names are suggestions; the requirement is that the drain and the report cannot drift on naming, the revision guard, or "emit only on `cleared`, after the deletion". `recordHeldCopy`: no entry → `absent`; peer is self or not among the owed → `not-owed` (no write); otherwise `takeConfirmedCopies(entry, owed, [peerId], rev)`. Log under the drain's namespace (`under-replication-drain`) with a `report:` prefix — `report:cleared`, `report:satisfied`, `report:not-owed` — so an operator can tell an embedder-cleared entry from a drain-cleared one.

**The event from a report carries no `collectionId`.** The report path does not read the block (the field is already documented best-effort and absent when a settling commit fires the event; add "or an embedder's report cleared the entry"). Hosts key pending state by block and revision (`DurabilityFollower`), so nothing needs it.

**Works with the drain disabled.** `NodeOptions.underReplicationDrain: { enabled: false }` stops pushing, not recording; the report path depends only on the ledger, the key network and `storageRepo.emitBlockDurabilityReached`, all built unconditionally, so it is wired outside the drain's `if`.

**The rebalance half goes through the existing late-bound sink.** `reportBlockHeld` calls `onBlockHolders({ blockIds: [blockId], holders: [peerId] })` — the same sink the four existing producers use, a no-op when no monitor was built (rebalance or FRET off, transaction profile). Revision is not passed: the growth arm counts copies, not currency (see the `NOTE:` on `BlockHolders.holders`). Call it first (synchronous, never throws), then the ledger half. This makes the embedder the fifth producer: update the list in `RebalanceMonitor.recordBlockHolders`'s doc comment and in `docs/internals.md` § RebalanceMonitor → **Holder evidence** ("Four producers report through it").

**Not added:** a batch form. Sereus reports per accepted block (≤ 99 per join); each call is one ledger read plus, for an unnamed entry, one cohort lookup — the same per-entry cost a drain pass pays. If a batch API is ever wanted it is additive.

Rejected alternatives (from sereus's planning, still valid): calling the untyped `underReplicationLedger.satisfy` directly (unstable internal, does not name unnamed entries, leaves rebalance uninformed); turning the drain off where the catch-up runs (the drain also delivers a write that missed a then-connected member); pushing after the drain (delays the joiner's first sync).

## Edge cases & interactions

- **Report lands while the drain is mid-push on the same entry.** The ledger serializes per block: whichever `satisfy` empties the entry gets `cleared` and fires the one event; the other gets `absent` and fires nothing. The duplicate push already in flight is not recalled — accepted, bounded by one push per entry. Verified by inspection (the ledger's per-block ordering is already pinned in `kv-under-replication-ledger.spec.ts`).
- **A `full` commit settles the entry concurrently.** The report sees `absent` (or `satisfy` returns `absent`) and fires nothing; the settling commit's coordinator already did. Inspection — same path the drain uses.
- **Entry at a higher revision than `rev`.** Unchanged; no event. Covered by the ledger's `heldRev` rule, already tested.
- **Unnamed entry; cohort is solo, unresolvable, or lacks `peerId`.** No ledger write; the entry stays unnamed so the drain re-resolves it later. Test (below).
- **Unnamed entry whose cohort contains `peerId` and others.** Named with the whole resolved cohort minus self, `peerId` removed; the drain later pushes only the rest. Inspection (follows from reusing `takeConfirmedCopies`).
- **Named entry that does not name `peerId`.** `satisfy` removes nothing; harmless. Inspection.
- **`peerId` is this node.** Both halves ignore it (`resolveOwedPeers` already filters self; `recordBlockHolders` ignores self). Inspection.
- **Drain's in-memory failure / abandon counters for a peer a report satisfied.** Left in place until `pruneState` drops the block's state when its entry leaves the ledger; they only ever affect pushes to peers still owed, so a satisfied peer is unaffected. Inspection.
- **Rebalance timing.** Evidence is consumed at the monitor's next check. A report arriving after a check already reported the peer `grown` does not stop that reaction's push (the existing `NOTE:` about evidence arriving after a check covers this shape). Sereus disables the growth reaction where its catch-up runs; nothing to add.
- **Block not tracked by the rebalance monitor.** Evidence is dropped at the next check, as for every producer. Inspection.
- **Node stopped.** `recordBlockHolders` ignores reports while stopped; the ledger half may reject on a closed store. Documented in the doc comment ("rejects only on a ledger fault").
- **Membership predicate refuses `peerId`.** Not consulted: the report is about a copy the embedder already delivered; the predicate governs where this node sends content, and nothing is sent. Inspection.

## Tests

In `packages/db-p2p/test/under-replication-drain.spec.ts`, over its real in-memory ledger, fake key network, fake libp2p and push double, a new `describe('an embedder report')`:

- **A report clears an unnamed entry, and the next pass pushes nothing.** Record `entryFor(BLOCK_A, { quorum: 'local' })` (empty missing set); cohort `{self, peerX}`; `recordHeldCopy(…, BLOCK_A, entry.rev, peerX)` → `cleared`; `ledger.get(BLOCK_A)` is `undefined`; `events` names `[BLOCK_A]` once; connect and identify `peerX`, `drain.checkNow()` → `pusher.calls` empty, no second event. (This is the ticket's named test, in the strand shape that a plain `satisfy` would not have covered.)
- **A report for a peer the cohort does not contain leaves the entry unnamed.** Same entry; cohort `{self, peerY}`; report for `peerX` → `not-owed`; the entry's `missingPeerIds` is still empty, no event; the next pass pushes to `peerY`.

The drain's existing specs cover the moved `owedPeers` / `recordConfirmed` logic; they must still pass unchanged. No test for the attachment wiring or the rebalance sink call (glue).

## TODO

- Create `packages/db-p2p/src/repo/owed-copies.ts`; move the drain's `Owed` type, `owedPeers`, `recordConfirmed` and the post-`cleared` emit into it as exported functions; make `UnderReplicationDrain` call them (behaviour unchanged).
- Add `recordHeldCopy` (the ledger half) there, with the `report:` log lines.
- In `createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`), outside the drain's `enabled` gate, attach `node.reportBlockHeld` = call `onBlockHolders({ blockIds: [blockId], holders: [peerId] })`, then `await recordHeldCopy({ ledger: underReplicationLedger, keyNetwork, selfId, emit: (e) => storageRepo.emitBlockDurabilityReached(e) }, blockId, rev, peerId)`. Assign it through the typed node, not `(node as any)`.
- Add `reportBlockHeld` to `OptimysticNodeAttachments` with the doc comment above; update that interface's leading comment if it lists what is attached.
- Update `RebalanceMonitor.recordBlockHolders`'s producer list and the `BlockHoldersSink` / `blockHoldersTarget` comment in `libp2p-node-base.ts` ("Four producers") to five.
- Update `BlockDurabilityReachedEvent.collectionId`'s doc in `packages/db-core/src/transactor/change-notifier.ts`.
- Docs: `packages/db-p2p/docs/repo.md` § The under-replication drain and the full-replication event — a paragraph on the embedder report as a third way an entry shrinks (and a third route to the event's drain-side producer); `docs/internals.md` § RebalanceMonitor → **Holder evidence** (five producers) and § UnderReplicationDrain (one sentence pointing at the report); `docs/debugging.md` `under-replication-drain` row — the `report:` lines.
- Add the two tests above; run `yarn workspace @optimystic/db-p2p test` (rebuild db-core first if its source changed, since the build-freshness guard refuses a stale build), `yarn lint:docs`, and the db-p2p typecheck/build.
