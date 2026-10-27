# Offline Sync: Locally Acknowledged Transactions (Design)

**Status: stages 1 to 9 of [Implementation stages](#implementation-stages) are implemented; the
rest is a proposal.** It describes an opt-in operating
mode for the Quereus plugin in which a SQL `commit` returns once the transaction is queued on this
machine, and the plugin then commits it to the network in the background, reporting each
transaction's progress to the application until it is committed or has failed.

This document assumes [architecture.md](architecture.md), [transactions.md](transactions.md) and
[internals.md](internals.md). The neighbouring designs are [crdt-sync.md](crdt-sync.md),
[partition-healing.md](partition-healing.md) and the backlog tickets `6.5-partition-healing` and
`feat-long-lived-pend-completes-as-members-appear`; how this design relates to each is stated in
[Relation to the other designs](#relation-to-the-other-designs).

## The problem

A SQL transaction today stages its changes into the trackers of the collections it touches (a
table's main tree and each index tree), and `commit` pushes them to the network:
`TransactionBridge.commitTransaction` in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts` runs the legacy path
(`commitDirtyTreesLegacy`, which pends every tree before committing any through `commitBatchLegacy`)
or session mode (`commitSession`). If a quorum of the cohort is not reachable, the commit fails and
the transaction rolls back. The application has to keep the change itself and try again later, and
everything it reads in the meantime omits the change.

A phone, a laptop on a train, or a browser tab whose partner machines are asleep spends much of its
life in that state. What such an application wants is:

1. A `commit` that succeeds while the network cannot be reached, after which this machine reads the
   change back like any committed row.
2. Optionally, a guarantee that the queued change survives the app being killed or the device
   restarting.
3. A way to follow each such transaction until it is really committed to the network, or until it
   fails or times out, so the UI can show "pending", "saved" and "could not be saved".

## Goals

- **Opt-in, per database, at run time.** An application enters and leaves the mode explicitly. With
  the mode off and nothing queued, every commit takes exactly today's code path.
- **Read-your-writes across transactions.** A transaction queued on this machine is visible to every
  later read and transaction on this machine, which build on it.
- **One network transaction per SQL transaction.** Each queued transaction commits to the network
  atomically under its own identity, in the order it was committed locally.
- **No forks.** A queued transaction never reaches storage other than through an ordinary commit to
  its cohort. The design adds no way for this machine to commit alone what it would otherwise have
  been refused.
- **Honest failure.** A queued transaction that the network refuses is removed from the local view,
  along with nothing else it does not depend on, and the application is told which one, why, and
  what else changed as a consequence.
- **Optional local persistence**, with a write-ahead rule that makes resubmission after a crash
  idempotent.
- **Platform-neutral.** The queue mechanics live in `db-core`, which stays network-free; persistence
  goes through the existing `IKVStore` port that every storage package already implements.

## Non-goals

- **Merging divergent histories.** Nothing here lets two machines commit conflicting changes and
  reconcile afterwards. That is [crdt-sync.md](crdt-sync.md) and
  [partition-healing.md](partition-healing.md). This design is the client-side outbox those
  documents name as the part that lands on today's strict system
  ([partition-healing.md §Subset That Lands on Today's Strict-CP Optimystic](partition-healing.md#subset-that-lands-on-todays-strict-cp-optimystic),
  item 5).
- **Completing a commit without a simultaneously reachable quorum.** A group of rarely-online phones
  whose members never overlap still cannot commit; letting promises accumulate across contacts is
  `feat-long-lived-pend-completes-as-members-appear`. The queue's interface is designed so that
  submission mechanism can replace the one here without changing what the application sees.
- **Queued DDL.** Schema changes keep their current path; see [Schema changes](#schema-changes).
- **Session mode in the first stages.** See [Session mode](#session-mode).

## Terms

| Term | Meaning |
|------|---------|
| **Local acknowledgement** | `commit` resolves once the transaction is queued (and journaled, when persistence is on). |
| **Network acknowledgement** | `commit` resolves once the transaction is committed to the network: today's behaviour. |
| **Offline mode** | The plugin state in which new transactions get local acknowledgement. |
| **Queued transaction** (entry) | One locally committed SQL transaction awaiting, or undergoing, its network commit. Identified by the `StampId()` its transaction returned. |
| **Queue** | The ordered list of entries for one `Database`. Entries drain in local commit order. |
| **Segment** | The run of staged actions one entry contributed to one collection. An entry has one segment per collection it wrote. |
| **Open segment** | The actions the currently open SQL transaction has staged into a collection. Not yet part of any entry. |
| **Drain** | Submitting the head entry to the network and applying the outcome locally. |
| **Rebase** | Re-applying an entry's actions over committed state newer than the state they were staged on. |

## What an application is promised

**A local acknowledgement is a promise to try, not a promise that the network will accept.** It
means:

- The transaction's changes are applied to this machine's view of every table it wrote, and every
  later read and transaction on this machine sees them.
- When persistence is on, the transaction survives a crash or restart of this process from the
  moment `commit` resolves.
- The plugin will submit the transaction to the network, under the same transaction id, as soon as
  every earlier queued transaction has been settled and the cohort can be reached.
- The transaction ends in exactly one terminal status: **committed** (with the same durability
  report an online commit produces today), or **failed** (with a typed reason). Until then it is
  **queued** or **submitting**.
- A failed transaction's changes are removed from this machine's view, and every later queued
  transaction is re-applied without them. A later transaction whose own checks no longer pass
  without them fails too, and is reported as failing because of the earlier one.
- A transaction is never committed twice, including across a crash between the network commit and
  the queue noticing it.

What it does not promise: that the transaction will commit, or that it will commit with exactly the
effect it had locally beyond what the rebase rules in
[What is re-judged when an entry is rebased](#what-is-re-judged-when-an-entry-is-rebased) state.

### Entry lifecycle

```
                     commit (local ack)
                           │
                           ▼
   ┌──────────────────── queued ◀──────────────────────────┐
   │                       │  head of queue,               │ transient failure,
   │ discard / expire /    │  cohort reachable             │ nothing landed
   │ an earlier entry's    ▼                               │ (backoff)
   │ removal makes   ┌─ submitting ──────────────────────┐ │
   │ its checks fail │     │ (in doubt after any send)   │─┘
   │                 │     │                             │
   │                 │     ▼                             ▼
   │                 │  committed              partially-committed
   │                 │  (terminal)              │ (keeps driving the
   │                 │                          │  uncommitted part)
   │                 ▼                          ▼
   └────────────▶ failed ◀───────────── refused permanently
                  (terminal)
```

`committed` is followed, as today, by `onCommitFullyHeld` when the commit reached only part of its
cohort and this machine owes the missing copies.

## Application interface

The members below exist, under `plugin.offline` (`OfflineMode` in `packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-mode.ts`), except where a later stage is named: those are still proposed.

### Registration

```typescript
const plugin = register(db, {
  default_transactor: 'network',
  offline: {
    // Persist queued transactions. An IKVStore, or a factory for one (called once, inside register).
    // Absent: the queue lives in memory and a crash loses whatever was queued.
    journal: () => new FileKVStore(path.join(dataDir, 'offline')),
    // The journal's records are keyed under optimystic-offline/<journalLabel>/. Needed only when
    // several Databases share one store: each then takes its own (see "Which store"). Default 'default'.
    journalLabel: 'main',
    // How long an entry may stay unsettled before it fails with reason 'expired'. Default: no limit.
    expireAfterMs: 7 * 24 * 3600_000,
    // How long a terminal outcome stays queryable after a restart (see "Outcomes after a restart").
    outcomeRetentionMs: 7 * 24 * 3600_000,
    // Let a drain commit alone while this node knows of absent cohort members. Default: false — a
    // queued entry is committed only by a commit its cohort reached consensus on.
    allowSoloCommit: false,
    // How long a network-acknowledged commit made while entries are queued waits behind them (see
    // "Network acknowledgement behind a non-empty queue"). Default: five minutes.
    networkCommitTimeoutMs: 5 * 60_000,
    // Advanced: the drain's re-check timer while the cohort is unreachable or after a transient
    // failure, exponential from baseMs to maxMs (OfflineQueueOptions.recheck).
    recheck: { baseMs: 1_000, maxMs: 60_000 },
  },
});
```

`register` refuses a key under `offline` it does not know (`parseOfflineConfig` in `packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-config.ts`), so a misspelt key is an error rather than a silently different configuration, and a value of the wrong type (`allowSoloCommit` anything but a boolean, a duration anything but a positive number). `allowSoloCommit` reaches the queue as `OfflineQueueOptions.allowSoloCommit` ([When to submit](#when-to-submit-the-reachability-gate)). It also refuses a `journal` that is not shaped like an `IKVStore` (naming the methods it lacks), and a `journalLabel` given without a `journal` or with anything but lowercase letters, digits, `_` and `-` — the label is one key segment, which every store can hold, and a filesystem that ignores case would file two labels differing only in case together.

Persistence is a registration-time choice, not a per-entry one, for two reasons: entries have to be
restored before the application's first statement after a restart, which happens before any
`enter()` call; and "is this entry durable?" should have one answer per database rather than one
per entry. Each `queued` status still carries `persisted`, so a UI can say so. `journal` set to a
store that cannot flush (an `IKVStore` without `flush`) is accepted, since the interface defines
absent `flush` as "every write is already durable"; the in-memory `MemoryKVStore` is refused for
`journal`, because a journal that does not survive a restart is the no-journal configuration and
should be spelled that way.

### Entering and leaving the mode

```typescript
plugin.offline.enter();          // transactions begun from now on get local acknowledgement
plugin.offline.exit();           // transactions begun from now on get network acknowledgement
await plugin.offline.whenDrained(); // resolves when the queue is empty and nothing journaled is left to put back (or rejects on dispose)
```

The acknowledgement a transaction gets is fixed when it **begins** (at `TransactionBridge.beginTransaction`),
not when it commits, so a mode change during an open transaction changes nothing about it.
Leaving the mode does not stop the drain: entries already queued keep draining, and a
network-acknowledged transaction committed while entries are queued waits behind them (see
[Network acknowledgement behind a non-empty queue](#network-acknowledgement-behind-a-non-empty-queue)).

### Following transactions

```typescript
const off = plugin.offline.onStatus(status => {
  switch (status.kind) {
    case 'queued':     ui.mark(status.transactionId, 'pending');       break;
    case 'submitting': ui.mark(status.transactionId, 'sending');       break;
    case 'committed':  ui.mark(status.transactionId,
                         status.durability.overall !== undefined && isFullyDurable(status.durability.overall)
                           ? 'saved' : 'saved, replicating');          break;
    case 'partially-committed': ui.mark(status.transactionId, 'sending'); break;
    case 'failed':     ui.fail(status.transactionId, status.reason, status.error, status.causedBy); break;
  }
});
```

Status shape (`QueuedTransactionStatus` in `packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-status.ts`; `outlook` and `outlook-changed` are stage 7's):

```typescript
type QueuedTransactionStatus =
  | { kind: 'queued'; transactionId: string; seq: number; tables: readonly string[]; queuedAt: number;
      attempts: number; inDoubt: boolean; lastError?: unknown; committedTables?: readonly string[];
      persisted: boolean; waitingFor: 'earlier-entry' | 'cohort' | 'backoff' | 'restore' | undefined;
      outlook?: CommitOutlook }        // absent while waitingFor is 'restore' (and on a logged defect)
  | { kind: 'outlook-changed'; transactionId: string; outlook: CommitOutlook }   // its outlook's kind changed
  | { kind: 'submitting'; transactionId: string; attempt: number }
  | { kind: 'committed'; transactionId: string; durability: TransactionDurability;
      tables: ReadonlyMap<string, WriteDurability | undefined>; followed: boolean;
      effect: 'applied' | 'already-applied' }                 // i.e. { kind: 'committed' } & SqlCommitDurability
  | { kind: 'partially-committed'; transactionId: string; committedTables: readonly string[];
      pendingTables: readonly string[]; cause: Error }
  | { kind: 'failed'; transactionId: string; reason: QueuedFailureReason; error: Error;
      causedBy?: string; changedTables: readonly string[]; committedTables?: readonly string[] };

type QueuedFailureReason =
  | 'constraint'               // a UNIQUE / PRIMARY KEY refusal on rebase (ConstraintError)
  | 'concurrent-modification'  // the row an UPDATE/DELETE read was changed or removed (ConcurrentModificationError)
  | 'rejected'                 // a validator refused the transaction as invalid
  | 'too-large'                // the transaction, or a block it writes, is over the size limit
  | 'expired'                  // expireAfterMs passed before it settled
  | 'discarded';               // the application called discard()
```

- The `committed` status carries the same fields as `SqlCommitDurability` (and `onCommitDurability`
  listeners still receive the report), so a host that already handles online commits handles drained
  ones with the same code. One property of today's report does not carry over: an online report
  arrives during the `db.exec` that committed, and a drained one does not. The `transactionId` is
  the only attribution.
- `effect` on `committed` says what the drain did to the rows: `'already-applied'` when every
  element whose guard could accept a rival's identical change was skipped because another machine
  had already made exactly that change, and at least one was; `'applied'` otherwise — a transaction
  with no such element, and one of which only part was already made, since a host reading
  `'already-applied'` as "none of my changes landed" must be right. See
  [Guards that make idempotent writes assured](#guards-that-make-idempotent-writes-assured).
- `queued` is delivered before `commit` resolves — inside the enqueue, once the journal holds the
  entry record when persistence is on — by the same rule `onCommitDurability` uses today, so a host
  wrapping `db.exec` can attribute it to the call — which is how an autocommit statement's caller
  learns the id it never selected with `StampId()`.
- `error` on `failed` is the error an online commit would have thrown for the same refusal, after
  `TransactionBridge.mapCommitRefusal` (so `ConstraintError` with the `UNIQUE constraint failed: …`
  message, or `ConcurrentModificationError`), with the db-core refusal reachable through `cause`.
- `causedBy` names the earlier entry whose removal made this one fail
  (see [Removing an entry](#removing-an-entry)).
- `outlook` says whether anything another writer does can make the entry fail, and if so what; an
  application uses it to decide whether a pending change needs the user's attention or only a
  progress indicator. See [Predicting whether an entry will commit](#predicting-whether-an-entry-will-commit).
  It is present on every entry the queue holds and absent while `waitingFor` is `'restore'`:
  a transaction not back in the queue cannot be judged, and its first `queued` status after the
  restore puts it back carries one. `QueuedTransaction.status` carries it the same way. The one
  other absence is a defect: a judgement that throws is logged (`offline:outlook-unjudged`) and the
  status is delivered without an outlook rather than withheld, and the entry's next `queued` status
  judges it again. Its `dependsOn` and `kind` are kept current as earlier entries settle, and what
  `status` and `entries` answer is the current outlook (see [The outlook](#the-outlook)).
- `outlook-changed` is delivered when an entry's outlook changes `kind` — an entry exposed only
  through `dependsOn` becoming assured once those entries commit — after the status of the entry
  whose settling changed it, and never terminal. A `dependsOn` that only narrows is not announced.
- `committedTables` on `failed` is set only when part of the transaction committed and the rest was
  then refused permanently; see [Partial commits](#partial-commits).
- `waitingFor: 'restore'` is the plugin's own state, absent from the db-core queue: the transaction is
  in the journal but not yet back in the queue after a restart, because a table it wrote cannot be
  reached or is not declared; see [Restore after a restart](#restore-after-a-restart).

The db-core queue (stage 3; `EntryStatus` in `packages/db-core/src/offline/status.ts`) reports the
same shapes with collection ids in place of tables and `entryId` in place of `transactionId`:
`collections` on `queued`, `committedCollections` and `pendingCollections` on `partially-committed`,
`committedCollections` on `failed` (and on `queued` once part of the entry has committed), and on
`failed` also `changedCollections`, the collections whose visible content the removal changed. It adds
what the drain knows about the attempts (`attempts`, `inDoubt`, `lastError` on `queued`), which the
plugin passes through, and `effect` on `committed` (`CommittedEffect` in
`packages/db-core/src/offline/status.ts`), passed through too. It carries no `outlook`: judging a
guard needs the catalog's tags and the tables' key decoding, which only the plugin has, so the
outlook is the plugin's own. `followed`, the per-table `tables` map and `changedTables` landed with
stage 4, `persisted` (on `queued`, and on each item `entries()` lists) and the `'restore'` waiting
state with stage 5, `outlook` on `queued` and the `outlook-changed` status with stage 7, and `effect`
with stage 10.

Queue-wide state, for a status bar:

```typescript
plugin.offline.onQueueState(state => …);   // and plugin.offline.queueState() for the current value
type OfflineModeState = OfflineQueueState & {   // db-core's queue state: depth, oldestQueuedAt, draining,
  mode: 'offline' | 'online';                   //   waitingFor ('cohort' | 'backoff' | undefined), unclassifiedFailures
  readsServedLocally: boolean;   // the last live read was served from this machine's own view (see "Reads")
  assuredFailures: number;       // assured entries that failed anyway (see "Conservative by construction")
};
```

### Queries and actions

```typescript
plugin.offline.entries();                 // the queued entries, in order, with their current status, then any journaled ones not yet put back
plugin.offline.status(transactionId);     // one entry's status, or a retained outcome, or undefined
plugin.offline.discard(transactionId);    // withdraw a queued (never sent) entry; fails it with 'discarded'
plugin.offline.outcomes();                // terminal outcomes retained (outcomeRetentionMs) and not yet acknowledged
plugin.offline.acknowledge(transactionId);// forget a retained outcome
plugin.offline.restore();                 // put the journaled entries back; what hydrate runs (see "Restore after a restart")
```

`discard` refuses an entry that has been sent at least once, because the plugin can no longer say
whether it landed; see [Identity across attempts](#identity-across-attempts). A journaled entry not
yet put back after a restart is discarded the same way, with the same refusal when a drive record
was written for it (see [Restore after a restart](#restore-after-a-restart)).

A read-only virtual table, `optimystic_queue`, would list the same entries (`transaction_id`, `seq`,
`status`, `tables`, `queued_at`, `attempts`, `last_error`) for applications that live in SQL. It is
convenience, not a separate source of truth, and stage 4 did not include it: it is backlog
`feat-offline-sync-queue-virtual-table`.

### Per-table policy

Not every table should accept a local answer. The motivating case is a revocation table: a node
that answers from its own copy while the revocation has not reached it admits a peer it should
refuse (see backlog `a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`). A
table tag selects the policy, saved in the catalog record like every other tag:

```sql
create table Revocation (…) using optimystic('tree://app/revocation')
  with tags ("optimystic.offline" = 'network');
```

| `optimystic.offline` | Writes | Live reads in offline mode while the cohort is unreachable |
|---|---|---|
| `'queue'` (default) | A transaction gets the mode's acknowledgement. | Served from this machine's view (see [Reads](#reads-in-offline-mode)). |
| `'network'` | A transaction that writes this table gets network acknowledgement, whatever the mode. | Fail as today, with `BlockUnavailableError`. |

A transaction that writes any `'network'` table gets network acknowledgement for the whole
transaction, since it commits atomically.

The vtab reads the tag from the declaration and from every `table_modified` (so `alter table … set
tags` applies to the next transaction that commits, and to the next live read) and publishes it to
the controller, beside its transactor's reachability gate (`OfflineMode.setTablePolicy`, withdrawn
on drop); `TransactionBridge.offlineRoute` asks it at commit, for every table behind the
transaction's staged collections, and a live read asks it before refreshing. The policy only ever
demotes a local acknowledgement to a network one. A tag value other than the two reads as `'queue'`
and is logged once per table (`offline:unknown-policy-tag`): Quereus applies a tag change to its own
catalog before the module hears of it, so it cannot be refused.

## Where the queue lives: segments in the collections

The queue is kept **in the collections themselves**, as an extension of the staged-action list each
`Collection` already maintains, rather than as an overlay above them.

A `Collection` already holds an ordered list of staged actions (`getPendingActions` in
`packages/db-core/src/collection/collection.ts`) and re-applies them over newly adopted committed
state on every refresh that moves the revision (`replayActions` in the same file, reached from
`updateInternal`). The trackers layer those actions over fetched blocks, which is what every read
through the collection sees. That is most of what a queue needs:

- **Read-your-writes** is what the tracker already provides for staged actions.
- **Rebase** is what the replay already does: a refresh that adopts a rival's commit replays the
  staged actions over it, and the entry guards on each action re-make the uniqueness and lost-update
  decisions against the newest state
  ([internals.md §Conflict replay re-makes the uniqueness decision](internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards)).
- **A collection this machine invented** (`Collection.createOrOpen` found no header and staged one)
  carries its header in the tracker. Rebasing by actions, rather than by transforms, is what lets a
  drain discover that the collection exists elsewhere and replay the entry's actions onto it instead
  of committing a second header under the same id; see [Invented collections](#invented-collections).

An overlay outside the collections would have to reimplement all three, and keep a second copy of
the staged state consistent with the first.

### The segment model

Each collection's staged actions are split into an ordered list of **sealed segments**, one per
queued entry that wrote the collection, followed by the **open segment** of the current SQL
transaction:

```
collection C1 (main tree):   [ seg E1 ][ seg E2 ][ seg E4 ][ open ]
collection C2 (index tree):  [ seg E2 ][ seg E3 ][ open ]
queue:                        E1, E2, E3, E4
```

The `Collection` additions (the list itself is `SegmentList` in
`packages/db-core/src/collection/segments.ts`):

- `sealPending(entryId)` — closes the open segment into a sealed segment owned by `entryId`. Answers
  `false` and changes nothing for a collection the transaction staged nothing into.
- `sealedEntries()` — the entry ids of the sealed segments, in order, refused ones included until
  they are dropped.
- `sealedRefusal(entryId)` — the refusal a replay recorded for a segment it excluded, if any (see
  [Replay with a per-segment refusal](#replay-with-a-per-segment-refusal)).
- `dropSealed(entryId)` — removes a segment, wherever it sits, and rebuilds the tracker by replaying
  what remains.
- `onSealedRefused`, a callback in `CollectionInitOptions` — how the collection reports a refused
  segment to the queue.
- `commitHead(entryId, options)` — commits exactly the head segment as one log entry, under the
  action id and timestamp `options` supplies (`HeadCommitOptions` in
  `packages/db-core/src/collection/struct.ts`, which also takes the retry bounds of `SyncOptions`).
  It answers what `sync` answers — who holds the commit — or `undefined` when its refresh found the
  write already saved under that action id and consumed the segment without re-sending. For an entry
  that wrote one collection; multi-collection entries go through the coordinator, below.

The whole-collection commits — `sync`, `updateAndSync`, `actAndSync`, and the coordinator's append
through `getPendingActions` — refuse with `SealedSegmentsError` (in
`packages/db-core/src/collection/struct.ts`) while any segment is sealed: each commits everything
staged as one log entry under one action id, which over sealed segments would merge several queue
entries into one (see [Identity across attempts](#identity-across-attempts)). A sealed segment is
committed only through `commitHead` or the coordinator's per-entry slice.

Three invariants, each checked by the queue:

1. **Order.** In every collection, sealed segments appear in queue order. This holds by construction:
   segments are sealed at local commit time, which is queue order.
2. **Head alignment.** The head segment of every collection belongs to the oldest unsettled entry
   that wrote that collection. Since the drain settles entries strictly in queue order (see
   [Draining](#draining)), the entry being drained is the head in every collection it wrote.
3. **One entry, one action list per collection.** A segment's actions are exactly the actions that
   entry's SQL transaction staged into that collection, in staging order.

### Rollback and savepoints only touch the open segment

`TransactionBridge.markDirty` captures each tree's staged state at its first stage of a transaction
(`Collection.snapshotPending`), and a rollback restores it (`Collection.restorePending`). Legacy
savepoints do the same per depth (`TransactionBridge.createSavepoint`). With a background drain, the
sealed segments can change while a SQL transaction is open: the drain commits the head segment and
removes it, or a refusal removes another. A snapshot that captured the sealed segments and was later
restored would put a drained entry back into the staged list, and the next sync would commit it a
second time.

So snapshots and savepoints become **open-segment only**: a snapshot records the open segment's
actions and transforms, and a restore rebuilds the tracker from the sealed segments as they are
**now** plus the restored open segment. When nothing sealed has changed since the capture, the
restore reinstates the captured transforms verbatim, as it does today (which keeps an invented
collection's header, a case `restorePending` already documents). When something has, the restore
replays: sealed segments in order, then the open segment's restored actions. A restore across a
moved committed boundary replays too while any segment is sealed: the empty reset that case took
before segments would drop the sealed segments' effects, and a verbatim restore would reinstate them
at the old boundary. A refusal of the open segment in that replay propagates out of the restore, as
it would out of a refresh's replay, so the restore is asynchronous and every caller awaits it, and a
rollback restores every other collection before it propagates that throw (the arm table is in
[internals.md §Staged actions are segments](internals.md#staged-actions-are-segments)).

The committed read view (`Tree.readView`) keeps working unchanged: the view is a point-in-time
tracker seeded with the transforms captured at `markDirty`, which include the sealed segments, so a
`committed.<Table>` read inside a transaction sees every queued entry the SQL layer was told had
committed — which is what "committed" means to that layer.

### Replay with a per-segment refusal

Today a guard refusal during replay throws out of the refresh, and the bridge rolls the whole
transaction back. With segments, a refusal in a sealed segment is a statement about that one entry
and must not take down the read or the open transaction that triggered the refresh. Replay becomes
segment-aware:

- An `ActionRefusedError` (in `packages/db-core/src/collection/struct.ts`; `TreeGuardRefusedError`
  in `packages/db-core/src/collections/tree/struct.ts` is the tree's subclass) raised while
  replaying sealed segment `E` excludes `E`'s actions from the replay, records the refusal on the
  segment (`sealedRefusal(E)`), and continues with the next segment. Each sealed segment is staged
  as one atomic unit, so a refusal of any of its actions leaves none of them staged. The collection
  reports `(E, error)` to the queue, once, through the `onSealedRefused` callback it is constructed
  with; a refused segment is skipped by every later replay until the queue drops it.
- A refusal in the open segment keeps today's behaviour: it is the live transaction's own refusal,
  and it surfaces through the refresh as it does now (the "a live read inside a doomed transaction"
  note in `runQuery` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`).

On receiving a refusal for `E` from one collection, the queue fails `E` and drops `E`'s segments
from every other collection it wrote (an entry is atomic: an index segment whose main-table segment
was refused must not survive it), then lets each affected collection replay. A replay can then
refuse a later entry that depended on `E`, which is how a removal cascades
([Removing an entry](#removing-an-entry)).

A refusal discovered this way — by a refresh that pulled a rival's commit, before the entry was ever
submitted — is reported at once. That is the earliest moment it is known, and there is no reason to
wait for the drain to rediscover it.

## Draining

### Order: strictly first in, first out

Entries drain one at a time, in local commit order, and an entry is not submitted until every
earlier entry is settled. Two cheaper orders were considered and rejected:

- **Reordering entries that wrote disjoint collections.** Their guards cannot interfere, but the
  application's causality can: a parent row queued in one entry and a child row in a later entry
  write different collections, and committing the child first leaves a dangling reference on the
  network for as long as the parent is unsettled — permanently, if the parent then fails. Without
  read dependencies in legacy mode the queue cannot tell which disjoint entries are causally
  related, so it assumes they all are.
- **Coalescing several entries into one network transaction.** One refusal would sink every entry
  in the batch, and the entries would share one log entry and action id, losing the per-transaction
  identity the status interface is built on. See [Open questions](#open-questions) for a narrower
  form that may be worth having.

The cost is head-of-line blocking: an entry that cannot be submitted (its cohort is unreachable,
others are not) holds back every entry behind it. That is accepted for the first stages.

### When to submit: the reachability gate

The drain submits the head entry when the cohort can be reached, and otherwise waits, woken by the
connection events the `UnderReplicationDrain` in `packages/db-p2p/src/repo/under-replication-drain.ts`
already listens to (`connection:open`, `peer:identify`), by a re-check timer with backoff, and by
each new local commit. A wake also resets the timer's backoff.

"Can be reached" is asked of a port, `ICohortReachability.reachable(blockIds)` in
`packages/db-core/src/offline/reachability.ts`, with the header id and the last known log tail id of
each collection the head entry still has to commit, so an implementation resolves cohorts from routing
keys alone and never needs the network to answer whether the network can be reached. The `local`,
`test` and `mesh-test` transactors have no cohort to lose and are always reachable.

A networked node's gate is `KeyNetworkCohortReachability` in
`packages/db-p2p/src/network/cohort-reachability.ts`, which `createLibp2pNode` builds and attaches as
`node.cohortReachability`. It judges each distinct block it is asked about by the cohort `findCluster`
assembles for it now, and answers reachable only when every block's cohort passes:

- a cohort naming a member other than this node is reachable;
- an empty cohort (`no-cohort`) or a lookup that throws (`lookup-failed`) is not;
- a cohort of this node alone is reachable only when the node is genuinely alone: no serving member
  the key network remembers is missing from it (`absent-members`, from `absentCohortMembers` in
  `packages/db-p2p/src/libp2p-key-network.ts`), no configured bootstrap peer is still awaited
  (`awaiting-bootstrap`, from `awaitingBootstrapContact`, same file), and no identify exchange is in
  flight on the node (`identifying`, from `IdentifyProgress` in
  `packages/db-p2p/src/network/identify-progress.ts`). The last arm covers the moment the other two
  cannot see: a peer mid-identify is out of every cohort, and a returning partner may for that moment
  show a partial protocol list that reads as another network's.

It logs `reachability:closed`, with the reason and the block, or `reachability:open` each time its
answer changes. Two cases read reachable while the partner is in fact gone, and both end in a wait
rather than a lone commit: after a restart with persisted network state, a partner restored into FRET's
table reads as serving and sits in the cohort until FRET's liveness drops it; and FRET keeps a
long-lived peer live for up to its dead-peer grace (`maxDeadGraceMs`, five minutes by default) after it
departs. Either way the submission runs on a cohort of two, meets a promise shortfall, and the entry
waits with backoff; the cohort is not this node alone, so no lone commit is possible.

The gate's optional `onChange` is the wake. The node's gate calls its listeners after a connection
opens or a peer is identified, debounced so the identify that follows a connection is coalesced with
it (`NodeOptions.cohortReachability`, 500 ms by default, `DEFAULT_WAKE_DEBOUNCE_MS`). Only
reconnection-shaped events wake; a departure can only close the gate, which the next re-check reads.

In the plugin a gate belongs to a transactor: `CollectionFactory.getCohortReachability` in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts` hands out one gate
per transactor key, a `LateBoundCohortReachability`
(`packages/quereus-plugin-optimystic/src/optimystic-adapter/late-bound-reachability.ts`) standing in
for the gate registered for that key (`registerCohortReachability`, keyed as `registerTransactor` is)
and for the always-open gate until one is. The `network` transactor registers its node's gate when it
is built (`CollectionFactory.createNetworkTransactor`), unless a test or host registered one first; a
node a host injected without `cohortReachability` leaves the transactor always reachable. Both halves
of the stand-in are late-bound — `reachable` asks the registered gate on every call, and `onChange`
listeners are moved to each gate registered after them — so a table that took the gate before the
registration still asks and hears the registered one. Each table's vtab publishes its transactor's gate
to the controller with its policy at the start of every full initialization, before any network read,
so a table whose initialization fails because its cohort cannot be reached has published it too. The
gate the controller hands the queue (`OfflineQueueOptions.reachability`) asks the gate of every table
behind the collections it is asked about — one in practice, since an entry is one transactor's. A live
read in offline mode asks the same gate ([Reads in offline mode](#reads-in-offline-mode)).

The wake reaches the queue through the controller, not through `OfflineQueueOptions.wakeOn`:
`OfflineMode` subscribes once to each distinct gate a table publishes, and on a wake first starts a
restore pass when a journaled transaction is deferred
([Restore after a restart](#restore-after-a-restart)), then wakes the queue. The restore pass is the
reason: while the queue is empty no drain iteration asks the gate, so nothing else would retry a
deferred record when the cohort returns. `OfflineMode.dispose` releases the subscriptions first, so a
wake arriving after it is ignored. `wakeOn` remains for a queue used without the plugin.

The gate is what keeps offline mode from creating forks. Without it, a drain that runs while this
node's routing view has dropped its partners takes the solo commit path (`soloCohortDurability` in
`packages/db-p2p/src/repo/coordinator-repo.ts`) and commits alone at `local` durability — the
lone-survivor write that backlog `6.5-partition-healing` records as a source of forked collections.
The gate is a heuristic, though: the view can change between the check and the commit. The hard form
is a per-write option, `SyncOptions.refuseSoloCommit` in `packages/db-core/src/collection/struct.ts`,
that makes the solo short-circuit **refuse** the write instead of committing it `local` with the
missing members named as owed. It travels as `refuseSolo` on every pend and commit request of the
write's attempt cycle (`PendRequest.refuseSolo` and `CommitRequest.refuseSolo` in
`packages/db-core/src/network/struct.ts`), the re-send that finishes a torn attempt included, and is
omitted rather than sent as `false`, so a write that does not set it is signed exactly as before. A
coordinator whose cohort for the write is only itself refuses it for one of three reasons, decided in
one place (`soloRefusalFor` in `packages/db-p2p/src/repo/coordinator-repo.ts`):

- `absent-members`: it knows of cohort members it could not place in the cohort (`absentCohortMembers`);
- `awaiting-bootstrap`: a configured bootstrap peer has never been heard from (`awaitingBootstrapContact`);
- `unrouted`: the cohort lookup failed, named nobody, or named one peer that is not this node.

With none of them the node is genuinely alone and commits at `local` as before. The pend is refused
before anything is reserved, as a promise shortfall: `PromiseShortfallError` in
`packages/db-core/src/network/promise-shortfall-error.ts`, its `soloRefused` field naming the reason,
its `silentPeers` the members known absent — the path every shortfall already takes, so the queue sorts
it `cohort-unreachable` and the entry waits for its cohort and is retried when the members return. The
commit, which cannot answer with a shortfall, is refused conflict-shaped, with the reason prefix
`SOLO_COMMIT_REFUSED_REASON` in `packages/db-p2p/src/storage/storage-repo.ts`, before any proof is
minted or anything applied: that is reached when the pend ran on a real cohort and the partner dropped
before the commit, and the writer then cancels and retries, and the retry's pend meets the shortfall. A
refused entry stays in doubt, as after any shortfall once it has been sent (see
[Identity across attempts](#identity-across-attempts)). The coordinator logs `pend:solo-refused` and
`commit:solo-refused`, each with the reason, `knownAbsent`, `absentPeers` and `awaitingBootstrap`.

**Decision (maintainer, 2026-10-25): every drain sets the option by default.** A queued entry is
settled as `committed` only by a commit its cohort reached consensus on — never by a lone write made
while this node knows of absent members. A node that is genuinely alone (no known absent member, no
awaited bootstrap peer) is its whole cohort and still commits. An application that prefers the
lone-write behaviour opts out with `offline.allowSoloCommit: true` (`OfflineQueueOptions.allowSoloCommit`
in `packages/db-core/src/offline/queue.ts`; unless it is `true`, `OfflineQueue` sets
`refuseSoloCommit` on every submission). This does not choose a lone-write
rule for writes in general, which `6.5-partition-healing` records a decision against: writes outside
offline mode keep today's solo short-circuit. A coordinator on a build that predates the field
ignores it, so in a mixed-version group the gate is the only protection.

### One entry, one network transaction

An entry that wrote one collection commits through `commitHead`: the collection's existing sync
loop, restricted to the head segment's actions.

An entry that wrote several collections (a table and its index trees, or several tables) commits
through a per-entry coordinator, as a multi-tree legacy commit does today (`commitBatchLegacy`):
pend every collection's head segment, then commit. `TransactionCoordinator.commit` (in
`packages/db-core/src/transaction/coordinator.ts`) commits whatever each registered collection
has staged; `TransactionCoordinator.commitEntry` commits a named slice — for each collection, the
actions of one sealed segment, the entry's head — by driving the head commit's steps
(`HeadCommitHandle`) in lock-step across the entry's collections, with the whole-collection commit's
own phases and retry loop between them (see
[internals.md §Staged actions are segments](internals.md#staged-actions-are-segments)). Like
`commitHead`, it releases every participant's collection latch around the one network round trip and
retakes them, in sorted collection-id order, before applying the outcome. The existing
pend-all-then-commit ordering is what keeps a refusal at pend (the common case: a rival took the
key) from leaving any part of the entry durable.

The log entry's timestamp is the entry's local commit time, passed down where
`Collection.syncInternal` mints one today. Nothing reads `LogEntry.timestamp` for logic, and the
time the change was made is the more accurate value.

### The drain does not hold the collection latch across the network

`Collection.sync` holds the collection's latch for its whole retry loop, and `act` takes the same
latch, so nothing can be staged into a collection while it syncs. Held across a network commit that
can take seconds, that would block every SQL write in offline mode behind the drain, which defeats
the point of the mode.

So the head commit (`Collection.commitHead`) runs its attempts on a **head tracker** — the head
segment's actions alone, staged over the committed state, built once per revision the attempt
requests and reused across retries — and releases the live latch for exactly the one `await` on the
network, the pend-and-commit round trip (the `release` and `retake` steps of `HeadCommitHandle` in
`packages/db-core/src/collection/head-commit.ts`, which every driver brackets the round trip with).
Both drivers do: `Collection.commitHead` for an entry over one collection, and
`TransactionCoordinator.commitEntry`, holding one handle per participant, for an entry over several.
Everything else runs under the latch: the refresh that
opens the cycle, building the head tracker and the attempt, the refresh and backoff between
attempts, and applying the outcome (remove the head segment, fold the attempt's transforms into the
cache, adopt the revision, replay what remains). This makes live the case the `NOTE` after a
successful attempt in `Collection.syncAttempts` describes as dormant — staging that happens while a
transact is in flight — and that note's precondition holds here: the fold and the revision adoption
run **before** the replay of the remaining segments, which is the order `updateInternal` already
requires.

While the latch is released, a refresh of the same handle can walk into the head commit's own log
entry, already stored while the answer is still on its way back. Such a refresh changes nothing and
returns (logged `collection:refresh-deferred-to-head-commit`): the entry is not failed, so it is not
finished and consumed as the write's own, and it is not a stranger's, so it is not filtered and
replayed over state that already contains it. The head commit applies the outcome itself when it
retakes the latch, and the next refresh finds nothing new. A refresh that finds a rival's entry
instead proceeds as any refresh does — the attempt in flight is refused as stale, and the head
commit's own refresh adopts the rival and rebuilds the head tracker at the new revision, unless the
replay refused the head, in which case the recorded refusal is thrown in place of a retry.
`dropSealed` of the segment on the network refuses too (`SealedSegmentsError` with reason
`in-flight`); any other segment can be dropped meanwhile. The attempt machinery itself —
the per-attempt tracker and log append, the retry accounting, the refresh-until-settled loop — is
shared with `sync` (`AttemptCycle` and `stageAttempt` in
`packages/db-core/src/collection/write-attempts.ts`), so the two paths cannot drift.

### Classifying an attempt's outcome

The drain's whole job is to decide, for each failure, whether the entry should wait and retry,
settle as failed, or be resolved as possibly landed. It must decide from error **types**, never from
message text (backlog `debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text`).

| Outcome | Example | Entry becomes |
|---|---|---|
| Committed | the sync or coordinator commit returns | `committed` |
| Cohort unreachable, nothing sent | `PromiseShortfallError` (in `packages/db-core/src/network/promise-shortfall-error.ts`): too few members answered the pend; `BlockUnavailableError` (in `packages/db-core/src/network/struct.ts`) with reason `cohort-unreachable` or `peers-unreachable`; a refused solo write (a `PromiseShortfallError` whose `soloRefused` is set, above); the gate saying no | `queued`, `waitingFor: 'cohort'` |
| Contention the sync loop could not get past | `SyncRetryExhaustedError`, `SyncRevisionStalledError` (in `packages/db-core/src/collection/struct.ts`); `CoordinatorStaleLossError` (in `packages/db-core/src/transaction/errors.ts`), the coordinator's counterpart | `queued`, `waitingFor: 'backoff'` |
| Guard refusal on rebase | `TreeGuardRefusedError` and its subclasses | `failed`: `constraint` or `concurrent-modification` |
| Validity rejection | `ValidityRejectedError` (in `packages/db-core/src/network/validity-rejected-error.ts`): every member that sank the pend signed it as a judgement of the transaction | `failed`: `rejected` |
| Too large to commit | `TransactionTooLargeError` (in `packages/db-core/src/network/transaction-size.ts`), `BlockTooLargeError` (in `packages/db-core/src/network/block-size.ts`): the write can never commit as it is | `failed`: `too-large` |
| Attempt expired | `TransactionExpiredError` | `queued`; the next attempt is a new attempt with a fresh expiry |
| Torn, provably not saved | `TornActionError` (in `packages/db-core/src/collection/struct.ts`) with `final: true` | `queued`; resubmitting stores it once, which is what `final: true` promises |
| Torn, outcome unknown | `TornActionError` with `final: false` | `submitting`, in doubt; see below |
| Part of the entry committed | `CoordinatorPartialCommitError` (in `packages/db-core/src/transaction/errors.ts`) | `partially-committed`; see below |

`classifyCommitFailure` in `packages/db-core/src/transaction/commit-failure-class.ts` sorts an
error into these rows, as a `CommitFailureClass`. It follows two rules. It reads only an error's
class and its structured fields (`BlockUnavailableError.reason`, `TornActionError.final`), never its
message. And it reads only the error it is given, never its `cause`: a commit-phase shortfall still
reaches a local writer as the `cause` of the transactor's plain `Some peers did not complete`
aggregate, and that write is in doubt rather than "nothing sent", so it sorts as `unknown`. The
Quereus bridge's mapped errors are not recognised either; stage 4 classifies the db-core error it
holds before mapping it. A validator rejection reaches the writer as `ValidityRejectedError` only
when every member that sank the pend signed it as a judgement of the transaction (expiry votes
aside) and the coordinator's own storage confirms no revision loss; a validity vote beside any other
reject stays the unclassified throw it always was, since it may be a stale revision only members
ahead of the coordinator can see (see "A pend rejection is returned only when it is classified" in
[internals.md §Consensus Execution](internals.md#consensus-execution)). Anything the drain cannot
classify (`unknown`) is treated as transient, logged with the entry id, and counted, so an
unclassified failure is retried rather than silently dropping a change the application was told was
committed; it is re-sent only under the attempt's own identity (below), and `expireAfterMs` bounds
how long that can go on.

### Identity across attempts

Storage identifies a saved revision by `(action id, revision)` and accepts a retry of the same
action at the same revision (see "A write's log append is a fixed function of the write and the
revision it is requesting" in [internals.md §Consensus Execution](internals.md#consensus-execution)).
The collection already uses that to finish a half-landed write within one sync: it retains each
failed attempt (`retainInFlightAttempt`) and, when a refresh finds the attempt's own log entry,
completes and consumes it instead of replaying it (`completeOwnEntry`). The queue extends the same
rule across drain attempts and restarts:

> **An entry that has been sent is in doubt until its outcome is established, and it is re-sent
> only under the action id and revision of the attempt that may have landed.**

The queue records the attempt's identity — action id, revision, and the retained attempt itself,
one `InFlightAttempt` in `packages/db-core/src/collection/struct.ts` — **before** sending it (in
the journal, when persistence is on), and clears it only once the outcome is known. The head commit
hands it the attempt at exactly that point: `HeadCommitOptions.recordAttempt` in
`packages/db-core/src/collection/struct.ts` is called with each attempt after it is built and before
the collection latch is released for the network, and a throw out of it aborts the cycle with nothing
sent; the coordinator's per-entry commit calls its own hook the same way, with every participant's
attempt at once. The queue wraps both (`OfflineQueue.recordAttempts` in
`packages/db-core/src/offline/queue.ts`) and writes what it records to the journal's drive record
first, `IOfflineJournal.driving` in `packages/db-core/src/offline/journal.ts` — the write-ahead of
[Write ordering](#write-ordering), which a journal that cannot write refuses by throwing, so nothing
is sent. A later drain of an in-doubt entry marks that action in flight on the collection
(`beginInFlightAction`) and refreshes first, so a refresh that finds the entry's log entry completes
it instead of committing a second copy — from the recorded attempt, which the drain hands back as
`HeadCommitOptions.resume` (one collection) or `EntryCommit.resume` in
`packages/db-core/src/transaction/entry-commit.ts` (several); without it the refresh can only
recognise an attempt that landed whole, and refuses a torn one as `transforms-not-held`. The
recorded attempt is also what the cycle re-SENDS when that refresh finds nothing new: the earlier
attempt may sit on a minority of its cohort, hidden from the refresh by a coordinator lagging its
cohort, so while the revision the next attempt would request is still the recorded one, the head
commit's `stage` step sends the recorded attempt verbatim instead of building a new one, whose
freshly minted block ids would fork the log on the machines holding the first
(`resumedAttempt` in `packages/db-core/src/collection/write-attempts.ts`). The three outcomes of
that opening refresh are together what makes the rule above hold across cycles: the write's own
entry found, and finished from the recorded attempt; a rival's entry adopted, and the write rebuilt
at the higher revision, which proves the recorded attempt lost at its own; or nothing new, and the
recorded attempt re-sent.

An entry keeps **one action id for its whole life**, minted when it is queued. Re-driving under it is
always safe — storage treats a re-send at the same revision as finishing the write and one at a new
revision as a new write — and it keeps the slot hold the write earned on the members by losing. A
fresh id is minted only after `TornActionError` with `final: true`, which proves that nothing sent
under the old id is saved or will land, and which a re-drive under that id could never get past: it
would find its own stranded log entry on every refresh and be told again that a rival built past it.
A refused pend mints none. It proves only that the attempt that sent it did not land, while one cycle
sends several attempts under one action id and an earlier one may have left its log entry standing
(see `SyncRetryExhaustedError` in `packages/db-core/src/collection/struct.ts`).

**An entry in doubt neither expires nor can be discarded until its doubt resolves.** It is in doubt
from the first time the queue has recorded an attempt of it (a hook that throws aborts the cycle with
nothing sent, so it sets nothing) until a terminal outcome or a `TornActionError` with `final: true`,
and an entry part of which a partial commit landed stays in doubt until it settles. A passed
`expireAfterMs` is deferred while it is (logged `offline:expiry-deferred`), and `discard` throws
`EntryNotDiscardableError` in `packages/db-core/src/offline/status.ts`: the plugin cannot withdraw a
change it cannot rule out having already saved.

### Partial commits

A multi-collection entry whose commit landed on some collections and not others
(`CoordinatorPartialCommitError`) cannot be rolled back: the committed collections are durable.
Today the bridge latches a degraded state (`TransactionBridge.degradedReason`) and surfaces the
error. For a queued entry, finishing the transaction is the better repair, so the entry becomes
`partially-committed`: the committed collections' segments are consumed, the uncommitted
collections' segments stay at the head of their collections, and the drain keeps driving them like
any other submission. The local view stays coherent throughout (the committed part is committed,
the rest is still staged), so no degraded latch is set while the entry is being finished.

In the db-core queue (`OfflineQueue.partiallyCommitted` in `packages/db-core/src/offline/queue.ts`)
the `partially-committed` status names the committed and the pending collections and carries the
partial commit's `reason` as `cause` (the partial commit error itself when that reason is not an
`Error`, as the commit-phase reason of a hard failure is not). The entry stays at the head, in doubt, so it is neither discarded nor expired;
`entries()` lists it `queued` with its `committedCollections`. Its next submission drives only the
collections still holding its segment — through `commitHead` when one is left, through
`commitEntry` when several are — under the same action id, with their retained attempts as `resume`,
unless the rest failed with `TornActionError` and `final: true` (the coordinator reports any failure
after one collection was saved as a partial commit): then the remainder goes under a fresh id, as
under [Identity across attempts](#identity-across-attempts), and the entry's two halves are logged
under different action ids.
When the remainder commits, `committed` carries one durability over every collection the entry wrote:
the partial commit's committed half beside the remainder's answer. A second partial commit of the
remainder adds to `committedCollections` and reports `partially-committed` again.

If the remainder is refused permanently, the entry fails with `committedTables` set
(`committedCollections` in db-core, whatever triggered the failure — a refusal met by the drain or
one a reader's refresh reported between submissions), its remaining segments are dropped, the
removal cascades as any other does, and the bridge sets the degraded latch exactly as it would for
an online partial commit, because the network now holds half of a transaction. The application has
to reconcile that, as it does today ([correctness.md](correctness.md) "Partial landing").

### Removing an entry

An entry is removed when it fails (refusal, expiry, discard) and when it commits. Removal on failure
cascades:

1. Drop the entry's segments from every collection it wrote.
2. Each of those collections replays its remaining sealed segments and its open segment.
3. A later entry whose guard now refuses fails in turn, with `causedBy` set to the nearest earlier
   entry that is failing — the entry whose removal triggered the replay, or, when that one replay
   refuses several dependent entries at once, the refused entry just ahead of it — so a chain of
   dependents reads E3 ← E2 ← E1 rather than every one pointing at E1 (`OfflineQueue.causeOf` in
   `packages/db-core/src/offline/queue.ts`). It is removed by the same steps.
4. Every table whose visible rows changed is announced through `Database.notifyExternalChange`, so
   `Database.watch` subscribers re-query; the same call the reactive watch bridge already makes for
   a remote commit (`announceExternalChange` in
   `packages/quereus-plugin-optimystic/src/optimystic-adapter/external-change.ts`, shared by both).
   The tables are the ones behind the `failed` status's `changedCollections`: the collections the
   entry still had a segment in when it was removed, which for a partly committed entry excludes the
   half that committed. The plugin's controller announces each such table once, after the `failed`
   status has reached the application's listeners, so a watcher's re-query runs after the
   application has heard why (`OfflineMode` in
   `packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-mode.ts`). A cascade announces
   once per failed entry, so a table two cascading entries wrote is announced twice, which costs a
   watcher one extra re-query. A failure in the announcement is logged, never thrown into the drain.

A cascade removes only entries whose own checks fail without the removed one. An entry that merely
read the removed entry's rows (an `insert … select` that copied them, a value computed from them)
and whose guards still pass is **kept** in legacy mode, because legacy mode records no read
dependencies to tell. That is the main semantic limit of the first stages; see the next section.

The open SQL transaction is replayed in step 2 like any segment. If its own guard now refuses, the
refusal surfaces through the transaction exactly as a rival's commit would make it surface today.

## What is re-judged when an entry is rebased

In legacy mode an entry is rebased by replaying its **actions**, and an action carries the decisions
its statement made, as entry guards (see
[internals.md §Conflict replay re-makes the uniqueness decision](internals.md#conflict-replay-re-makes-the-uniqueness-decision-entry-guards)).
Those are re-judged against the newest committed state at every replay. Anything the statement
decided by reading other rows is not.

| Rule | Re-judged at rebase? | Why |
|---|---|---|
| PRIMARY KEY uniqueness of an INSERT | Yes | `absent` guard. |
| Secondary UNIQUE | Yes | `absentRange` guard on the index tree. |
| Lost update: UPDATE, DELETE, REPLACE of a row another writer changed or removed | Yes | `unchanged` guard carrying the row image the statement read. |
| Row-local CHECK (no subquery) | Effectively yes | The row the entry writes is the row it checked; the `unchanged` guard ensures the row it was computed from is still current. |
| FOREIGN KEY | **No** | The parent lives in another collection; nothing in the child's action names it. A parent deleted by another writer while the child was queued leaves a dangling child on the network. |
| CHECK with a subquery, deferred constraints, assertions | **No** | Evaluated once, against this machine's view at local commit. |
| Values computed from other rows (`insert … select`, `set x = (select …)`) | **No** | The action carries the computed value, not the computation. |

That is the same set of rules today's legacy mode re-judges when two connected writers race; offline
mode does not weaken it, but it widens the window from milliseconds to however long the machine is
offline, which makes the unprotected rows much more likely to matter. Two later stages close it:

- **Constraint re-check before submission.** Before sending an entry, re-evaluate the foreign keys
  and subquery CHECKs of the tables it wrote, for the rows it wrote, against the committed state plus
  the entry. A violation fails the entry with reason `constraint`. This needs the vtab to expose a
  per-row constraint check outside a statement, which Quereus may or may not support as-is
  ([Open questions](#open-questions)).
- **Statement re-execution** in session mode, where the statements, not the actions, are the unit;
  see [Session mode](#session-mode).

## Predicting whether an entry will commit

Most queued transactions in a typical application cannot fail: a new message with a generated id,
a new note, an edit to a draft nobody else has seen. A few can: claiming a username, editing a row
other people also edit. An application that knows which is which can show the first kind as plain
progress and reserve "this change may not go through" for the second. The plugin can tell them
apart at local commit, from two sources it already has: the guards on the actions the transaction
staged, which are exactly the checks the rebase will re-run, and Quereus's static analysis of the
statements that staged them.

### What can make an entry fail

Under the action-replay rebase, a queued entry fails for one of four reasons:

1. **Another writer's commit makes one of its guards refuse** at rebase: a rival took the same
   primary key or unique value, or changed or removed a row the entry updated or deleted.
2. **An earlier queued entry fails**, and replaying without it makes one of this entry's guards
   refuse ([Removing an entry](#removing-an-entry)).
3. **The application expires or discards it.**
4. **The network refuses this machine's write as such**: a validator rejects it as invalid, or the
   cohort refuses this peer.

Reasons 3 and 4 do not depend on what other writers do and are not predicted; reason 4 is what a
correct application on a correctly configured node does not hit. The prediction is about 1 and 2,
which are also the only reasons an application can explain to a user ("someone else edited this
note first").

### The outlook

```typescript
type CommitOutlook = {
  /** 'assured': no other writer can make this entry fail (reasons 1 and 2 above are ruled out).
   *  'exposed': some can; `exposures` and `dependsOn` say which. */
  kind: 'assured' | 'exposed';
  /** What another writer would have to do for a guard to refuse at rebase. Empty when assured. */
  exposures: readonly Exposure[];
  /** Earlier unsettled entries whose failure would fail this one, or change what it means; an entry
   *  depended on both ways is listed once, as 'guard'. */
  dependsOn: readonly { transactionId: string; via: 'guard' | 'unchecked' }[];
  /** Decisions made against rows nothing re-checks at rebase. Independent of `kind`: they do not
   *  make the entry fail, they can make it commit with a decision a fresh evaluation would refuse.
   *  'not-computed' when the analysis had no description of what a statement read: a statement of
   *  the entry was undescribed (an FK cascade child write). (An entry restored from a journal record
   *  written before the facts were journaled has none either.) A string rather than an absent
   *  field, because `CommitOutlook()` renders this as JSON, where an absent key would be ambiguous. */
  unchecked: readonly UncheckedDecision[] | 'not-computed';
};

type Exposure = {
  table: string;                              // schema.table
  rule: 'primary-key' | 'unique' | 'row';     // the guard: absent, absentRange, unchanged
  key: readonly SqlValue[] | undefined;       // the contended key, when known
  columns?: readonly string[];                // for 'unique': the constraint's columns
};

type UncheckedDecision = {
  table: string;                              // the table read (for a cross-row CHECK, the one written)
  kind: 'foreign-key' | 'check' | 'assertion' | 'read' | 'row-selection';
  scope: 'row' | 'group' | 'global';          // Quereus's binding mode for that read
};
```

The outlook is computed at local commit and delivered on the `queued` status, so it is in hand
before `commit` resolves. More exactly, it is computed when the queue emits the entry's first
`queued` status — inside the enqueue, after sealing, or inside the restore after a restart that
puts the entry back — from the sealed segments, and the controller holds it per transaction id until
the entry settles. The entry's own judgement (its exposures, below, and what each of its guards
covers) is fixed then and never recomputed: a tag changed later does not re-judge it. The judgement
itself is not journaled, but what it is made from is: the sealed segments, and the facts the
statements' write descriptions recorded ([What is journaled](#what-is-journaled)). A restart judges a
restored entry again from those, against the entries restored before it, and so gives it the outlook
it had, with one widening: a `row` read comes back without the rows it pinned, and is matched by its
table.

The rest follows the queue. After every status that changes what is queued — an entry committed,
partly committed or failed, or one a restore put back ahead of others — the controller walks the
queue in order (`followOutlooks` in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/commit-outlook.ts`). For each entry it
drops the exposures and guards in collections a partial commit has committed, since those have
passed; computes `dependsOn` again, by the rule in [Dependencies between
entries](#dependencies-between-entries), against the entries ahead of it as they are now and the
deferred records numbered below it; and derives `kind` from both, each dependency's kind being the
one computed earlier in the same walk. An entry whose segment a replay has already refused keeps its
outlook: it is about to fail, and the failure reports it. The walk waits while an entry that has left
the queue has not had its terminal status yet, since its segments may still be dropping, and runs at
that status.

So the outlook changes in one direction only while the entry is queued: an entry that was exposed
only through `dependsOn` becomes assured when those entries commit, and gets an `outlook-changed`
status, delivered after the status of the entry whose commit changed it. Nothing makes an assured
entry exposed later, because its own guards and its position in the queue do not change, with one
exception the host contract rules out: an entry committed before `hydrate` (or `offline.restore`)
read the journal can find a journaled transaction put back ahead of it, a dependency it was judged
without. That change is delivered like any other and logged as `offline:outlook-regressed`; an
outlook the queue contradicts is never kept. `outlook-changed` is delivered only when `kind`
changes: a `dependsOn` that narrows while the entry stays assured, or stays exposed, is read from
`status` and `entries`. A rival commit that refuses an exposed entry's guard is not a change of
outlook but a failure, and is reported as one.

`kind` answers "will it go in". `unchecked` answers a different question — "could it go in wrong" —
and is kept apart on purpose: a message that references a conversation another machine might
delete is certain to commit and may commit dangling. Once the constraint re-check stage lands, an
unchecked foreign key or CHECK can fail the entry, and it moves from `unchecked` to `exposures`; the
outlook is derived from the rebase rules in force, never maintained beside them.

Suggested presentation, which is the application's choice: show an assured entry as progress only
("syncing"), an exposed one as pending with the exposure available for a "why", and treat a
non-empty `unchecked` according to how much the application cares about the rules involved.

### Judging each guard

The entry is assured exactly when no guard it carries can be refused by another writer and nothing
it depends on can fail. Each guard is judged from the action that carries it and from what the
analysis can prove about where its values came from:

| Guard (statement) | Another writer can refuse it by… | Not refusable by another writer when… |
|---|---|---|
| `absent` (INSERT) | inserting the same primary key. | every key value is **fresh**: see below. |
| `absentRange` (secondary UNIQUE) | inserting a row with the same unique value. | the unique value is fresh. |
| `unchanged` (UPDATE, DELETE, REPLACE over an existing row, eviction) | changing or deleting that row. | the row was inserted under a fresh key by an earlier entry of this queue that has not been committed — no other machine has seen the key — or the table is declared single-writer. |
| `absentOrEqual`, `unchangedOrEqual`, `unchangedOrAbsent` (the already-applied variants, [Guards that make idempotent writes assured](#guards-that-make-idempotent-writes-assured)) | as the base kind — but not by making exactly this entry's change: inserting the same row, leaving the row equal to this entry's result, deleting the row this entry deletes. | as the base kind; the exposure carries `tolerates: 'same-change'`. |
| none (index trees) | — | always; an index segment is never refused on its own. |

A key or unique value is **fresh** when no other writer can produce it. The plugin learns this from
two sources and reasons no further:

- **The write description's provenance** (see [What the analysis needs from
  Quereus](#what-the-analysis-needs-from-quereus)): a column Quereus labels `fresh` is fresh. That is
  `StampId()`, which the plugin registers with `FunctionFlags.FRESH` — a hash of this peer's id beside
  16 random bytes, so no other machine can produce it, though every call inside one transaction
  answers the same value — any function another plugin registers `fresh: true`, and the builtin
  `randomblob(n)` with a literal `n ≥ 16`; each bare, or under one of the injective wrappers Quereus
  recognises (`hex`, `lower`, `upper`, `cast`, `||` against a literal; only `hex` keeps a blob fresh),
  so `hex(randomblob(16))` is the fresh spelling of a random text key. Anything else is not:
  `substr(StampId(), 1, 8)`, `random()`'s 64 bits, and the crypto plugin's `random_bytes(bits,
  encoding)`, whose width is an argument and so cannot be promised (backlog
  `feat-crypto-plugin-offers-a-fresh-id-function`).
- **A tag**: the value is supplied by a parameter or a context variable, and the column is declared
  fresh by `"optimystic.fresh" = true` because the application generates it itself — see
  [Declared hints](#declared-hints).
- For a composite key, any one column fresh makes the key fresh; a unique value is fresh when any of
  its constraint's columns is.

Two refinements matter in practice:

- **An edit of a row created offline is assured.** A note created under a fresh key and edited ten
  times before the device reconnects queues one insert and ten updates; the updates' `unchanged`
  guards protect a row no other machine can know about until the insert commits. The residual is
  the moment between the insert's commit and the next entry's: entries drain back to back, so a
  rival would have to read the new row and write it within one drain step. The outlook reports such
  an entry as assured and the residual is stated here rather than hidden in the type.
- **A natural key is exposed even when it is unlikely to collide.** The prediction does not
  estimate probabilities; a username, an email address or a date-keyed row is exposed, with the key
  in `exposures`, and the application decides how to present that.

The judgement is one pass over the entry's elements, collection by collection in the order the entry
sealed them and in staging order within each (`judgeTransaction` in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/commit-outlook.ts`), one exposure per
guard that can be refused:

- **A guard covered by an earlier write of the same entry is not judged.** When an earlier element of
  the entry, in the same collection, wrote exactly the same key under an `absent` or `unchanged`
  guard, any rival change that would refuse the later guard refuses that earlier one first. So
  "insert under a fresh key, then update it, in one transaction" is assured, and "insert under a
  natural key, then update it" carries one exposure, the insert's. Only an exact-key `absent` or
  `unchanged` covers: an unguarded earlier write (an index-tree delete) covers nothing, and an
  `absentRange` is never covered, since a rival taking the value under another key refuses it
  without touching the earlier element's key.
- **The table knowledge comes from each table.** Each vtab publishes, beside its offline policy, a
  description of its collections (`TableOutlookSource`): which is the main tree (with its key
  decoder, and whether a primary-key column is tagged fresh), which index trees enforce a UNIQUE
  constraint (with the constraint's columns, whether one of them is tagged fresh, and a value
  decoder), and which are other index trees. It reads the live schema at call time, so a tag change
  needs no re-publication. Tags are read `=== true`, the rule `optimystic.network_watch` is read by.
- **The provenance knowledge comes from the statements, as they stage.** Each vtab opts into the
  write description (`wantWriteScope`) and, after each `update()` arm's last stage, records which of
  the elements it staged carry a fresh value (`freshElementsOf` in
  `packages/quereus-plugin-optimystic/src/optimystic-adapter/write-description.ts`): the main-tree
  entry when a primary-key column is labelled fresh, and the entry in each UNIQUE-enforcing index
  tree the row binds when one of the constraint's columns is, keyed exactly as the guarded entry is
  staged. The bridge keeps the records with the transaction (`TransactionBridge.noteWriteFacts` in
  `packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`) and folds them at commit
  into the entry's facts (`EntryFacts`, per collection the fresh elements' keys), which the judgement
  reads beside the tags: an `absent` or `absentRange` whose element the facts list is not exposed,
  and an `unchanged` on a row an earlier queued entry inserted under a key that entry's facts list is
  not either. The records follow savepoints: the bridge notes how many there were when a savepoint
  was created and truncates to that on a rollback to it, and Quereus wraps every DML statement in
  one, so a failed statement leaves no record and a rolled-back statement's fresh key is never
  credited to a later statement that supplies it as a literal. A cascade child write carries no
  description and records nothing; the upsert `DO UPDATE` arm receives the INSERT's description and
  records nothing. The facts are held in memory with the judgement and journaled in the entry
  record, so a transaction restored after a restart is judged with them ([What is
  journaled](#what-is-journaled)).
- **Exposures name what a user can recognise.** `absent` reports `rule: 'primary-key'` with the
  decoded primary key; `absentRange` reports `rule: 'unique'` with the constraint's columns and the
  unique value decoded from the range's lower bound (`decodeIndexKey` in
  `packages/quereus-plugin-optimystic/src/schema/index-manager.ts`); `unchanged` reports `rule:
  'row'` with the decoded primary key. An exposure from one of the already-applied variants is the
  base kind's with `tolerates: 'same-change'` beside it: `kind` stays `exposed`, since a rival can
  still make a different change, and the field is what says a rival making the same one does not
  refuse it.
- **Anything the analysis cannot read is exposed** (see [Conservative by
  construction](#conservative-by-construction)): an unknown guard kind, an action that is not a tree
  `replace`, a guard in a collection no table describes, a guard of a kind its collection does not
  carry, a segment that cannot be read, a key that does not decode. Each is reported as `rule: 'row'`
  with no key, under the collection's table name when one is known and its collection id otherwise.

### Unchecked decisions

The rows a statement read to make its decision, other than the target row its guard protects, are
what the analysis reports as `unchecked`. They are read from the statement's write description
(`uncheckedOf` in `packages/quereus-plugin-optimystic/src/optimystic-adapter/write-description.ts`):
its target selection, its constraints and its read watches, each decision kept with the table as
Quereus names it and, for a read pinned to rows, the bound values. The vtab records them once per
described statement — the engine hands one description object per execution, shared by every row's
`update()`, so the object identifies the statement — ahead of every arm's staging, through
`TransactionBridge.noteWriteDescription` in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts`, which keeps them beside the
fresh-element facts under the same savepoint rule. A write the engine does not describe — an FK
cascade child write — is recorded as undescribed, and the entry's `unchecked` is then
`'not-computed'`: a partial list would read as a complete one.

| From the description | Decision |
|---|---|
| An UPDATE or DELETE whose `selection` is `global`: rows chosen by anything but a unique-key equality (`where status = 'open'`) | `row-selection` on the target, `global` |
| Each `foreign-key-child` constraint (an INSERT, or an UPDATE of a foreign-key column) | `foreign-key` on the parent it references, with the scope of the read watch on that table when one is listed — whole-table today, a known imprecision of Quereus's analysis — else `global`; that watch is consumed |
| Each `foreign-key-parent` constraint (a DELETE, or an UPDATE of a referenced column) | `foreign-key` on the child it references, `global` |
| Each `assertion` constraint | `assertion` on the table it references (the target when it names none), `global` |
| Each `check` constraint of `cross-row` locality (a subquery, or a committed-state reference) | `check` on the **written** table, `global` |
| Each remaining read watch | `read` on the watch's table, scoped by its binding mode |
| `primary-key`, `unique`, `not-null`, a row-local `check` | nothing: the first two are guards, the rest are decided from the row alone |

`row-selection` is the phantom case: a rival's new matching row will not be touched, because the
action names the rows chosen locally. `scope` maps Quereus's four binding modes onto three: `full` is
`global`; `rows`, a read pinned to rows by a unique-key equality, is `row`, and the decision keeps
the key and the bound values; `groups` and `rowsByGroup` are both `group`. A pinned row still holding
a parameter placeholder — an unbound description, which the module hook never hands the vtab — widens
the read to `global`, as does a `rows` watch that pins no row. Decisions are deduped per statement by
(table, kind, scope), merging the pinned rows, and the entry's list is the statements' lists
concatenated in statement order and deduped the same way.

Three things the description does not say, and how the analysis resolves each — in the direction of
one decision too many rather than one too few:

- **Reads are not labelled by what they served.** A foreign key's parent probe is a watch on the
  parent table; a CHECK's subquery is a watch on whatever table it reads, indistinguishable from a
  `SET` subquery. So a watch on a table a `foreign-key-child` constraint references is taken as that
  constraint's read, and a cross-row CHECK is reported on the written table while its subquery's
  watch is still reported as a `read`.
- **The target row is not separated from the rest.** The description trims the target scan's watch to
  the non-key columns the write read, but a subquery over the target table is a separate watch kept
  whole. A watch on the target no wider than the selection is the target row itself and is dropped: a
  `rows` watch pinned to the selection's rows under a `rows` selection (the `unchanged` guard covers
  the row), and any watch under a `global` selection (the `row-selection` decision covers it). A
  target watch wider than a `rows` selection (`set x = (select max(x) from t) where id = ?`), and
  every target watch under an INSERT's `none` selection (`insert into t … select … from t`), is a
  `read`.
- **The table is named as Quereus names it**, lowercased. The outlook renders a decision on a table of
  this plugin by the table's `schema.table` as the statuses name it (`main.Conversations`), resolved
  through the controller's published tables when the entry is judged, and a decision on any other
  table — one declared on another module — by Quereus's name.

### Dependencies between entries

An entry depends on an earlier unsettled entry in two ways:

- **Through a guard**: one of its guards covers something the earlier entry wrote — the exact key
  for `absent` and `unchanged`, the range for `absentRange`. If the earlier entry fails, its write
  reverts and the guard can refuse: an `unchanged` guard over a row the earlier entry wrote, an
  `absent` re-insert of a key the earlier entry deleted, an `absentRange` over a value the earlier
  entry freed. Recorded with `via: 'guard'`. The entry is assured only if the earlier entry is (an
  assured earlier entry can still fail for reasons the prediction does not cover — expiry, discard,
  rejection — which is why it stays listed). A guard covered by an earlier write of the same entry
  contributes no dependency of its own.
- **Through an unchecked read**: one of its unchecked decisions read rows the earlier entry wrote —
  a message whose conversation was created by the earlier entry. If the earlier entry fails, this
  one is kept (its guards still pass) but its decision rested on rows that are gone. Recorded with
  `via: 'unchecked'`. It does not change `kind`, for the reason `unchecked` does not. An entry
  depended on both ways is listed once, as `'guard'`.

Matching a decision against an earlier entry's writes uses the decision's scope. A `row` read on a
table of this plugin whose every pinned row encodes to a main-tree key — the read's key is the
table's primary key, in any order, and every value encodes — matches an earlier entry whose segment
in that main tree wrote one of those keys (an unreadable segment counts as writing every key), the
lookup an `absent` guard makes. Every other decision — `group` or `global`, a `row` read pinned by a
key other than the primary key, one on a table no vtab of this plugin published or has not yet
initialized, or one restored after a restart, whose pinned rows are not journaled — matches every
earlier entry with a segment in any collection of the table, its main tree or an index tree. The encoding is the table's own (`TableOutlookSource.mainTree`, built as a
point lookup builds its seek key), resolved when the entry is judged and fixed with its judgement; a
published table is named by its `schema.table` rendering whether or not it is initialized, so a
decision read before the table is first touched in this process (a restored entry's) still matches by
table. This is the change-scope lattice's intersection, applied to a read scope and a write set, with
the key encoding standing in for `intersectScopes`.

"Earlier" means before the entry in the queue's order. A journaled transaction the restore after a
restart still defers (see [Restore after a restart](#restore-after-a-restart)) with a lower sequence
number counts too, whenever it wrote one of the entry's tables or a table one of its decisions read,
a `row` read included: its writes are not staged, so they cannot be matched by key, and it is never
assured.
Each transaction is listed once, in queue order. `CommitOutlook()` judges the open transaction as an
entry sealed behind everything queued now, so every queued entry and every deferred record counts as
earlier.

### What the analysis needs from Quereus

Quereus 4.21.0 ships the statement-level description of a **write** this section used to propose
(Quereus's [write-scope.md](https://github.com/gotchoices/quereus/blob/main/docs/write-scope.md); the
contract is `@quereus/quereus/src/planner/analysis/write-scope.ts`, the provenance classifier
`@quereus/quereus/src/planner/analysis/value-provenance.ts`). It is computed from the same planner as
the read-side change scope and speaks its vocabulary — `QualifiedName`, `TableWatch`, `ScopeValue`,
`NonDetSource` (Quereus's
[change-scope.md](https://github.com/gotchoices/quereus/blob/main/docs/change-scope.md)) — so a host
reading change scopes reads it without new shapes. What the plugin reads of it:

- **`Statement.getWriteScope()`**, beside `getChangeScope()`: one `TableWrite` per write site in plan
  order, with the statement's non-deterministic sources and unbound parameters.
- **The module hook.** A virtual table that sets `wantWriteScope = true` receives
  `UpdateArgs.writeScope`, the write site's `TableWrite`, on every `update()` of the statement's own
  write: one object per execution, the same reference for every row, the execution's parameters
  already bound into `selection` and `reads`. It is **absent** on the engine's FK cascade child
  writes, and the upsert `DO UPDATE` arm receives the INSERT's object (whose `disposition.clauses`
  describe the arm). Unset, the engine runs no analysis; set, a write site is analyzed once per plan
  and its parameters bound once per execution.
- **Per written column, a `ValueProvenance`** (`TableWrite.columns`: INSERT lists every table column
  in schema order, UPDATE the assigned columns, DELETE none): `literal`; `input` (parameters and
  context variables); `fresh` — a call to a function flagged `FunctionFlags.FRESH`, or `randomblob(n)`
  with a literal `n ≥ 16`, or an injective wrapper over exactly one such call (`hex`, `lower`, `upper`,
  `cast`, `||` against a literal; only `hex` keeps a blob fresh); `volatile`; `self` (the row's own
  previous values, `set n = n + 1`); `other` (other rows, or anything the classifier cannot describe).
  A function declares itself fresh with `fresh: true` in `createScalarFunction`'s options, or the flag
  bit in a raw function schema; no builtin carries it. The rule is narrower than "a deterministic
  function of a fresh value is fresh": `substr(StampId(), 1, 8)` is `other`.
- **How the target rows were chosen** (`selection`): `none` for INSERT; `rows`, with the key and the
  bound values, when the WHERE pins a unique key by equality; `global` otherwise — what the
  `row-selection` decision reads.
- **Everything else the write reads** (`reads`: `TableWatch`es, each with its binding mode `full`,
  `rows`, `groups` or `rowsByGroup`) and **the constraints it is subject to** (`constraints`, each
  classed `row` or `cross-row` and `immediate` or `deferred`, with the table a foreign key or an
  assertion references): the inputs of the `unchecked` decisions.
- **`selfIndependent`**: no written value depends on the row's previous values or on other rows, so
  re-applying the write to its own result changes nothing — the property the [already-applied
  guards](#guards-that-make-idempotent-writes-assured) read, distinct from Quereus's
  `PhysicalProperties.idempotent` ("safe to evaluate twice in one transaction").

The vtab combines the description with the facts only it has at staging time: the guard each action
actually carries, and whether the target row was inserted by an unsettled entry of this queue. Two
gaps it works around: a cascade child write and the upsert `DO UPDATE` arm are undescribed for the
row's own values, and both count as not fresh. One imprecision it inherits, because the plugin
trusts the label: on Quereus 4.21.0, `randomblob(16)` written bare to a `text` column is labelled
`fresh` although the engine stores a lossy text decode of the bytes — the write conversion the label
should fail on is not planned for a `text` column — so write `hex(randomblob(16))` for a random text
key; the Quereus fix is tracked in blocked `quereus-labels-a-fresh-blob-written-to-text-as-fresh`.

### Declared hints

Three facts the analysis cannot see, which an application can declare with tags saved in the
catalog record:

- **`"optimystic.fresh" = true` on a column**: values of this column are generated unique per write
  by the application (a UUID made in the app and passed as a parameter). Its values count as fresh.
- **`"optimystic.single_writer" = true` on a table**: only one machine writes this table's rows (a
  device's own settings). Its `unchanged` guards count as not refusable by others.
- **`"optimystic.content_key" = true` on a table**: the primary key is a deterministic function of
  the row's other columns (a blob store keyed by content hash), so two machines inserting the same
  content insert the same row, and a plain `insert` of an equal row is the same write made twice.
  An INSERT into it is staged under `absentOrEqual` rather than `absent` ([Guards that make
  idempotent writes assured](#guards-that-make-idempotent-writes-assured)). No provenance label
  describes a content hash, so a tag is the only way the plugin can learn this.

The first two hints change the prediction and nothing else: every guard is still enforced at rebase.
A false one produces an assured entry that fails, which the plugin logs as
`offline:assured-entry-failed` with the guard that refused and counts in `assuredFailures` (see
[Conservative by construction](#conservative-by-construction)). The third changes which guard the
drain enforces and not the prediction; the variant still compares the whole row, so an equal key
under different content refuses as a plain insert would.

### Conservative by construction

The analysis claims `assured` only when it can show it, and every unknown counts as exposed — a
statement the analysis cannot describe, a Quereus that has no write description, a value whose
provenance it cannot trace. That is the rule Quereus's own row classification follows ("when
uncertain, classify as 'global'"). An assured entry that fails anyway, other than for reasons 3 and
4, is therefore a defect in the analysis or a false hint, and is logged as such rather than treated
as an ordinary failure.

Concretely, the plugin reads the outlook the entry held when it fails (`outlookContradicted` in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/commit-outlook.ts`) and logs
`offline:assured-entry-failed transaction=… reason=… refusal=… table=… key=… causedBy=…` when it
was assured, the reason is `constraint` or `concurrent-modification`, and the failure did not come
through an entry it depends on: `causedBy` is absent, or names an entry not in its `dependsOn` while
no entry in its `dependsOn` has failed. The second half is there because the queue names the nearest
failing earlier entry as the cause, which in a chain of failures can be one this entry never
depended on while the one it did depend on failed further up. `refusal` is the class of the guard
refusal in the failure's cause chain, and `table` and `key` name what it refused, decoded as an
exposure is. `expired`, `discarded`, `rejected` and `too-large` are never logged: the size limit is a
property of this write, not of other writers, and the other three are reasons 3 and 4. Each line
also adds one to `assuredFailures` on the queue-wide state, which, like the queue's
`unclassifiedFailures`, is zero in a correct deployment.

### Guards that make idempotent writes assured

The base guards refuse every case where the row is not as the statement found it, including cases
where the rival made exactly the change this entry makes: two machines marking the same task done,
two machines deleting the same row, two machines inserting the same content-addressed row. Each of
those entries would fail although the final state is what both intended. Three guard kinds beside
the base kinds of `TreeEntryGuard` (`TreeAlreadyAppliedGuard` in
`packages/db-core/src/collections/tree/struct.ts`) accept them as **already applied** and skip the
element instead of refusing. Which kind a statement's element carries is decided at staging, from
the statement's write description (`insertAcceptsEqualRow` and `rewriteAcceptsEqualRow` in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/write-description.ts`, pure over the
description and the arm) and the table's tags:

| Element | Base kind | Variant | Carried when… | Sound because… |
|---|---|---|---|---|
| DELETE by key, and a secondary-UNIQUE eviction's delete | `unchanged` | `unchangedOrAbsent`: accepts the row already absent | always. | The final state is the one the statement intended. |
| same-key UPDATE, and INSERT OR REPLACE over an occupied key | `unchanged` | `unchangedOrEqual`: accepts the row already equal to this entry's post-image | the description is of that arm and `selfIndependent` — every value the statement writes is independent of the row's own previous values and of other rows (no `set n = n + 1`). | Applying the statement to its own result changes nothing, so "rival, then us" yields the same row. |
| INSERT whose probe found the key clear | `absent` | `absentOrEqual`: accepts the present row equal to this entry's row | the statement is `insert or ignore`, `insert or replace`, or `on conflict do nothing` with no target or targeting the primary key; or the table is tagged `optimystic.content_key` ([Declared hints](#declared-hints)). | The row the statement wanted exists; the disposition says a present row is not an error. |

A plain `insert` of an existing equal row still refuses: SQL says a duplicate is an error, and an
application may rely on that to learn that someone else got there first. A primary-key move keeps
the base kinds on both halves: accepting the absent delete half while still inserting the new row
would create a row the sequential execution never would. The upsert `DO UPDATE` arm, which receives
the INSERT's description, and an FK cascade child write, which has none, keep the base kinds — except
the cascade's delete, which needs no description. Every variant still refuses a rival that made a
DIFFERENT change, with the same error classes as its base kind, so nothing downstream of a refusal
changes.

The index segments of an already-applied entry need nothing: an index entry carries no `unchanged`
guard, and under such an entry they replay as no-ops of their own accord — the delete of the old
index entry finds nothing, the insert of the new one finds an equal entry, and a UNIQUE index
entry's `absentRange` excludes the entry's own key, which is where the rival's identical entry sits.
The tree handler reports what each guard accepted as an `AlreadyAppliedTally`
(`packages/db-core/src/collection/action.ts`), the queue sums the tallies over every collection the
entry wrote, and the entry is reported `committed` with `effect: 'already-applied'` exactly when
every counted element was already applied and at least one was (`CommittedEffect` in
`packages/db-core/src/offline/status.ts`). An entry of which only part was already made — one row
already done elsewhere, one not — reads `'applied'`, as does one with no such element, and one of
whose collections' tallies the queue never heard (put back after a restart, or the committed half of
a partial commit before one), since a host reading `'already-applied'` as "none of my changes
landed" must be right.

The variants are evaluated only by the writer's own replay, as every guard is, so a node on an older
build never has to interpret one. Nor are they a property of offline mode: the same statements stage
them online, where a racing identical write commits instead of refusing — an online transaction's
`delete` of a row a rival deleted meanwhile commits, its delete skipped. The outlook judges each
variant as its base kind, since a rival can still make a different change, and marks the exposure
`tolerates: 'same-change'` ([Judging each guard](#judging-each-guard)). The acceptance can also be
met at initial staging on a mesh, where the tracker the guard scans fetched a rival's commit the
pre-stage probe's view had not: the statement then returns `ok` for a row the sequential execution
would not have found, which is acceptable because the final state is the statement's intent.

A further step, not proposed in the first stages: a blind partial update
(`update t set status = 'done' where id = ?`, reading nothing but the key) is refused today when a
rival changed any column of the row, because the action writes the whole row image. An action that
writes only the changed columns, guarded only on the columns the statement read and the columns its
index delta needs, would be refused only by a rival that changed those or deleted the row. That is
a change to the tree's action format and to how index deltas are computed, and it needs its own
design.

### Using the outlook before committing

The same computation is available inside an open transaction, so an application can ask before it
commits and, for example, confirm with the user before queuing an exposed change:

```sql
begin;
update Note set body = :body where id = :id;
select CommitOutlook();   -- JSON of the CommitOutlook the transaction would get if committed now
commit;
```

`CommitOutlook()` mirrors `StampId()`: a function the plugin registers, answering for the current
transaction, `NULL` outside one. It is useful online too, where it predicts whether a commit can
lose a race at all. It judges what the transaction has staged at the moment it is evaluated
(`Collection.openActions`, in every collection the transaction staged into), as an entry sealed
behind everything queued now, by the same judgement a queued entry gets
(`OfflineMode.openTransactionOutlook`); everything it reads is in memory, so it is synchronous. The
JSON renders a value the way Quereus's own JSON output does: a bigint as a number when it is a safe
integer and as a decimal string otherwise, bytes as `0x` followed by hex, and an unknown key as
`null`.

## Reads in offline mode

Every live read refreshes from the network first
([internals.md §Quereus vtab read path](internals.md#quereus-vtab-read-path--pull-on-read-is-shape-independent)),
and a refresh that cannot reach the cohort fails the read with `BlockUnavailableError`, even for rows
this machine holds (backlog `a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`).
An application in offline mode has said it accepts this machine's answer, so in offline mode, for
tables whose policy is `'queue'`:

- A live read whose refresh fails for unreachability (the same classification as the drain's
  "cohort unreachable" row) serves this machine's view — committed blocks it holds plus every queued
  entry — and sets `readsServedLocally` on the queue state. That includes a refresh in which no
  machine answered at all for some block, every request for it having failed in transport:
  `NetworkTransactor.get` reports that block `peers-unreachable` rather than failing the read
  untyped.
- While the reachability gate reports the cohort unreachable, a live read skips the refresh instead
  of paying the dial timeouts on every read. The gate is asked on every read, so the first read after
  it answers reachable refreshes again.
- A block this machine does not hold at all still fails the read with `BlockUnavailableError`. The
  mode does not make data appear; an application that wants to read a table offline must have read
  it while online on a machine that keeps what it reads, which in a small group is every member
  (each is in every cohort).

This is candidate answer 2 of that ticket ("the refresh should degrade, and report that it did"),
taken only where the application opted in, per table. A `'network'` table keeps today's fail-loud
read, which is the answer that ticket's revocation case needs.

In the plugin every live refresh goes through one method of the vtab, `refreshLive` in
`packages/quereus-plugin-optimystic/src/optimystic-module.ts`: the main tree and the index tree of a
live scan, and the refreshes a write makes in its uniqueness probe (`probeUniqueConstraint`,
`ensureUniquePopulated`, `populateUniqueTree`), so an offline insert into a table with a UNIQUE
column is queued while the cohort cannot be reached rather than failing on its probe. It asks the
controller whether the table's reads degrade (`OfflineMode.degradesLiveReads`: the mode is entered
and the table's policy is `'queue'`), then the table's gate (`OfflineMode.cohortReachable`, asked
with the header and known log tail ids that `gateBlockIds` in
`packages/db-core/src/offline/reachability.ts` gives the queue too), then refreshes. A refresh
failure is absorbed only when `isCohortUnreachableRead` in
`packages/db-core/src/transaction/commit-failure-class.ts` accepts it, the predicate
`classifyCommitFailure` sorts the same errors by; every other failure propagates, a
`BlockUnavailableError` with another reason and a `BlockPossiblyStaleError` included. Each outcome is
reported (`OfflineMode.noteLiveRefresh`): `readsServedLocally` is the last report's value, published
when it changes, so a refresh that reaches the cohort, in or out of the mode, clears it, and so does
leaving the mode. The first
locally served read of a table is logged as `offline:read-served-locally`, and again the first one
after a refresh has reached the cohort. The degrade has no transaction branch, so a live read inside
an open transaction degrades the same way. A committed read (`committed.<Table>`) never refreshes
and is unchanged. One table is excepted: while a journaled transaction that wrote it is waiting to be
put back after a restart ([Restore after a restart](#restore-after-a-restart)), its reads do not
degrade — this machine's view lacks rows the application was told are committed — so a read of it
fails while the cohort cannot be reached, and the first read that reaches the cohort puts them back.

## Persistence

### What is journaled

Two records per entry, in the queue's own terms — entry ids, collection ids, actions, the retained
attempts — which the queue hands to a journal through one port, `IOfflineJournal` in
`packages/db-core/src/offline/journal.ts`, at the moments [Write ordering](#write-ordering) names.
The port never sees a table name or a key-value store, so db-core keeps its no-storage rule and a
`Tree`/`Diary` application without SQL can journal too; the plugin's journal over `IKVStore`
(`OfflineJournal` in `packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-journal.ts`,
below) adds what db-core does not know — the table each collection backs, to initialize it on
restore — and a third record, the outcome.

**The entry record**, written once, at enqueue (`IOfflineJournal.queued`):

```typescript
type JournalEntryRecord = {
  id: EntryId;                  // the plugin's entry id is the StampId() of the local transaction
  seq: number;
  queuedAt: number;
  expiresAt?: number;
  segments: Array<{             // one per collection the entry sealed a segment in, in sealing order
    collectionId: CollectionId;
    actions: Action<unknown>[]; // the segment's staged actions, guards included, verbatim
  }>;
};
```

**The drive record**, rewritten before each send, after a partial commit and after an identity
renewal (`IOfflineJournal.driving`), so a crash at any point leaves on disk the identity the next
drive has to run under:

```typescript
type JournalDriveState = {
  actionId: ActionId;                                   // renewed after torn-not-saved
  attempts: ReadonlyMap<CollectionId, InFlightAttempt>; // recorded under actionId, not yet resolved: what a later cycle resumes
  committed: ReadonlyMap<CollectionId, WriteDurability | undefined>; // what a partial commit has already committed
};
```

An entry restored with a drive record is in doubt whenever its `attempts` or `committed` is
non-empty; one restored without was never sent, and gets a fresh action id. The terminal status
(`IOfflineJournal.settled`) is written before it is emitted, and the plugin's journal removes the
two records it settles once the outcome is written (below).

**In the key-value store** the plugin writes three records per transaction under
`optimystic-offline/<label>/` (`OFFLINE_JOURNAL_KEY_PREFIX` in
`packages/db-p2p/src/storage/node-kv-namespaces.ts`, then the `journalLabel`), each in its own
sub-namespace, so listing one never walks another. `<seq>` is the entry's sequence number
zero-padded to 12 digits, so a listing sorted as strings is queue order, and every value carries a
version, `v: 1`, which a reader that does not know it refuses rather than guesses at:

| Key | Written | Value |
|---|---|---|
| `entries/<seq>` | once, at enqueue (`queued`) | `{ v, transactionId, seq, queuedAt, expiresAt?, segments: [{ collectionId, table, actions }], outlook? }` |
| `drives/<seq>` | before each send, after a partial commit, after an identity renewal (`driving`) | `{ v, transactionId, actionId, attempts: [[collectionId, InFlightAttempt]…], committed: [[collectionId, WriteDurability \| null]…] }` |
| `outcomes/<transactionId>` | at a terminal outcome (`settled`), before the other two are deleted | `{ v, at, status }`, `status` the outcome as [Outcomes after a restart](#outcomes-after-a-restart) describes |

The entry record's `table` is one table its collection backs, as `{ schemaName, tableName }` — the
first the bridge recorded; a collection backing two tables is logged
`offline:journal-ambiguous-table`, since any table that opens the collection serves a restore, and a
collection backing none fails the commit, since nothing could restore it. The transaction id keys
the outcome record, which works because a `StampId()` is base64url. Maps are written as pairs, and a
collection saved with its holders unknown as `null`.

The entry record's `outlook` holds what only the original statements could see: the facts their
write descriptions recorded ([Judging each guard](#judging-each-guard), [Unchecked
decisions](#unchecked-decisions)), as `{ fresh: [[collectionId, [key…]]…], unchecked: [{ table: {
schema, table }, kind, scope }…], complete }` (`JournaledFacts`, written by `encodeFacts` and read
back by `decodeFacts` in `packages/quereus-plugin-optimystic/src/optimystic-adapter/write-description.ts`).
The journal asks the controller for them as it writes the record (`OfflineJournalHooks.factsOf`); the
controller holds them from before the enqueue. The restore hands them back ahead of
`OfflineQueue.restore` (`RestoreHost.factsRestored`), so the `queued` status that judges the restored
entry judges it with them, and withdraws them if the restore throws. A `row` read's pinned rows are
left out: a bound value can be a bigint or bytes, which the journal's JSON cannot carry. A restored
read is therefore matched by its table, as a `group` read is, and keeps its reported `scope`, so its
`dependsOn` can be wider than before the restart, never narrower, and only until the extra earlier
entry settles; the tripwire `NOTE:` at `encodeFacts` names the remedy. A record without the field,
written by a build before it existed, is restored without facts and judged from its checks and tags
alone, with `unchecked: 'not-computed'`; the record version stays 1.

**Actions, not transforms.** Transforms are block operations relative to the base the actions were
staged on. After a restart, or after a rival's commit, the base is different, and the actions have
to be replayed anyway; and for an invented collection the transforms describe a header the drain
may need to discard. Actions are what the log already stores and carries as JSON, guards included,
so they round-trip through the journal under the same encoding rules the transport imposes (see
the JSON note under the `unchanged` guard in internals.md).

**No SQL text by default.** The statements are not needed to drain in legacy mode, and the
replicated statement record is exactly where an application's secrets can leak
([transactions.md §Secrets and the replicated statement record](transactions.md#secrets-and-the-replicated-statement-record)).
The row images in `actions` are as sensitive as the block storage that will hold them, and the
journal should be protected the same way. Session mode, which needs the statements, records them
and inherits that section's rules.

### Write ordering

1. **Local commit.** Seal the open segments, then write the entry record and flush the store, then
   resolve `commit`: `OfflineQueue.enqueue` writes before it admits the entry and emits `queued`. A
   journal write that fails fails the commit: every segment is unsealed again (`Collection.unseal`,
   the exact inverse of `sealPending`, which puts the actions back into the open segment), nothing is
   queued or reported, and the transaction rolls back, as a network failure does today — the rollback
   restores the pre-transaction snapshot by replay, since the sealed list changed, and ends with the
   transaction's actions gone. So "acknowledged" always implies "journaled" when persistence is on.
   The journal takes back a record whose write failed (deleted and flushed, best effort), since the
   transaction it would restore was rolled back. The cost of flushing before resolving is the
   opposite case: a crash after the flush and before `commit` resolves leaves a record for a
   transaction whose application never heard it committed, which the restore puts back and drains.
   Resolving first and writing after would break the acknowledgement's promise instead, so the
   journal takes that cost.
2. **Before each send.** Write the drive record and flush, then send: `IOfflineJournal.driving`,
   called from the queue's write-ahead wrapper (`OfflineQueue.recordAttempts`) with the attempts
   about to go; a throw aborts the cycle with nothing sent, and the entry stays queued, not in doubt,
   re-driven after the backoff. This is the write-ahead that makes the identity rule above survive a
   crash. The same record is rewritten right after an identity renewal, so the fresh action id is on
   disk before anything runs under it; a throw there is logged (`offline:journal-write-failed`) and
   the drain goes on, since the next send's write repeats the state.
3. **On a terminal outcome.** Write the outcome record and flush, then delete the entry and drive
   records, without flushing: `IOfflineJournal.settled` is told the `committed` or `failed` status
   before it is emitted, and a throw there is logged, never raised into the drain — the network has
   the write, or the segments are gone, and the stale record is what the restore after a restart
   resolves. The plugin's journal deletes the two records even when the outcome write fails: an entry
   record with no outcome beside it would be restored and driven again, so a discarded transaction
   would be sent after all, while a lost outcome only means the application does not hear it again
   after a restart. A crash between the network commit and this step leaves an in-doubt record,
   which the next drain resolves by finding its own log entry; a crash after the outcome is flushed
   and before the deletes are leaves all three records, which the rule in
   [Restore after a restart](#restore-after-a-restart) resolves.
4. **On partial commit, before the next send.** Write the drive record with the committed
   collections (`OfflineQueue.partiallyCommitted`). It cannot be written before the committed
   segments are consumed: they are consumed inside `TransactionCoordinator.commitEntry`, before
   `CoordinatorPartialCommitError` reaches the queue. The window between that fold and the write is
   covered by the in-doubt rule: a crash there leaves a drive record whose attempts name the
   committed collections too, and a restore resumes them under the recorded action id, where the
   opening refresh finds each committed collection's own log entry and consumes it rather than
   committing it again (`Collection.completeOwnEntry`, `EntryCommit.resume`).

### Restore after a restart

`plugin.hydrate(db)` restores the queue after rebuilding the catalog and before returning, so the
application's first statement after `hydrate` already sees its queued transactions. A host that does
not call `hydrate` calls `plugin.offline.restore()` itself, which is what `hydrate` runs; it can be
called again at any time — a record already put back is skipped, one deferred (below) is tried
again — and refuses to run while a transaction is open on the `Database`, since each collection's
open segment belongs to that transaction. The pass is `OfflineRestore` in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-restore.ts`, owned by the
controller; it runs one at a time, and a pass requested while one runs starts after it.

A pass lists the label's entry, drive and outcome records once. It loads the outcome records into
the retained outcomes (one past `outcomeRetentionMs` is deleted instead), reserves every listed
sequence number on the queue so a transaction queued meanwhile never takes a journaled one, and then
walks the entry records in queue order:

- **An entry record whose transaction has an outcome record is settled.** The deletes that follow an
  outcome are not flushed, so a crash can leave the entry and drive records beside the outcome; the
  restore deletes them and puts nothing back, emits no status, and the outcome is listed by
  `outcomes()` as any other.
- **A record of an unknown version stops the pass**, thrown out of `hydrate` or `restore()` as
  `OfflineJournalError` (reason `'unknown-version'`, the key and the version), with every record from
  it on left as it is and the records before it put back. Skipping it would drain later transactions
  ahead of one the order says must go first, and dropping it would lose a change the application was
  told is committed; the host sees a loud failure saying the journal was written by a newer build.
- **Otherwise each table the record names is initialized** to reach its collections, the instances
  every statement reads and stages through (`OptimysticModule.collectionsOfTable`), and the entry is
  put back through `OfflineQueue.restore` (below). A guard that refuses as the segment is re-staged —
  the local state changed underneath while the app was down, a rival's row at the key, say — fails
  the entry exactly as a refusal during replay would, and its outcome is retained.

**Deferral.** A record cannot be put back when a table it names is not in the engine's catalog
(dropped by another machine while this one was down, or not yet declared by a host that restores
before `apply schema`), when initializing or opening the table throws `BlockUnavailableError` (its
base blocks cannot be read: this machine never held them and the cohort cannot be reached — out of
the open, or out of the segment's replay, which the queue then rolls back), or when the record names
a collection the table no longer backs (re-declared over another URI while down). The pass stops
there: this record and every record after it stay journaled, unrestored, so the queue keeps its
order, each logged `offline:restore-deferred` once per pass. Any other error out of a table's
initialization propagates out of `restore()` and `hydrate`: a corrupt catalog or a programming error
is not a reason to wait. The deferred records are retried by another pass, which runs on every
`restore()` call; when a deferred table's vtab finishes a full initialization or a live refresh of it
reaches the cohort (`OfflineMode.tableReadable`, scheduled off the statement's path once no
transaction is open, never awaited by the read); on every wake of a published gate, likewise once no
transaction is open — a machine connected or was identified — which is what retries a deferred record
while the queue is empty; and from the controller's reachability gate, asked
by the queue before each submission — while anything is deferred the gate starts a pass and answers
`false`, so nothing queued after the restart is submitted ahead of an older transaction still on
disk, and the queue's re-check timer is also the restore's retry timer. Such an entry reports
`waitingFor: 'cohort'`, the closest existing value; the reason is in the log line.

What the application sees of a deferred record: `entries()` lists it after the queue's entries as
`queued` with `waitingFor: 'restore'`, `persisted: true`, `attempts` 1 and `inDoubt` true when a
drive record was written for it (a send may have landed), else 0 and false; `status(transactionId)`
answers the same; `whenDrained()` stays pending until a later pass puts it back and it drains, or
it is discarded; it counts as queued for a network-acknowledged commit (which waits behind it), for
session mode's refusal, and for the DDL gate on its tables. `discard` of one that is not in doubt
deletes its records and fails it with reason `discarded` and empty `changedTables` (nothing was
staged, so nothing is announced); one in doubt is refused with `EntryNotDiscardableError`, as a
queued one is, and so is the one record a pass is putting back at that moment (`because:
'restoring'`): it is still listed as deferred while the queue registers it, and the queue refuses it
as unknown until it is admitted, so accepting it would write its outcome and delete its records
while the queue went on to drive it. A dropped table with an in-doubt record is therefore stuck until the table exists
again or the record is removed from the store by hand, logged once as `offline:restore-stuck` and
recorded as an accepted tradeoff at the discard site. A restored entry's `queued` status is emitted
during the pass, before `hydrate` returns, so a listener registered before `hydrate` hears it; one
registered after reads `entries()`.

Both go through `OfflineQueue.restore` in `packages/db-core/src/offline/queue.ts`, the only way to
register an entry whose segments `enqueue` did not seal. It holds the drain for the whole call — it
waits until the loop is parked between iterations, so no submission is on the network and no removal
is under way while segments are inserted — registers the entry first, inserted into the queue by its
recorded `seq`, and then calls back per collection to put the segment in place. Two rules decide
what that callback does:

- **A segment whose recorded attempt the collection already holds committed is not re-staged.**
  Before re-staging, the restore asks the collection whether its committed context names the
  recorded attempt's action id at its revision (`Collection.holdsCommitted`). If it does, the network
  commit landed and the crash came after it; re-staging would run the segment's own guards against
  its own committed rows (`absent` refuses on a present key) and fail the entry with `constraint`,
  the opposite of the truth. Such a collection is recorded as committed with its class unknown — the
  same shape a head commit answers when a refresh established the write was saved without
  re-sending — and an entry every collection of which answers so is settled `committed` at once,
  with no `queued` status.
- **A segment is inserted by sequence, not appended.** A record restored late — deferred until its
  table can be read — belongs ahead of entries queued after the restart began, in the queue and in
  each collection's sealed list alike, or the head commit's "head is first" rule and the queue's
  order disagree. `Collection.restoreSealed` inserts the segment at the position the queue reports
  and rebuilds the tracker by replaying every segment in order; the restored segment's own refusal is
  returned to the restore rather than reported, and the restore fails the entry through the ordinary
  cascade with no `causedBy`. A later segment the replay newly refuses is reported through
  `onSealedRefused` as any replay's would be, and is attributed to no earlier entry either, since a
  restore removes nothing. A replay error that is not a refusal — a block it could not read —
  propagates with the segment removed again, so the restore that rolls back can be tried again
  later without meeting its own segment. An insertion costs one replay, the cost every drop already
  pays.

### Outcomes after a restart

Status listeners are in memory. An application killed between an entry's settlement and its own
handling of the status event would otherwise never learn the outcome. With persistence on, each
terminal outcome is kept in the journal for `outcomeRetentionMs` or until
`acknowledge(transactionId)`, and `outcomes()` returns them. Without persistence there is nothing to
restart into.

The record holds the outcome reduced to what JSON carries (`PersistedOutcome` in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/offline-journal.ts`): a `committed` one's
`transactionId`, `durability` (per collection and `overall`), per-table `tables` and `effect`,
without `followed`; a `failed` one's `transactionId`, `reason`, `causedBy`, `changedTables`,
`committedTables`, and `error` as its name and message. Read back (`decodeOutcome`, same file), a
`committed` outcome says `followed: false`, since nothing is followed across a restart — and
`effect: 'applied'` from a record written before `effect` was journaled — and a `failed` one carries
a plain `Error` with the original's name and message and no `cause`. Its
record is written when the outcome is settled, before it is reported, and deleted, without a
flush, when it is acknowledged or found past the retention window by `status` or `outcomes`; a
delete a crash loses lists the outcome once more after the restart.

### Which store

`journal` takes the `IKVStore` interface (in `packages/db-p2p/src/storage/i-kv-store.ts`), which the
filesystem, IndexedDB, React Native LevelDB and NativeScript SQLite packages all implement, so no new
storage adapter is needed. A host may hand in the same instance it passes the node as
`NodeOptions.kvStore`: the plugin's key prefix, `optimystic-offline/`, is in `NODE_KV_NAMESPACES` (in
`packages/db-p2p/src/storage/node-kv-namespaces.ts`), which is how a file-backed store sharing a
base path with block storage keeps block listings from walking it.

Two `Database`s may share one store only under different `journalLabel`s: every listing is under
`optimystic-offline/<label>/`, so two labels never see each other's records. Two `Database`s with
the same label over one store list and delete each other's records and corrupt both queues' order,
and neither can detect it from the inside — no `IKVStore` offers a lock — so keeping labels apart is
the application's responsibility. A write to these stores is not
guaranteed to survive a power cut until a `flush()` called after it resolves (the contract `IKVStore`
points to, and [packages/db-p2p/docs/storage.md](../packages/db-p2p/docs/storage.md) describes), so
the local commit flushes the journal before it resolves, which is what makes step 1's "journaled"
mean "survives a power cut".

## Interaction with existing machinery

### Durability reports and the full-replication event

A drained entry's network commit produces the same `TransactionDurability` an online commit does,
and the bridge hands it to `TransactionBridge.reportCommitDurability` under the entry's
`transactionId`, so `onCommitDurability` listeners, the `DurabilityFollower` (in
`packages/quereus-plugin-optimystic/src/optimystic-adapter/durability-follower.ts`) and
`onCommitFullyHeld` all behave as described in the plugin README
([§A commit's durability](../packages/quereus-plugin-optimystic/README.md#a-commits-durability--pluginoncommitdurabilitylistener)).
The follower's in-memory limit applies unchanged: a commit pending full replication across a restart
is forgotten (backlog `feat-a-host-can-ask-whether-an-earlier-commit-is-fully-held`).

### Reactive watching

A local acknowledgement is a Quereus commit, so Quereus fires its watchers precisely on it, as
for any commit. A drain that commits an entry with the effect it had locally changes no row this
machine sees, and fires nothing. A removal or a cascade fires `notifyExternalChange` for the tables
whose rows changed ([Removing an entry](#removing-an-entry)). A rebase over a rival's commit fires
through the existing paths that announce the rival's commit.

### Network acknowledgement behind a non-empty queue

A transaction with network acknowledgement — offline mode off, or a `'network'` table — committed
while entries are queued cannot commit ahead of them: it was decided on a view that includes them.
It is appended to the queue like any entry, and its `commit` waits until the entry settles,
resolving on `committed` and throwing the mapped error on `failed`, so the caller sees today's
semantics. With an empty queue it takes today's path directly, which keeps the default
configuration unchanged.

A network-acknowledged commit waits at most the bound an online commit has today. If that bound
expires while the entry has never been sent, the entry is withdrawn and `commit` throws a typed
timeout error; the caller was told it failed, so nothing is left queued. If it expires after the
entry was sent, the entry may have landed and cannot be withdrawn: it stays queued as a locally
acknowledged entry, and `commit` throws an error carrying the `transactionId` and saying so, so the
caller can follow it.

In the plugin the route is chosen by `TransactionBridge.offlineRoute`, and the wait is
`OfflineMode.awaitNetworkAcknowledgement`, which resolves from the same translation of the queue's
statuses that `onStatus` listeners receive. The bound is `offline.networkCommitTimeoutMs`, five
minutes by default (`NetworkCommitBoundMs`, the expiry a legacy multi-tree commit's stamp has too).
The timeout error is `OfflineCommitTimeoutError`, whose `sent` says which of the two cases it was; a
withdrawn entry fails with reason `discarded`. A `failed` entry's `commit` throws the status's mapped
error without restoring the transaction's snapshots, since the queue has already dropped its segments
and replayed what remains. The route is also taken while a collection the transaction writes still
holds a sealed segment with nothing queued (a failed entry's removal still dropping it). A dirty set
that cannot be one entry (two tables declared over one collection URI) cannot wait behind the queue:
it commits ahead of it, logged `offline:queue-bypassed`, and is refused with `SealedSegmentsError`
when it writes a collection that holds queued entries.

### The single-writer bridge

The bridge's single-writer state (see
[transactions.md §One writer at a time on the shared TransactionBridge](transactions.md#one-writer-at-a-time-on-the-shared-transactionbridge))
describes the **open** transaction, and the drain never touches it: the drain owns the sealed
segments and the queue, the SQL transaction owns the open segment. The collection latch serializes
their in-memory steps.

### Schema changes

DDL keeps its current path and is not queued. A schema change can invalidate queued entries — an
entry queued before `create index` carries no index-tree segment for the new index, and the index
backfill would read the entry's rows from the local view and commit index entries for rows that are
not on the network yet. So a statement that changes a table's storage shape (creating or dropping an
index, adding or dropping a column, dropping the table) is refused with a typed error naming the
queued entries while any entry that wrote that table is queued, and succeeds once they settle.
DDL that changes no stored shape (a tag change, a CHECK added or removed by name, a column rename,
which touches no row) is allowed. A `create table` is refused only when it declares, with other
columns or another primary key, a collection a table with queued entries already backs; an identical
declaration reads and writes the queued rows exactly as that table does. Table creation while
offline otherwise keeps its current behaviour, including the catalog written alone at launch that
backlog `6.5-partition-healing` records as fork-safe only while every machine writes identical
catalog content.

In the plugin the check is `OfflineMode.assertNoQueuedEntries`, which reads a table's collections
from the bridge's collection-to-table record (`TransactionBridge.collectionsOf`) and throws
`QueuedEntriesBlockSchemaChangeError` (`StatusCode.BUSY`, with the table, the operation and the
queued transaction ids in queue order, then any failed one whose removal is still dropping its segments) when a queued entry wrote any of them; an entry being
submitted or in doubt counts like any other. The DDL hooks of `OptimysticModule` call it after
draining the pending catalog tag writes and before writing anything, so inside `apply schema` a
refused step stages nothing into the catalog batch and the engine unwinds the apply as for any
failed step. `create`'s arm compares the declaration's column names, column types and primary key
against every live table over the same collection.

### Invented collections

A table declared but never written has no committed header, and `Collection.createOrOpen` invents
one in the tracker. A queued entry that writes such a table carries no action that names the header.
If another machine created the collection while this one was offline, committing the invented header
would put two collections under one id — the joiner fork recorded in `6.5-partition-healing`.

The probe that prevents it is the refresh every drain cycle opens with (`Collection.commitHead`, and
`TransactionCoordinator.commitEntry` for an entry over several collections): `Collection.updateInternal`
re-reads the header with no remembered tail, so it asks the network the question an open would. Its
three outcomes are the three cases:

- **The header exists.** The collection adopts the network's log and revision, and replays every
  sealed segment onto the committed state; once a revision is adopted the replay starts from an
  empty baseline rather than from the invented one (`Collection.replayActions`), so the invented
  header, log block and root are dropped. A segment the replay refuses is recorded and reported as on
  any rebase ([Removing an entry](#removing-an-entry)).
- **The header is authoritatively absent.** Nothing is adopted, the head commit stages its segment
  over the invented baseline, and the entry commits the header as today's first write does.
- **The header cannot be read.** The refresh throws `BlockUnavailableError`, which
  `classifyCommitFailure` sorts as `cohort-unreachable` for the two unreachability reasons and
  `unknown` otherwise; the entry waits either way. An invented collection is never committed on an
  unanswered probe.

Restore after a restart re-invents the header from the declaration before re-staging, since a
header's id is the collection's name. `packages/db-core/test/invented-collection-adoption.spec.ts`
pins the three outcomes at the collection tier, and
`packages/quereus-plugin-optimystic/test/offline-mode-invented-collection.spec.ts` the joiner at the
SQL level.

### Session mode

Session mode (`configureTransactionMode`, `TransactionSession` in
`packages/db-core/src/transaction/session.ts`) commits a `Transaction` carrying statements, read
dependencies and a stamp whose expiry is `DEFAULT_TRANSACTION_TTL_MS` (in
`packages/db-core/src/transaction/transaction.ts`) after BEGIN, which validators re-execute. A queued
session transaction is stale on both counts by the time it drains: its stamp has expired, and its
read dependencies name revisions that any intervening commit moved. Replaying its actions would be
refused by every validator. A session-mode entry therefore has to be re-executed at drain — its
statements run again, through the `QuereusEngine` (in
`packages/quereus-plugin-optimystic/src/transaction/quereus-engine.ts`), against the committed state
plus earlier settled entries but **without** later queued entries, under a fresh stamp — which
re-judges every constraint and every read, closing the gaps in the rebase table above.

Re-execution raises problems the action replay does not have: the view it runs against excludes
later entries that live in the same collections, while the application keeps reading those
collections; its effect can differ from the local one (`update t set n = n + 1` gives a different
`n`), which changes what "committed" reports; and the network stamp differs from the local
`StampId()`, so the status interface has to carry both. Offline mode therefore refuses to enter while
session mode is configured, until a later stage designs those points.

## Relation to the other designs

- **[crdt-sync.md](crdt-sync.md).** CRDT sync lets each machine commit locally and makes the log a
  grow-only set that converges by replay; it changes what "committed" means. This design keeps
  today's meaning and adds a client-side wait in front of it. They are compatible: under a replay-mode
  collection, a queued entry would be issued with its HLC at local commit, and the statuses here map
  onto that document's local / propagated / stable states
  ([crdt-sync.md §Tentative vs Stable](crdt-sync.md#tentative-vs-stable-the-stability-horizon)).
  The status interface is deliberately in terms of "queued, submitting, committed, failed" rather
  than consensus vocabulary, so it can carry over.
- **[partition-healing.md](partition-healing.md).** Its effect gating ("fire on stable") is what an
  application should do with external effects of a queued transaction: wait for `committed`, not
  for the local acknowledgement.
- **`6.5-partition-healing`.** The forked collections that ticket records come from machines that
  committed alone. Offline mode is an alternative an application can choose instead: the change is
  queued on the machine, not committed into its storage, and the reachability gate and the solo-refusing option every drain sets by default keep the drain from
  committing it alone. It does not fix
  forks created by writes outside the mode.
- **`feat-long-lived-pend-completes-as-members-appear`.** That ticket names a durable client outbox
  that resubmits on reconnect as "the cheap half" of its large-network regime; this design is that
  half. Its small-network regime — promises collected across pairwise contacts — would replace the
  drain's submission step for an entry whose cohort is never reachable all at once, and could do so
  without changing the queue, the journal, or the application interface. Its arm on classifying the
  lane per statement asks Quereus the same question the outlook does — whether a write's outcome
  depends on state other writers can change — and would reuse the same write description to choose a
  lane rather than to inform the application.
- **`a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`.** Offline mode adopts
  that ticket's candidate answer 2 for opted-in tables only. The ticket's question for applications
  that do not opt in stays open.

## Failure modes and accepted tradeoffs

- **A locally committed change can be lost to a later refusal.** The application was told
  "committed" and later "failed". This is the contract, not a defect; the status interface exists so
  the UI can say it.
- **Unprotected rules are judged on a stale view** (foreign keys, subquery CHECKs, computed values)
  until the constraint re-check stage lands. Offline mode makes the window long.
- **Cascades keep entries that read a removed entry but wrote nothing its guards protect** (legacy
  mode has no read dependencies).
- **Head-of-line blocking.** One entry whose cohort is unreachable holds back the rest.
- **Replay cost grows with the queue.** Every refresh that adopts a new revision replays every
  sealed segment, and draining `n` entries replays the remainder after each, which is quadratic in
  the queue length. Negligible for tens of entries; a device that queues thousands while offline will
  pay it on reconnect. The remedy, if it shows up, is per-segment transforms that let a drained head
  be subtracted rather than replayed; it is not proposed now.
- **Without persistence, a crash loses every acknowledged entry.** That is what choosing no journal
  means, and each `queued` status says `persisted: false`.
- **Expiry fails an entry the network might still have accepted.** `expireAfterMs` is the
  application's bound, and it is off by default.
- **A lone commit is still possible in two cases:** an application that set `allowSoloCommit`, and
  a mixed-version group whose coordinator predates the solo-refusing option, where the reachability
  gate — which can be wrong for a moment — is the only protection.

## Implementation stages

Each stage is meant to become one ticket. Stages 1–6 are gated in order; stage 7 needs only stage 4,
stage 8 needs nothing here, and stages 9 and 10 need 7 and 8.

1. **Typed classification** (implemented). Give the super-majority shortfall and the validator rejection stable
   error classes at the writer, and add one db-core predicate that sorts a commit failure into the
   classification table above. Useful without offline mode; prerequisite of the drain.
2. **Segments in `Collection`** (implemented). `sealPending`, `sealedEntries`, `dropSealed`;
   segment-aware replay with the refusal callback; open-segment-only snapshot and restore; the head
   commit that does not hold the latch across the network, with the fold-before-replay order. No
   plugin change. Unit tests in `db-core` over `TestTransactor`.
3. **The queue in `db-core`** (implemented). An in-memory, transport-agnostic queue over a set of
   collections (`OfflineQueue` in `packages/db-core/src/offline/queue.ts`): FIFO drain, the
   coordinator's per-entry slice commit, classification, in-doubt identity, partial commits,
   cascading removal, status events, the `ICohortReachability` port (always reachable in tests).
   Usable by a `Tree`/`Diary` application without SQL.
4. **Offline mode in the plugin** (implemented, in five tickets). `offline.enter`/`exit`,
   acknowledgement fixed at BEGIN, status and queue-state listeners, durability reports for drained
   entries, refusal while session mode is configured, `notifyExternalChange` on removal, the
   `optimystic.offline` tag, network acknowledgement behind a non-empty queue, the DDL gate, the
   invented-collection probe, and the live-read degrade with the per-transactor reachability gate it
   and the queue share.
5. **Persistence** (implemented, in three tickets). The journal port in db-core with the queue's
   write ordering and restore operations; the journal over `IKVStore`, retained outcomes in it, and
   the `NODE_KV_NAMESPACES` entry; restore in `hydrate` and `offline.restore`, with deferral of a
   record whose table cannot be reached.
6. **Reachability in `db-p2p`** (implemented, in four tickets). The key-network implementation of
   `ICohortReachability` and its wake on connection events; the solo-refusing write option, set by
   every drain unless the application opts out with `allowSoloCommit`; the typed answer for a block
   no machine answered; and the plugin wiring: the node's gate registered on the `network`
   transactor, its wake routed through the controller, and `offline.allowSoloCommit`.
7. **The outlook from guards alone** (implemented, in two tickets). Compute `CommitOutlook` from the actions' guards and the queue,
   with no Quereus change: every `absent` and `absentRange` guard is exposed unless its column is
   tagged fresh, every `unchanged` guard is exposed unless its row was inserted by an unsettled entry
   under a tagged-fresh key or the table is tagged single-writer, and `unchecked` is left empty
   (reported as not computed). Deliver it on `queued`, `outlook-changed` as dependencies settle, the
   `CommitOutlook()` function, and the `offline:assured-entry-failed` log. Useful on its own for
   applications that generate ids in the app.
8. **The write description in Quereus** (shipped in Quereus 4.21.0): `Statement.getWriteScope()`
   and the module hook that hands it to the vtab for the executing statement — the DML read scope
   with binding modes, per-column value provenance, target-row selection, and constraint
   classification.
9. **The outlook from the write description** (implemented, in three tickets). Fresh-value
   detection from provenance, `unchecked` decisions, dependencies through unchecked reads, and the
   journaling of the facts the first two rest on, so a restored transaction is judged with them.
10. **Guards that accept an already-applied write** (implemented, in two tickets). The three
    variants in db-core with the per-segment tally and the queue's `effect`; in the plugin the
    gates on the write description's self-independence and disposition facts, the
    `optimystic.content_key` tag, the `already-applied` effect on `committed`, and the outlook's
    `tolerates`.
11. **Later, each separately:** the constraint re-check before submission; session-mode re-execution;
    submission as a long-lived pend; column-level actions for blind partial updates; the
    `optimystic_queue` virtual table (backlog `feat-offline-sync-queue-virtual-table`).

## Test plan

Scenarios each stage should pin, on the in-process mesh (`packages/db-p2p/src/testing/mesh-harness.ts`,
which can isolate and restart a node) unless stated.

Stage 3 pins the scenarios that need no SQL. `packages/db-core/test/offline-queue.spec.ts`, over
`TestTransactor`: several entries drained in order, each reported `queued`, `submitting` and
`committed` once, with its log entry under its own action id at its local commit time; an entry over
two trees committed under one action id; nothing sent while the reachability gate is closed; a rival
taking a key a queued insert used, failing that entry with `constraint`, a later entry that updated
the row with `concurrent-modification` and `causedBy` naming it, and one after that in turn, the rows
gone from the local read; a refusal a reader's refresh found before the drain did; a promise
shortfall waiting for the cohort; an unclassified failure re-driven under the same action id; a
write-ahead hook that throws; an in-doubt entry that `discard` refuses and whose passed expiry is
deferred, then finished from its recorded attempt with its log holding it once; `discard` of a never-sent entry while
the head is on the network; a partly committed entry finished, and one whose remainder is then
refused, failing with its committed half named. `packages/db-p2p/test/offline-queue-mesh.spec.ts`,
on a two-member mesh: an entry over a table and its index pended and committed as one record per
phase and read back on the other node, and a rival's commit between that entry's refresh and its pend
failing it with `constraint`, leaving nothing of it on either collection.

Stage 4 pins the SQL scenarios on a two-node mesh:
`packages/quereus-plugin-optimystic/test/offline-mode.spec.ts` (an offline commit followed through
`queued`, `submitting` and `committed` to the other node; several entries over a table and its index
drained in order, an index-driven read and a full scan agreeing; the acknowledgement fixed at BEGIN;
`discard` before and after send; the two refusals between session mode and offline mode),
`packages/quereus-plugin-optimystic/test/offline-mode-removal.spec.ts` (a rival's primary key failing
an entry with `constraint`, its row leaving the view, a watcher waking, and the update queued over it
failing with `causedBy`; `concurrent-modification`; a rollback and a savepoint rollback during the
drain), `packages/quereus-plugin-optimystic/test/offline-mode-network-ack.spec.ts` (the `'network'`
tag, and a network-acknowledged commit waiting behind the queue, both timeout arms included),
`packages/quereus-plugin-optimystic/test/offline-mode-ddl-gate.spec.ts` (DDL refused while a
transaction that wrote the table is queued, allowed once it settles),
`packages/quereus-plugin-optimystic/test/offline-mode-invented-collection.spec.ts` (the joiner) and
`packages/quereus-plugin-optimystic/test/offline-mode-reads.spec.ts` (live reads served locally
through an index and a scan alike, the fail-loud read outside the mode and for a `'network'` table,
a read and the queue waiting on one gate, a table never read failing, and a write's uniqueness probe
degrading); `packages/db-core/test/invented-collection-adoption.spec.ts` pins the invented-collection
probe at the collection tier. `packages/quereus-plugin-optimystic/test/offline-journal.spec.ts` pins
the write side of stage 5: the records an offline commit over a table and its index leaves, in queue
order, and what its drain leaves; a journal that refuses the entry record failing the commit; what
survives a crash after the drain committed and before the deletes were flushed, and after one
refused send; two labels over one store.
`packages/quereus-plugin-optimystic/test/offline-restore.spec.ts` pins the restore side: a crash
after the network commit and before the journal delete, with the node store synced and with it lost,
each reported committed once with one log entry; a crash after the local acknowledgement, put back by
`hydrate` and readable before the cohort is reached; a crash with the send held at the cohort, the
entry in doubt and drained once under the recorded action id; an unknown-version record; two labels
over one store; a table dropped while down, deferred and discarded; a table unreadable at restore,
deferred and put back by the first read that reaches the cohort; a new offline commit waiting behind
a deferred record and draining after it; `discard` refused for the record a pass is putting back at
that moment; a restored entry refused by a guard; an entry record left beside its outcome; and
`restore()` refused inside a transaction; and a deferred record with nothing else queued, put back by a
gate's wake.

Stage 6 pins the gate itself in `packages/db-p2p/test/cohort-reachability.spec.ts`, the solo refusal in
`packages/db-p2p/test/offline-queue-mesh.spec.ts` (a lone coordinator refusing an entry while it knows
its partner is missing, and committing it at `local` under `allowSoloCommit`), and the SQL scenarios in
`packages/quereus-plugin-optimystic/test/offline-mode-two-machine.spec.ts`, over node A's real gate on
the two-node mesh with B away: an offline write queued and sent nowhere, a live read serving it, and
the drain on B's return reported `queued`, `submitting` and `committed` once each, woken by the gate
with the re-check timer too long to explain it; and `expireAfterMs` reached while B is away, the entry
failing `expired`, never sent.

Stage 7 pins the outlook from guards in
`packages/quereus-plugin-optimystic/test/offline-outlook.spec.ts`. On one node whose gate never opens:
an insert then an update in one transaction, assured under a fresh key and exposed once on the key
under a natural one; an update of a row an earlier queued entry inserted under a fresh key, assured
with that entry in `dependsOn`; an update of a row committed before going offline, exposed with its
key; an insert under a fresh key into a table with natural UNIQUE columns, exposed on each decoded
value; `CommitOutlook()` inside an open transaction and outside one; and an assured update failing
through the discard of the entry it depends on, neither re-judged on the way nor counted, and one
whose failure the queue attributes to a nearer failed entry it never depended on, not counted
either because the entry it did depend on failed. On a
two-node mesh whose first node's gate the test opens: an update of a single-writer table's row an
earlier entry inserted under a natural key, exposed only through that entry and told
`outlook-changed` to assured after it commits and before the update is sent; and a false
`"optimystic.fresh"` tag, the entry assured, failed with `constraint` when the other node takes its
key, logged as `offline:assured-entry-failed` with the table and key, and counted. Every offline spec
also checks its predictions against their outcomes (the last item below):
`packages/quereus-plugin-optimystic/test/outlook-predictions.ts`
tracks each plugin `createMeshDbNode` and the offline specs' own helpers register, and a root
`afterEach` fails a test that leaves any tracked plugin's `assuredFailures` above zero, unless the
test declared the count with `expectAssuredFailures`.

Stage 9's first ticket pins fresh-value detection from the write description.
`packages/quereus-plugin-optimystic/test/write-description.spec.ts`, over prepared statements on
memory tables with the plugin's `StampId()` registered, one case per rule of `freshElementsOf`: a
key from `StampId()` fresh; from `hex(randomblob(16))` fresh; a fresh blob under a lossy wrapper not
fresh; a parameter key not fresh; a composite key fresh through one column; a unique entry fresh
through one of its columns while the key is not; the upsert `DO UPDATE` arm, handed the INSERT's
description, nothing fresh; no description nothing fresh. `offline-outlook.spec.ts`, on a table with
no fresh tag: an insert under `StampId()` assured, and one under `hex(randomblob(16))`; the same id a
rolled-back insert minted, inserted again as a literal after `rollback to` the savepoint, exposed on
that key; and an update of a row an earlier queued entry inserted under `StampId()` assured with that
entry in `dependsOn`. The suite-wide check above now also catches a false `fresh` label end to end.

Stage 9's second ticket pins the unchecked decisions. `write-description.spec.ts`, one case per rule
of `uncheckedOf` over prepared statements: an insert into a child table a `foreign-key` on the parent
with the parent read consumed; a delete of a parent row a `foreign-key` on the child; an update by a
non-key predicate one `row-selection` and nothing for its target read; an update by key reading its
own column nothing; a subquery over the target under a key selection a `read`; an insert from a
select a `read` with the source's scope, global and group; a read pinned by a key keeping the key and
the bound values, widened to global while a value is unbound; a cross-row CHECK a `check` on the
written table beside the subquery's `read`; and the fold concatenating the statements' lists,
deduping with the pinned rows merged, and complete only while every write was described.
`offline-outlook.spec.ts`: a message under `StampId()` referencing a conversation an earlier queued
entry inserted under a natural key, assured with that entry in `dependsOn` `via: 'unchecked'` and the
foreign key in `unchecked`, then a transaction that both updates the conversation and inserts a
message listing the entry once, as `'guard'`; and a memo copied from one note by its key, depending
on the entry that inserted that note and not on the entry that inserted another — which pins the key
encoder and the key-span match together. Every `unchecked` the earlier cases assert is now `[]`.

Stage 9's third ticket pins the facts across a restart. `offline-restore.spec.ts`: two conversations
under natural keys, a message under `StampId()` referencing the first, and a conversation copied from
the first by its key, queued and then crashed after the local acknowledgement. The message's entry
record carries its one fresh key, the foreign key and `complete: true`; after `hydrate` every outlook
equals the one before the crash except the copy's, whose read is now matched by its table and so
depends on both earlier conversations; and the same records without `outlook` restore the message
exposed on its key with `unchecked: 'not-computed'`.
Stage 10's already-applied cases — two machines marking one task done, two deleting one row, two
incrementing one counter, and two inserting one row under `insert or ignore` beside a plain `insert`
— are pinned end to end in `packages/quereus-plugin-optimystic/test/offline-mode-two-machine.spec.ts`,
the gates over prepared statements in
`packages/quereus-plugin-optimystic/test/write-description.spec.ts`, and the outlook's reading of the
variants in `packages/quereus-plugin-optimystic/test/commit-outlook.spec.ts`. Every case below is
pinned.

- Offline commit, read back, reconnect, drain: the row is on the other machine, and `queued` →
  `submitting` → `committed` is reported once each, with the same `transactionId`.
- Several entries across a table and its index, drained in order; an index-driven read and a full
  scan agree at every step.
- A rival commits the same primary key while this machine is offline: the entry fails with
  `constraint`, its row disappears locally, a watcher fires, and a later entry that updated that row
  fails with `causedBy` naming it.
- A rival changes a row a queued UPDATE read: `concurrent-modification`.
- An entry queued, then an SQL transaction opened and rolled back while the drain commits the entry:
  the entry is committed exactly once (the double-commit the open-segment snapshot rule prevents).
- A savepoint rollback while the drain removes a refused entry.
- Crash after the network commit and before the journal delete
  (`PowerLossKVStore` for the journal and `MemoryBatchBackend({ deferSync: true })` for the node
  store, each with `powerLoss()`):
  after restart the entry is reported committed and the log holds one entry for it (pinned in
  `offline-restore.spec.ts`).
- Crash after the local acknowledgement: the entry is restored by `hydrate`, visible before the first
  network contact, and drains on reconnect (pinned in `offline-restore.spec.ts`).
- Two-machine group, one away: an offline-mode write on the other is queued, not committed alone,
  and drains when the partner returns (the deterministic replacement for the race recorded in phase 5
  of `packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts`, for writes made in the
  mode).
- A joiner that has never seen a table queues a write to it; the founder created the table
  meanwhile: the drain adopts the founder's collection and the row lands in it.
- A `'network'` table: its writes wait for the network in offline mode, and its reads fail while the
  cohort is unreachable.
- DDL refused while an entry for the table is queued; allowed after it settles.
- `discard` of a never-sent entry; refusal of `discard` for a sent one.
- `expireAfterMs` reached while unreachable.
- Outlook, one case per row of the guard table: an insert under `StampId()` or `hex(randomblob(16))`
  is assured; an insert under a natural key is exposed with that key; an update of a row created offline
  under a fresh key is assured, and becomes exposed (in a test of the residual) only if a rival
  writes the row between the two drains; an update of an existing shared row is exposed.
- A message inserted under a fresh key, referencing a conversation created by an earlier queued
  entry under a natural key: the message is assured with `dependsOn` naming the conversation's entry
  `via: 'unchecked'`; the conversation's entry is exposed.
- An entry exposed only through `dependsOn` receives `outlook-changed` to assured when the earlier
  entry commits.
- A false `"optimystic.fresh"` hint: the entry is reported assured, fails with `constraint`, and
  `offline:assured-entry-failed` is logged.
- Already applied: two machines mark the same task done offline, and two delete the same row; both
  entries commit, the second with `effect: 'already-applied'`. Two machines increment the same
  counter offline: the second still fails with `concurrent-modification`.
- Every assured prediction in the suite above that ends in `failed` for a reason other than expiry,
  discard, a validator rejection or the size limit fails the test: the prediction is checked against
  the outcome, not only computed.

## Open questions

- **Coalescing.** After a long offline period, draining thousands of entries one network transaction
  at a time costs three requests each on a two-member group. Coalescing consecutive entries into one
  network transaction, falling back to one at a time on the first refusal, would cut that at the
  cost of one wasted round per refusal. Worth it only if measured.
- **Constraint re-check.** Can the vtab evaluate a table's foreign keys and subquery CHECKs for a
  given set of rows outside a statement, against a chosen view, or does that need a Quereus API?
- **Failure hold.** Should an application be able to ask that a failed entry block the queue until
  it decides (retry with changes, or discard), instead of the cascade running immediately? Useful for
  an editor that wants to offer a merge; harmful for everything queued behind it.
- **Observed contention.** The outlook is static: it says another writer *can* make an entry fail,
  not that one is likely to. While online, the queue sees which tables and keys other machines
  actually commit to, and could rank exposures by that. Whether a ranked "likely to conflict" is worth
  the risk of an application treating a low rank as a guarantee is undecided.
- **Per-row ownership.** `"optimystic.single_writer"` is per table. Many applications partition rows
  by owner within one table (each device writes only rows whose `device_id` is its own). A per-row
  declaration — a column whose value names the only writer, compared against a context variable —
  would cover that, at the cost of the plugin having to know this machine's writer identity.
- **The default for `expireAfterMs`.** Unlimited is the safe default for data, but an entry that
  can never drain — its table's cohort is gone for good — then stays forever, holding back every
  entry behind it. A visible `oldestQueuedAt` may be enough.
- **Reads before the first sync.** An application whose first launch is offline has nothing to read
  and nothing to rebase onto; every table is invented. Whether offline mode should be refused until
  the database has synced once (as Sereus gates a joining machine today) or allowed with the
  invented-collection probe as the only protection is an application decision the plugin could make
  easier with a "has synced" signal.
