# Block Repository

## Overview

This document outlines the design for a Block Repository that provides efficient access to versioned data. The system manages blocks of data with versioning capabilities, allowing users to retrieve blocks at specific versions, update blocks conditionally, and mark blocks for eventual deletion.

The system provides these core operations through the `IRepo` interface
(`packages/db-core/src/network/i-repo.ts`):
- `get(blockGets[])`: Fetch blocks by their IDs and versions or specific transactions
- `pend(request)`: Post a transaction for a set of blocks
- `cancel(actionRef)`: Cancel a pending transaction
- `commit(request)`: Commit a pending transaction

`getStatus(actionRefs[])` — get statuses of block actions — is *not* on `IRepo`; it lives one layer
up on `ITransactor` (`packages/db-core/src/transactor/transactor.ts`), which is what applications
call. The sections below describe the per-block repo operations.

## Clusters

The Block Repository is designed around peer proximity in the DHT network.  Each peer is responsible for at least transactional (short term) storage of blocks in the address proximity, thus a given Block's storage is distributed across multiple peers (the "cluster").  When performing operations on a cluster, a client will choose a "coordinator" peer, which may be arbitrarily chosen, or chosen based on past performance or ID proximity.  The coordinator is responsible for coordinating the operation across the cluster, for the given transaction.

Here is how a transaction proceeds for a given cluster:
1. The coordinator receives the mutation (e.g. pend, commit, cancel), validates it, puts it in a record with a TTL, signs its own promise on it, then sends it in parallel to all other peers in the cluster.
2. If the coordinator receives a promise from the necessary number of peers, it, in parallel, responds with success to the client, and propagates the record with its own signed completion to the other peers in the cluster. 

* If the coordinator does not receive a promise from the necessary number of peers, before the TTL expires, or it receives failures, is signs as a failure and returns failures to the client.
* If the client looses connection to the coordinator, it can retry with a new coordinator.
* Peers will not sign their promise on a transaction that contradicts a previous transaction until the prior transaction is known to have failed or succeeded.  If a new coordinator is chosen, it will have to confirm consensus on the prior attempt before proceeding.
* If Peers receive invalid requests from other peers, they will whisper with the other peers to exclude the invalid peer from the cluster in the future.

## Repository Operations Description

### 1. `get(blockGets[])`

- **Purpose**: Fetch blocks by their IDs and versions or a specific transaction
- **Input**: Array of `BlockGet` objects containing:
  - `blockId` - A unique identifier for the block
  - `context` - Optional transaction context specifying either a revision or pending transaction
- **Output**: Array of `GetBlockResult` objects containing:
  - `block` - The block data
  - `state` - Current block state including latest revision or deletion status. `state.latest` is
    the newest revision the *answering repo* holds for the block — not necessarily the revision of
    the `block` it just returned
  - `materialized` - Optional; the `(rev, actionId)` the returned `block` actually is. Equals
    `state.latest` for an unpinned read; an older revision when a revision-pinned read serves older
    content. Consumers that need "what revision did this read observe?" (read-dependency recording)
    or must label the content when passing it on (a block-repair archive) use this, falling back to
    `state.latest` only for producers that omit it. One field carrying both halves, so a label can
    never pair one revision's number with another's action id
- **Behavior**: 
  - If no context is provided, returns the latest version
  - If a revision is specified, returns the block at the highest committed revision at or below it
  - If a transaction ID is specified, returns the block with pending changes applied
  - Fails if requesting a deleted block with pending transaction

### 2. `pend(request)`

- **Purpose**: Post a transaction for a set of blocks
- **Input**: `PendRequest` containing:
  - `transform` - The changes to apply
  - `actionId` - Action identifier
  - `pending` - How to handle existing pending transactions
- **Output**: `PendResult` indicating success or failure with pending transaction information
- **Behavior**:
  - Creates metadata for new blocks if needed
  - Can fail if pending='fail' and other transactions are pending
  - Saves block-specific transforms for each affected block

### 3. `cancel(actionRef)`

- **Purpose**: Cancel a pending transaction
- **Input**: `ActionBlocks` containing block IDs and transaction ID
- **Behavior**: Removes the pending transaction from all specified blocks

### 4. `commit(request)`

- **Purpose**: Commit a pending transaction
- **Input**: a single `RepoCommitRequest` object containing:
  - `blockIds` - Blocks covered by this commit
  - `actionId` - Action identifier
  - `rev` - Revision being committed
  - `tailId` - Optional; the committing collection's chain tail block id, threaded through so the
    committing node can anchor the emitted change event
  - `blockDigests` - Optional; per-block declarations of what each block will contain once this
    action commits (see *Declared block content* below)
- **Output**: `CommitResult` indicating success or missing transactions needed
- **Behavior**:
  - Verifies expected revision matches current state
  - Updates block metadata and revision
  - Promotes pending transaction to committed state
  - Handles block deletion if specified in transform

#### Declared block content (`blockDigests`)

The client that authored a transaction knows what every block it touches will contain once the
transaction lands, so it says so: `blockDigests` maps a block id to a hash of that block's
post-commit content, plus the committed revision of the base the hash was computed from (absent for
an inserted block, whose content does not depend on any base). Only the client can declare this — a
coordinator forwards a commit without materializing it, and may not even have seen the pend.

Three properties are load-bearing:

- **It is optional, per block.** The client computes digests from what it already has in memory and
  never pays a network read to describe itself, so a block it cannot describe from memory is simply
  left out. An undeclared block is not an error; it falls back to the corroboration the cohort
  already does. The field is omitted entirely — not sent as an empty object — when a request
  declares nothing.

  What "from memory" covers is a property of the *transaction*, not of the read cache's size. When a
  change to a block is staged, the client pins the committed content it changed it from, and keeps
  that pin until the transaction ends — so a transaction that touches far more blocks than the read
  cache holds still describes every block it read and changed, rather than only the most recently
  read ones. The remaining undeclarable cases are a deletion (there is no post-commit content to
  describe), and a *blind* change — one written without first reading the block — to a block that is
  not in the read cache, where the client genuinely has nothing to describe.
- **It rides *inside* the commit request.** The request is the consensus message, and the cluster
  hash helpers canonicalise that message generically, so the declarations land inside every cohort
  signature's preimage with no change to the hashing. A peer built before this field existed still
  hashes the bytes it received, so upgraded and un-upgraded peers agree on the same hash.
- **Each cohort sees only its own blocks.** One transaction's blocks are split across coordinators,
  and each per-coordinator batch becomes its own cluster record. The transactor therefore narrows
  the map to the batch's own block ids at the moment it sends — not once up front, because a failed
  batch is re-split across different coordinators on retry. Shipping the whole map would make one
  cohort sign for blocks it is not responsible for.

Declaring content must never break committing it. Computing a digest replays the staged changes
against the locally cached base, which can legitimately fail (another action's commit may have
folded a different shape into the cache); that block is then left undeclared rather than raising an
error out of the client's sync.

**Who checks it.** A declaration is worth nothing until someone independently reproduces it. Each
cohort member does that on the commit's *promise* round: it re-materializes the block from the
transform it was handed at pend and votes reject (reason `content-digest-mismatch`) when the result
disagrees. A member that cannot reproduce the answer — it never saw the pend, or it holds a
different base for an update-only block — abstains rather than guessing. See
[internals.md](internals.md) "Commit content-digest check (promise round)" for the full
checkable/abstain rule, and `docs/correctness.md` §2 **Content digest declaration** for what an
approval does and does not attest.

**What `baseRev` does at apply time.** The declared base is not only an input to that vote. When
the commit is applied, a member that holds a base *other* than the one the author computed against
refuses the commit outright rather than applying the author's edits to different bytes — which
would leave it holding different content under the same revision number, permanently. The base the
member compares against comes first from the *pend*: `PendRequest.baseRevs` names, per update-only
block, the committed revision the operations were computed against, and storage keeps it with the
pending record (see *A pending record claims a slot* below). The commit's `baseRev` is the fallback
for a record whose pend named none, and a commit whose declaration disagrees with the stored base is
refused too. So the fork protection no longer depends on declaring content: a block whose pend named
its base is protected whether or not its digest was declared, and only a sender that names no base
anywhere is left unprotected — by choice, so that older builds keep committing. What not declaring
still costs is the replication cost in `docs/correctness.md` §"The cost of not declaring". See
[internals.md](internals.md) "An update-only transform is applied only to the base its author read".

#### Invariant P — a pending record and a committed record never coexist for one action

A block never holds a pending record and a committed record for the same action id at the same
time. On the commit path this holds because promotion *moves* the record from the pending namespace
to the committed one atomically (a single rename on the filesystem backend, a synchronous two-map
swap in memory) rather than copying it.

Every **other** writer of a committed transform for a block must maintain the same invariant by
deleting that action's pending record when it writes the committed one. Today those writers are the
forward-write paths `BlockStorage.saveReplica` (replica persist, e.g. churn re-replication and the
divergence reconcile) and `BlockStorage.saveDeletion` (forward tombstone); both go through
`saveForwardRevision`, which performs the deletion. Any forward path added later inherits the
obligation.

`StorageRepo.pend` carries the mirror-image obligation: it must not *create* the coexistence in the
first place. A re-pend of a block this same action already committed at the requested revision (the
retry of a *torn action* — a write whose blocks committed one group at a time, some landing and the
rest refused) is waved through as **satisfied** and no pending record is written for it. Writing one
would strand it exactly as the paragraph below describes: `commit` partitions that block as
already-done and never promotes the record.

Two mechanisms *enforce* that obligation rather than merely stating it:

- **`pend` classifies and saves under one hold.** It takes the write latches for all of its blocks
  up front (`acquireBlockWriteLatches`, the same sorted, deduped entry point `commit` and
  `applyInvalidation` use), then runs two passes inside that hold: pass 1 reads each block's
  `latest` and decides satisfied / stale / pendable, pass 2 writes the pending records. Because the
  read and the write are one atomic step, no commit can land in between and make a decision from
  pass 1 obsolete. Splitting it into two passes rather than one interleaved loop also means a block
  refused partway through leaves *no* records written for the blocks before it — every refusal path
  returns having written nothing.
- **The storage seam refuses the write outright.** `BlockStorage.savePendingTransaction` takes the
  revision the record claims and throws `PendRevisionTakenError` when the block has already
  committed at or past it. Its question is "could this record ever be promoted?", not "is this our
  own revision?", so one `latest.rev >= rev` comparison covers both unpromotable cases: our own
  already-committed revision (`===`, which `commit` treats as already-done) and a rival's win
  (`>`, which `commit` refuses as stale). A pend that claims no revision (an insert-only pend, with
  no `rev`) names nothing to compare and is unaffected. The refusal costs no extra read — that
  method already reads the block's metadata — and under the hold above it is unreachable from
  `pend`, so a throw means some caller reintroduced a check-then-act split.

The invariant matters because a pending record left beside a committed one can never be promoted:
once the block's `latest` has advanced past the revision the record was pended at, a commit retry
partitions the block as already-done or stale and never revisits it. `pend` then reports that
record as a conflicting action on every later write to the block — under the fail-on-pending policy
the node refuses those writes outright and can only catch up by replication, so it looks healthy
and serves reads while silently contributing nothing to that block's writes.

The commit path itself also drops records that become unpromotable when it abandons a batch. It
does so **only** for divergence failures (this node holds no materializable base for a block, or
never received the pend), because the cluster layer reconciles the whole batch after those and every
block advances past the action. A genuine storage fault keeps the batch's pendings, because that
failure is retried and the retry can still replay them.

#### A pending record claims a slot, and reserves the block until a writer builds on it

A pending record is not a bare "someone is writing this block"; it is a reservation for the
revision its pend asked for. Storage keeps that revision beside `latest` (`BlockMetadata.pendingRevs`
in `packages/db-p2p/src/storage/struct.ts`, written by `BlockStorage.savePendingTransaction` in the
same metadata write that seeds a fresh block, dropped with the record by `deletePendingTransaction`)
and hands it back joined onto the record as a claim (`IBlockStorage.listPendingClaims`, or one
record's claim through `IBlockStorage.pendingClaimOf`). Beside it — written, dropped and swept in
the same metadata writes — storage keeps the **base** each record's update operations were computed
against: the pend's `PendRequest.baseRevs` entry for the block, kept as `BlockMetadata.pendingBases`
and read back as `PendingClaim.baseRev`, so that whatever later applies the record can refuse to
apply it to a different version of the block. A record whose pend named no base for the block (an
inserted or deleted block, or a sender that names none) simply has no entry, as does one written
before the field existed; the two maps are siblings rather than one map of pairs so that older
metadata reads without a migration. The base is stored as told and never checked at pend time: a
member has no grounds to second-guess the author's claim about its own computation, and a pend-time
refusal on a mismatch would be the wrong tier — a member holding a torn or abandoned higher revision
would veto every honest retry, whereas the same mismatch at commit is one member's refusal that
heals by reconcile (the `NOTE:` at `declaredBaseFor` in `packages/db-p2p/src/storage/storage-repo.ts`).
Both maps live in the metadata rather than in the record because the raw drivers promote a record
by moving its bytes into the committed store unchanged — a rename on the filesystem backend — so
the record's value has to stay a plain transform.

Both rival scans — `StorageRepo.pend` at apply and `ClusterMember.validatePendOperations` at the
promise vote — read a record through one rule, `isReservationAgainst` in
`packages/db-p2p/src/storage/pending-claim.ts`, fed the same two facts about the incoming pend:
the revision it requests, and the base it declares for the block (`reservationRequestFor`, which
reads `PendRequest.baseRevs` exactly as storage keeps it — nothing for an inserted or deleted block,
nothing for a malformed entry). A record stops reserving once the incoming writer has **built on**
it, meaning its operations were computed against a version of the block that already holds the
record's change:

- **With a base** (every update-only block from a current writer): a record claiming a slot **at or
  below** the declared base is superseded — the writer read the block with that change in it,
  whatever became of the record's action (committed there, and this member merely missed the
  commit; or lost the slot). A record claiming a slot **past** the base reserves, however far the
  requested revision has moved: the writer read the block without that change, and admitting it
  would let its commit apply over the stale base and sweep the record — the record's change lost
  while the log names it. That is the shape the revision rule alone admitted from four members up,
  where one member can miss a pend entirely and then serve a handle with no floor for the block one
  change short while the record's data-block commit is still in flight
  (`packages/db-p2p/test/rival-superseded-only-by-a-writer-that-built-on-it.spec.ts`).
- **Without a base**, the requested revision stands in for it. Revisions are allocated per
  collection and a writer pends at one past the collection revision it read, so a record claiming
  the requested revision **or a later one** reserves — a live rival inside its pend-to-commit
  window, and admitting the pend would put two writers in one slot — and a record claiming an
  **earlier** revision is superseded: the collection has moved past its slot, which is taken as
  having been built on.
- A record with **no** claim on file — pended without a revision, or written before the revision
  was kept — reserves, so an old record can only refuse more than it should, never less.

The base arm is never more permissive than the revision arm (an honest base is below the revision
it pends at), so it only ever holds more. Superseding was introduced for
`a-member-that-missed-a-commit-refuses-every-later-write`: a member that promised a write and missed
its commit kept the record, nothing would ever remove it (its writer believed the write succeeded,
and it had), and the member vetoed every later write to the block, from every writer, until it
happened to read the block itself. The base arm keeps that fix: a writer that read the block from a
member holding the change declares at least that revision, and one served by the missed-commit
member itself is served after that member promotes the record (`StorageRepo.get` promotes a held
record for any action the reader's context names, when the record's stored base is the member's
latest). The member comes current when the admitted pend's own commit applies — through
`StorageRepo.internalCommit`, or through the behind-reconcile its fork guard triggers. What holding
more costs is liveness, never safety, in two shapes recorded at `isReservationAgainst`: a writer
that read the block one change short is held until the record's action commits, and today its
retries do not re-read the block, so it then re-pends on the stale base and its commit is refused
(backlog `bug-a-writer-held-by-a-change-it-never-saw-retries-on-its-stale-copy`); and a record
whose change no member will ever take — an abandoned action's, on a block no later write touched, or
a base-less one from an older sender whose data-block commit never ran — is no longer superseded by
the collection moving on (backlog `debt-unpromotable-pending-records-need-a-sweep`).

The commit vote checks the base from the other side: a member whose record for the action carries a
base other than the one the commit declares for the block (`blockDigests[id].baseRev`) votes reject
with `base-declaration-disagrees` (`ClusterMember.validateCommitBaseDeclarations`), one round before
`StorageRepo.internalCommit` would refuse the same commit at apply.

A record claiming a revision the block has **already reached** can never be promoted here at all
(promotion needs `latest.rev < rev`, and `latest` only advances), so every path that advances
`latest` sweeps such records and their claims under the block's write latch
(`BlockStorage.sweepDeadClaims`, from `setLatest`, `recover` and `saveForwardRevision`): the loser
of a same-slot race whose cancel never arrived, and the missed commit above once the block moves past
it — including a replica landing under a *different* action, the reconcile shape that used to leave
the missed action's record standing forever. The committing action's own claim is dropped by `setLatest`
with no delete, since promotion already moved its record; `recover` still deletes each recovered action's
record, since a retry may have re-pended it while the lost `setLatest` was owed. A record with no claim on file is never swept, because
its death cannot be proved. This is the locally decidable half of what backlog
`debt-unpromotable-pending-records-need-a-sweep` asks for; a record whose slot the block has not
reached and whose writer never came back is the half that ticket still owns.

#### A pending record's lifetime is bounded by its writer

Invariant P constrains which states may coexist on a member; this sibling rule constrains how long
the pending state may outlive the transaction that created it. Only four things ever remove a
pending record: the client's `cancel` (routed through consensus, so every member drops it), a
divergence-shaped commit refusal (`StorageRepo.dropUnpromotablePendings`), a forward write
carrying the *same* action id (`BlockStorage.saveForwardRevision`'s same-action delete), and the
dead-claim sweep that runs whenever `latest` advances to or past the revision a record claims
(`BlockStorage.sweepDeadClaims`, the section above). There is no age bound and no background sweep,
and the sweep only ever removes a record whose promotion has become impossible. So the writer that pends a block owns its record's fate: when
`NetworkTransactor.commit` returns, every block in the request must be either **committed** or have
had its pending record **cancelled** — a client that reports success while walking away from a
pended block strands the record permanently, and the members then reject every later write to that
block from any writer (the wedge described two paragraphs up). The one path that violated this — a
non-tail sweep whose transport failed after the tail committed — now cancels the abandoned blocks
before acknowledging.

The cancel that discharges a record is a **checked, retried** operation, not a single best-effort
shot. `NetworkTransactor.cancel` runs rounds until every block of the action has had its cancel
answered by some peer, re-resolving coordinators each round and backing off between them, and it
**throws** — naming the action and the blocks still held — if it runs out of budget having reached
nobody. The retry is what distinguishes the two faults that used to look identical from the client:
the peer-shaped one, where an alternate coordinator answers immediately (already handled by the
batch layer's own retry), and the time-shaped one — a stream reset — where every peer is equally
unreachable for the length of the fault and only a delayed re-attempt clears it. Checking matters
just as much as retrying: the batch layer records each RPC's outcome and swallows the rejection, so
without an explicit completeness test a cancel that reached nobody returns exactly like one that
discharged everything, and every caller reads "returned" as "discharged". The same discipline
applies to the cancel a failed pend issues for itself: it is awaited before the pend reports
failure, so a caller that retries immediately does not meet its own still-standing record and spend
an attempt on it.

Callers must not let that throw displace the verdict it is cleaning up after: a confirmed conflict
is still returned as a stale failure so the writer rebases, and a transport fault is still the error
thrown — the cancel failure rides along beside it. Budgets are finite, so a fault outlasting one
still strands the record; a node-side backstop for that residual is tracked in backlog
`debt-unpromotable-pending-records-need-a-sweep`.

A stranded record is at least **named** rather than left to be re-derived. Every refusal it causes is
reported as an ordinary optimistic-concurrency loss, because that is what a single refusal is
indistinguishable from — so a permanently wedged block's logs read exactly like a busy block's. What
no healthy reservation produces is *repetition against an unchanged holder*: a healthy holder keeps
the block only for its own pend-to-commit window, so at most (concurrent writers − 1) distinct actions
can lose to it before it releases. `coordinator-repo:stuck-reservation` (`noteStuckReservation` in
`packages/db-p2p/src/repo/coordinator-repo.ts`) says the condition out loud once per episode, when one
unchanged holding action has refused eight *distinct* later actions on a block — distinct actions, not
refusals, since a retrying writer reuses one action id (minted once per sync cycle in `syncInternal`,
`packages/db-core/src/collection/collection.ts`). The line carries the block id, the holding action
ids, the count, and prose naming the only two cures: a cancel for that action id, or that action's own
commit. The counting, threshold and wording live in `StuckReservationTracker`
(`packages/db-p2p/src/repo/stuck-reservation.ts`), and every member keeps its own instance too, fed
by its own `held` votes (`cluster-member:stuck-reservation`, from `ClusterMember.validatePendOperations`):
the coordinator can only name a holder its own storage corroborates, so a reservation only some
members hold is named by those members, where the record lives. Like every diagnostic in this
package both go to the `debug` logger, so a node that may need them has to be running with
`DEBUG='optimystic:db-p2p:coordinator-repo*,optimystic:db-p2p:cluster-member'` — see
[debugging.md](debugging.md). It is a diagnosis only — nothing expires, refuses, or deletes a record on the strength of it,
which remains the open problem the backlog ticket above exists for. What reaches either counter
since the section above is the *same-slot* residue only: a record claiming a slot the collection has
already moved past no longer refuses at all.

## Block Storage Repository

![Block Storage Repository](figures/storage-repo.svg)

Block Storage Repository nodes maintain the following state information:
- Latest revision number
- Deletion status (if applicable)
- Pending transactions
- Materialized versions at specific revisions

The system uses a materialization strategy where:
- Blocks can be materialized at any revision by applying transforms sequentially
- Materialized versions are cached to improve performance
- Pending transactions can be applied on top of any materialized version

## Transaction Processing

Transactions go through the following lifecycle:
1. **Pending**: Posted via `pend()` but not yet committed
2. **Committed**: Applied to blocks and assigned a revision number
3. **Materialized**: Full block state computed and cached at specific revisions

The system supports:
- Optimistic concurrency through revision checking
- Transaction conflict detection
- Block restoration through callback mechanism
- Materialization caching for performance

## Block Lifecycle

* **Creation**: Blocks are created through insert transforms
* **Updates**: Applied through pending and committed transactions
* **Deletion**: Marked via delete transform, maintaining revision history

Revisions within a block also have a lifecycle:
* **Checkpoint materialization**: Each committed revision keeps its forward *transform* (the delta that
  produced it) forever, but a full *materialized* copy of the block is retained only at **checkpoint**
  revisions — every `CHECKPOINT_INTERVAL`th rev (default 32), plus the block's tip and the floor of each
  contiguous locally-held range. Redundant intermediate materializations are pruned incrementally as new
  commits land (under the block's write latch, no separate background pass): each commit deletes the
  now-superseded prior materialization unless that rev must be retained. Because every transform is kept
  and a materialization survives at each range floor + checkpoints, **every locally-held revision is still
  reconstructible** by replaying the forward transforms from the nearest retained materialization at or
  below it (replay depth bounded by `CHECKPOINT_INTERVAL`). This keeps storage growth O(revisions × delta
  size) instead of O(revisions × block size). Since no transform is dropped, `meta.ranges` is **unchanged**
  by sweeping — a swept rev is still honestly claimed as present. Pruning the *transforms* of cold ranges
  (which would fragment `ranges` and require restoration) is future work — see the cold-range transform
  offload backlog item.
* **Restoration**: Previous versions can be restored from archival storage as needed

## Implementation Notes

The system is implemented with these key components:
- `StorageRepo`: Main implementation of the repository operations
- `IBlockStorage`: Interface for block storage operations
- `RestoreCallback`: Optional mechanism for block restoration
- `withReadCache`: the single seam that puts the write-through read cache in front of a
  persistent raw storage. `StorageRepo` builds a fresh `BlockStorage` per block per call and
  `BlockStorage` re-reads block metadata on essentially every operation, so nothing above the
  raw-storage boundary memoizes — over a filesystem backend that is hundreds of reads of the same
  small files per statement. Why the cache is safe to read from (and the single-process-owner
  precondition it depends on) is argued in
  [`packages/db-p2p/docs/storage.md`](../packages/db-p2p/docs/storage.md) — see **Invariants** 1-5
  and **Core Components § 6, Write-through raw-storage cache**.

The storage layer maintains separate stores for:
- Block metadata (e.g. latest revision, deletion status)
- Revisions
- Transactions (both pending and committed)
- Materialized block versions

### Capacity estimation and staleness

`StorageMonitor.getCapacity` reports how full the store is. Used bytes come from the backend's
`getApproximateBytesUsed`, which is a **full-store scan** (LevelDB iterates every key+value, the
filesystem adapter stats the whole tree). Ring selection calls `getCapacity` several times per
operation, so the scan is memoized behind a short TTL (`usedBytesCacheTtlMs`, default 60s; `0`
disables it). Within the window callers share the cached value; concurrent misses share a single
in-flight scan; a supplied `usedBytes`/`availableBytes` override bypasses the scan (and the cache)
entirely.

Consequence: the reported `used`/`available`/`usedPercent` may lag reality by up to the TTL. This
staleness is acceptable — the sole consumer, ring selection (`RingSelector`), damps its move
triggers with EWMA smoothing, a hysteresis dead-band, and a 10-minute minimum dwell. A ≤60s-stale
reading cannot cause a wrong or premature ring move; at worst it delays one by up to the TTL, which
is immaterial against the 10-minute dwell. **`RingSelector` therefore needs no forced-fresh read at
decision boundaries** — the cached estimate is authoritative for its purposes.

- NOTE (tripwire): the default TTL (60s) equals the ring monitor tick interval (the `setInterval` in
  `libp2p-node-base.ts`, also 60s), so each `shouldTransition` tick folds a roughly-fresh sample into
  its EWMA. If `usedBytesCacheTtlMs` is ever raised *above* the tick interval, consecutive ticks would
  fold the *same* cached (stale) sample into the EWMA, biasing the smoothed depth toward the stale
  value. Damping (dead-band + 10-min dwell) absorbs this today; only revisit if the TTL is raised past
  the tick interval or the tick is shortened below the TTL.
