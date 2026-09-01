# Optimystic Internals

A condensed guide to internal architecture, invariants, and pitfalls for developers and AI agents.

## Data Flow

### Read Path (Block Retrieval)
```
Collection.selectLog()
  → Tracker.tryGet(blockId)        # Applies pending transforms to source block
    → CacheSource.tryGet(blockId)  # Returns structuredClone of cached block
      → TransactorSource.tryGet()  # Fetches from network/storage
        → BlockStorage.getBlock()  # Materializes block at revision
          → materializeBlock()     # Finds materialized block + applies transforms
```

#### Quereus vtab read path — pull-on-read is shape-independent

`OptimysticVirtualTable.query()` is the single read entry point for the
`quereus-plugin-optimystic` virtual table, and **every** read it serves first
reconciles to the latest committed network state by calling `collection.update()`
(`Tree.update` → `Collection.update` → `log.getFrom(rev)`) before yielding rows.
This holds for all three read methods — `executeTableScan`, `executePointLookup`,
`executeIndexScan` — and therefore for **all** SQL read shapes, **including
`count(*)` / aggregates**. Quereus answers an aggregate by streaming rows from an
ordinary scan (there is no row-count vtab API), so a bare `select count(*)` plans
as a `fullscan` → `executeTableScan` → `collection.update()` pull, byte-for-byte
the same access path as `select <col>`; a `count(*)` carrying a primary-key
predicate routes through `executePointLookup`, which also pulls.

Convergence is consequently **pull-on-read and shape-independent**: a peer observes
another peer's committed appends on its next read of *any* shape. There is no
background write-propagation in the default (cohort-topic-disabled) config (the
reactive-watch / cohort-topic push paths below are opt-in), so a *write-only* peer
must read — e.g. poll `count(*)` — to converge; that polling is the intended
pattern, not a workaround.

A suspected gap — that `count(*)` alone skipped the pull and so a count-only
consumer never saw a peer's appends — was investigated and **empirically
disproven** by `packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts`,
which spies on `query()` / the execute* methods / `Tree.update` and confirms that
(a) every `count(*)` shape reaches `query()` and issues a pull, and (b) a second
writer's committed rows are visible to a count-only reader after that pull. No read
shape is served from the local materialized tree without first reconciling.

#### Conflict replay must read at the revision it is adopting, not the one it is leaving

`Collection.updateInternal` (`packages/db-core/src/collection/collection.ts`) advances
its revision cursor (`Collection.advanceContext`) **before** replaying conflicting
pending actions (`replayActions`), never after. This ordering is load-bearing, not
cosmetic: `replayActions` re-reads blocks through `this.source` (a
`TransactorSource`), and the transactor materializes a block at
`context.rev` — the revision named by that source's `actionContext`. If the cursor
had not advanced yet, the replay would re-read at the revision the collection is
leaving, refilling `sourceCache` with pre-commit content. Nothing would ever clear
it again: cache invalidation for a block is driven by the log entry that named it,
and that entry was already consumed earlier in the same `updateInternal` call. The
result was a permanent divergence for those blocks — visible even after the local
transaction that triggered the replay was rolled back — until an unrelated future
commit happened to touch the same block again. See
`packages/db-core/test/collection.spec.ts` ("external commit visibility after
conflict replay") for the regression test, and
`packages/quereus-plugin-optimystic/test/external-commit-visibility-after-rollback.spec.ts`
for the end-to-end shape.

This also settles a question about intended semantics: a **live** read (the vtab
read path above, or any read through a collection's own `tracker`/`update()`) always
pulls the latest log and therefore observes a concurrent external commit — including
one that lands while a local transaction is open, and even after that transaction
rolls back. That is correct, not a leak: only the separate `committed.<Table>` path
(previous section) is snapshot-pinned. A plain `select` mid-transaction seeing a
concurrent peer's commit is expected live-read behavior; snapshot isolation is
opt-in via `queryCommitted()`, not the default for ordinary reads.

#### Committed reads are pinned, not shared-cache

`queryCommitted()` (the `committed.<Table>` / `_readCommitted` path) does **not** run
through the shared pipeline above. It routes **every** committed read through
`Tree.readView` — including a tree with nothing staged this transaction, which reads
its own current state through a pinned view rather than through the live tree.
`Tree.readView` → `Collection.createReadTracker` builds a private read stack per view: a fresh
`Tracker` seeded with the pre-transaction transforms, over a **private**
`CacheSource` (seeded by cloning the shared cache's current entries), over a
**private** `TransactorSource` whose action context is deep-copy **frozen** at the
boundary the snapshot was captured on (see the third bullet below; a snapshot with no
recorded boundary falls back to view-creation time). Because the transactor materializes at `context.rev`
(`BlockStorage.getBlock` resolves the highest committed rev ≤ the requested one), a
committed scan returns one point-in-time answer even when a commit folds into — or a
live read's `update()` clears — the live collection's shared cache mid-scan. The
regression anchors are `packages/db-core/test/read-view-pinned.spec.ts` and the
one-statement live+committed interleave in
`packages/quereus-plugin-optimystic/test/committed-read-interleave.spec.ts` (which,
pre-pinning, crashed with `Missing block` mid-scan). A pinned view records no read
dependencies by default (`ReadViewOptions.recordReads`), so a committed scan cannot
fail a concurrent writer's commit validation; deferred-constraint safety instead
rests on validator peers re-executing the recorded statements.

Three further properties hold for that path:

- **A committed read registers no connection.** `OptimysticModule.connect` with
  `_readCommitted: true` resolves the shared table — initializing it on first touch,
  and only *provisionally* (read-only: no schema write, no bridge registration, no
  change subscription) while a writer transaction is open, see
  `OptimysticVirtualTable.initializeForCommittedRead` —
  but skips `ensureConnectionRegistered()`, and the returned `OptimysticCommittedTable`
  wrapper refuses `createConnection()` and reports no `getConnection()`. So a committed
  read never appears in the engine's connection registry and never receives the
  writer's begin/commit/rollback/savepoint broadcasts — the connection class backing
  this vtab drives the *shared* `TransactionBridge`, so an enlisted committed view
  would drive the writer's transaction.
- **All of a scan's views are pinned in one synchronous block.** `runQuery` parses the
  access strategy first (pure string parsing), then builds the main-tree view and — for
  an index-driven plan — the index-tree view with no `await` between them. Splitting
  them across an await let a commit land in between, so an index-driven plan and a full
  scan of the same nominal snapshot could disagree.
- **A dirty tree's view pins to the SNAPSHOT's boundary, not the current one.** A
  `CollectionSnapshot` records the committed boundary (`context`) it was captured on
  (i.e. at `TransactionBridge.markDirty`, before the first stage), and `Tree.readView`
  pins the view to that boundary — excluding newer-revision entries from the warm cache
  seed. So while the legacy tree-by-tree commit sweep is mid-publish (main table
  flushed and its revision advanced; index still unflushed), a committed read of both
  trees still describes the one pre-transaction boundary. Regression anchor: the
  "mid-sweep shape" test in `packages/db-core/test/read-view-pinned.spec.ts` and the
  MID-SWEEP stall test in
  `packages/quereus-plugin-optimystic/test/committed-read-stall.spec.ts`.

`OptimysticModule` declares `concurrencyMode = 'reentrant-reads'`: concurrent
`query()` calls on one connected table are safe (every scan's mutable state is local to
its generator; committed scans read per-scan pinned views; a live scan's
`collection.update()` serializes behind db-core's per-`Collection`-INSTANCE latch — inside a
transaction the scans on a table share one instance and so that latch, and
`TransactionCoordinator` holds the same latch for its whole commit span so a refresh cannot
interleave with a mid-flight commit — regression anchor:
`packages/db-core/test/coordinator-latch-interleaving.spec.ts`, which parks a commit mid-flight
and releases an `update()` into the parked instant; outside a transaction each scan resolves its
own instance with its own tracker, so there is no shared collection state to serialize). Writes still
serialize, which is what keeps the bridge's single-writer state (below) unexposed.
`readCommittedSnapshot` is **also declared** (the stronger promise that a committed
read survives another connection's commit mid-scan), proven under a stalled commit in
both commit modes — see docs/transactions.md § "Committed reads run concurrently with
a stalled commit" for what holds it, the first-touch provisional initialization, the
conformance harness's blind spot, and the residual degraded-store limit.

### Write Path (Local Changes)
```
Collection.act(action)
  → actionHandler(action, tracker)  # Handler mutates blocks via tracker
    → apply(tracker, block, op)     # Mutates block AND records operation
      → applyOperation(block, op)   # Direct mutation via splice/assignment
      → tracker.update(blockId, op) # Records op in transforms.updates
```

### Commit Path (Distributed Consensus)
```
Collection.sync()
  → NetworkTransactor.transact(transforms)
    → pend() to all block clusters     # Two-phase: promise collection
    → commit() to log tail cluster     # Two-phase: consensus + commit
      → ClusterCoordinator.update()    # Coordinates with cluster peers
        → ClusterMember.update()       # Each peer votes
          → handleConsensus()          # Winner executes operations
            → StorageRepo.pend/commit  # Applies to local storage
```

#### Commit content-digest check (promise round)

The client that authored a transaction declares, inside the commit request it submits for
consensus, what each block it could digest will contain once the action commits
(`CommitRequest.blockDigests` — see `docs/repository.md` "Declared block content"). Each cohort
member then checks that declaration against its OWN copy of the pending change: on the promise
round, `ClusterMember.validateCommitOperations` calls `StorageRepo.previewCommitDigest`, which
re-materializes the block from the member's pended transform (mirroring `internalCommit`'s reads,
but read-only and without the block's write latch — it runs on the vote path, ahead of the
commit that will take that latch), and votes reject with the signed reason
`content-digest-mismatch` when the results disagree.

A member cannot always check. `StorageRepo.commit` accepts a commit whenever
`latest.rev < request.rev` — not only `latest.rev === request.rev - 1` — so a lagging member
applying an update-only transform to an older base legitimately materializes different bytes.
The checkable/abstain rule is therefore keyed on the member's own pended transform (the same
payload the client authored, delivered at pend):

| Member's pended transform for the id | Member behaviour |
|---|---|
| carries an `insert` (with or without updates) | base-independent — always check; digest mismatch → reject |
| `updates` only | check iff local `latest.rev` equals the declared `baseRev`; otherwise abstain |
| `delete` only, or a base this node cannot materialize | materializes nothing to compare — abstain |
| no pending transform for the action | member never saw the pend — abstain, never reject |

"Abstain" means: contribute no content attestation, vote exactly as before the check existed.
Base-independence is decided by the member's own transform and never by the declaration, so a
hostile declarer can neither force nor dodge a check by mis-declaring `baseRev`; a surplus
declaration for a block the commit does not cover is ignored.

**The check runs on the promise round, not the commit round.** The commit-round vote is cast
deliberately blind: a member signs the commit whenever the cohort's promise approvals reach
super-majority, regardless of its own promise vote (`getTransactionPhase`). Promise-round
approvals are therefore the only votes that carry "I checked this", and downstream verification
depends on that placement.

Residual: a false declaration commits only if the declarer lies AND enough of the cohort is
simultaneously unable to check (lagging on update-only blocks, missed pends) that no honest
checker remains — any single caught-up honest member rejects. That is strictly stronger than
before, when commit signatures bound no content at all. The durable proof persisted from these
attestations is described next.

#### Durable commit proof (`BlockCommitProof`)

The in-memory `CommitCert` retained for reactivity (see "Cohort-Topic Origination Bridge" below)
lives in a bounded store with a 60-second TTL and signs only an opaque commit hash — useless as
repair evidence once the moment passes. `BlockCommitProof`
(`packages/db-p2p/src/cluster/commit-proof.ts`) is the durable counterpart: a self-contained
artifact carrying the commit `RepoMessage` verbatim (including the commit op's `blockDigests`),
the promise-round and commit-round vote signatures, and the membership-v2 digest with its full
sorted peer-id list. No public keys ride along — every signer's Ed25519 key is recovered from its
peer id, the same binding `peerIdBindsPublicKey` relies on. Measured size for a 10-peer cohort on
a two-block commit: 4578 bytes (`test/commit-proof.spec.ts`), comfortably inside the 1 MiB
control-message bound.

Verification is pure, throw-free on hostile input, and split to match what the two repair stages
know:

- `verifyBlockCommitProofClaim(proof, claim, thresholds)` proves "block B at revision R under
  action A was committed by this cohort" **without the block bytes**: recompute the membership
  digest from `peerIds`, the message hash, and the promise/commit hashes; verify and count each
  vote signature (dedup'd, signer must be in `peerIds`); require the promise approvals to reach
  super-majority AND the commit approvals a simple majority (the commit vote is cast blind — only
  promise approvals attest to content, only commit approvals prove the record actually committed);
  finally require the claim's `(blockId, rev, actionId)` to appear in the message's commit op,
  which is what stops replaying a genuine proof against a different revision or block. On success
  it surfaces the digest the op declared for the claimed block.
- `verifyBlockCommitProofContent(...)` adds the last step: the declared digest must exist and
  equal `canonicalBlockHash` of the received bytes.

Failures return a distinguishable `ProofFailure` reason and are never a reputation signal — a
malformed or unbound signer means the identity was not proven, mirroring
`ClusterMember.verifySignature`'s discipline.

**What a passing verdict does not say.** It says *the cohort listed in `peerIds` agreed*, not *that
is the right cohort for this block* — an attacker holding N keys can stand up their own cohort and
self-certify any block id at any revision. No offline check can close that: a block's cohort is
chosen by live placement and rotates over history, so there is no fixed expected set to compare
against. Any consumer accepting proofs from untrusted peers must corroborate the cohort separately
(overlap against the block's currently-derived cohort, or a membership anchor — see
`feat-cluster-membership-threshold-cert-anchoring`) and must
bound proof size and cohort count before verifying, since verification cost is one Ed25519 check per
approve vote.

**Persistence and retention.** `ClusterMember.applyConsensusOperation` builds the proof from the
consensus record (membership-v2 records only) and passes it into `StorageRepo.commit`, which
applies one rule after materializing: **a member persists the proof only when its own
materialization matches the digest the commit op declared** — otherwise it stores nothing and
logs `commit:proof-digest-mismatch` (or `commit:proof-undeclared` when the op declared no digest
for the block). A diverged member therefore never serves its divergent bytes as certified — and
the mismatch log is the first divergence signal this system has had. Proofs live in their own
logical store, keyed by `(blockId, rev)` — the same key shape as the revisions store, and
deliberately NOT the action keyspace: an action id is chosen by whoever originates a write and is
never re-derived or format-checked by the storing node, so no reserved action-id convention could
survive a client or peer picking that exact id. Every `RawStoreDriver` backend carries the proofs
store natively (its own map / subdirectory / table / tag byte / object store). Proofs survive
`pruneMaterialization` (which trims superseded materialized copies but retains
revision records) and live exactly as long as the revision itself; no revision-delete site exists
today. The landing paths that skip `internalCommit` — an idempotent re-commit of the same
`(actionId, rev)`, a Crash-D3 block whose lost `setLatest` `recover()` redoes, and a certified push
of a revision this node already holds — back-fill a missing proof under the same rule.
`saveReplicatedBlock` persists a proof only when its caller verified it against the exact bytes
being saved — the reconcile path is one such caller, and `BlockTransferService.handlePush` is the
other (see **Certified push** below).

**Back-filling onto an already-held revision.** When a certified push names a revision this node
already holds, `BlockStorage.saveForwardRevision`'s monotonic guard makes the save a no-op, so
nothing — including the proof — is written there. `StorageRepo.saveReplicatedBlock` back-fills it
instead, on its non-advancing branch, when the push and the held revision agree on **both** `rev`
and `actionId`. This is deliberately one layer above the guard: the proof was verified against the
*pushed* bytes, while a back-fill attaches it to this node's *held* materialization, and a diverged
holder's bytes at the same `(rev, actionId)` may differ. Routing it through
`persistProofIfContentMatches` is what withholds the proof in that case; storing it would make this
node serve content that fails its own proof, and `digest-mismatch` is **attributable** in
`certified-claims.ts`, so every receiver would penalize it. A held revision *newer* than the pushed
one is never back-filled — `servableProof` only serves the proof for `latest.rev`, so it would be
keyed to a revision this node will never serve. Without this, a node that landed a revision
proof-lessly (a legacy uncertified push, a corroboration-only heal) stayed a corroboration-only
holder for it even after valid evidence arrived — exactly the certification decay the certified-push
work exists to stop.

**On the repair wires.** Both block-repair wires now carry the stored proof, so a requester can
check a lone holder's claim with no second holder to corroborate against:

- *The archive wire.* `ArchiveRevisions` (`storage/struct.ts`) carries `proof?` **inside** the
  revision entry, so the proof and the `(rev, actionId)` it certifies travel together by
  construction of the shape. `serveBlockArchive` attaches the proof stored for the revision it
  ACTUALLY served, via `servableProof` — which fails closed to "no proof", never to "no archive",
  on a repo with no accessor, a throwing lookup, or a stored proof whose own message does not name
  this `(blockId, rev, actionId)` (`serve:proof-claim-mismatch`). The accessor is read off the repo
  the sync service is handed, so a node's `repoProxy` forwards `getBlockProof` to the LOCAL
  `StorageRepo` — a peer reports the proof it retained, never one re-fetched from its cohort.
- *The latest-query wire.* `latestClaimFromArchive` projects a `CertifiedActionRev` — the claim plus
  the proof, read off the same revision entry — and `CoordinatorRepo.queryClusterForLatest` carries
  it into `RevClaim.proof`.

Absence stays legitimate and every consumer must behave exactly as it did before proofs existed:
a pre-proof revision, a member whose materialization diverged, and an un-upgraded peer all serve
none. A replica obtained by repair now DOES carry the proof onward — when the heal was *certified*:
the reconcile path verified the proof against the exact bytes it persisted
(`verifyBlockCommitProofContent` binds the declared digest to the served content), so the proof is
retained through `saveReplicatedBlock` → `saveReplica` → `saveRestored` and certification no longer
decays across repair hops. A corroboration-only heal persists none, and the
`RestorationCoordinator` restore wire — which verifies nothing — strips any proof a remote archive
attached before persistence (`BlockStorage.restoreBlock`): an unverified proof re-served as this
node's own would launder another peer's artifact as retained evidence.

Both repair paths now DECIDE with a proof. Each runs peer-attached proofs through the shared
certification layer (`cluster/certified-claims.ts`) — the read path in
`CoordinatorRepo.queryClusterForLatest`, the commit-path reconcile in
`cluster/reconcile-block.ts` — and `selectQuorumRev` / `selectQuorumBlock` weigh the resulting
`certified` verdicts: a lone holder whose claim (and, for content, whose exact bytes) a verified
cohort commit proof certifies is accepted where uncertified claims still need distinct-peer
corroboration. What layer 1 proves is that the listed signers signed — NOT that they are the
block's legitimate cohort; anchoring the signer set to the block's derived cohort is
`feat-cluster-membership-threshold-cert-anchoring` (the `ProofAnchoring` hook is observational
until then).

### Change Notification (Reactive Wake)

`StorageRepo` implements `IBlockChangeNotifier` (db-core). It is the single commit
funnel for both the coordinated and direct paths, so it originates a per-collection
"this collection changed" signal that lets reactive consumers wake without polling.

```
StorageRepo.commit()                       # critical section (block locks held)
  → internalCommit() returns collectionId  # newBlock.header ?? priorBlock.header (delete)
  → release locks (finally)
  → emitCollectionChanges()                # one CollectionChangeEvent per distinct collection
StorageRepo.get()                          # read-driven promotion (context proves committed)
  → internalCommit() returns collectionId  # promotes a pending action that landed durably
  → emitPromotions()                        # group by (actionId, rev), emit per group
```

- Subscribe via `onCollectionChange(collectionId, listener)` → idempotent unsubscribe.
- Events fire **after** locks release, synchronously in commit order, fire-and-forget
  (never awaited); a throwing listener is isolated + logged. Ordering across concurrent
  commits / across collections is **not** guaranteed.
- **Emission guarantee (Option A — emit eagerly):** a `CollectionChangeEvent` fires
  once for every block that becomes **durably committed** on this node, regardless of
  whether the enclosing `commit()` ultimately reports `success: false`, and regardless
  of whether the landing happened on a `commit()` or on a `get()`-driven promotion.
  Concretely this covers: (a) blocks `1..N-1` that landed before a mid-loop
  `internalCommit` throw on block `N` (the failed attempt emits for what landed; the
  retry rolls `N` forward and emits for it), and (b) a pending action promoted during a
  `get()` whose `context` proves it committed. Idempotent `alreadyDone` re-landings and
  stale partitions never emit, so each `pending → committed` transition emits exactly
  once. The consumer does coarse whole-table invalidation, where over-firing costs only
  a re-query but a missed wake serves a stale view indefinitely — hence the asymmetry
  favors liveness.
- Exposed on the node as `node.blockChangeNotifier` — one of the handles declared by
  `OptimysticNodeAttachments` (`db-p2p/src/optimystic-node.ts`), which `createLibp2pNode`'s
  return type carries, so reading it needs no cast. `NetworkTransactor`
  re-exposes it via an optional `localChangeNotifier` ctor option (no-op when absent).

#### Reactive Watch Bridge (Quereus vtab)

The `quereus-plugin-optimystic` virtual table bridges these notifications to
Quereus's reactive watch API, so a (remote or local) commit wakes
`Database.watch` / subscribe consumers without polling:

```
StorageRepo.commit → CollectionChangeEvent → transactor.onCollectionChange
  → OptimysticVirtualTable listener → Database.notifyExternalChange(table)
    → Quereus watchers fire (coarse, whole-table invalidation)
```

- **Transactor wiring.** `CollectionFactory` feeds the notifier into each
  transactor: the `network` transactor receives `node.blockChangeNotifier` as
  `localChangeNotifier`; the `local`/`test` transactors are themselves
  `IBlockChangeNotifier`s delegating to their `StorageRepo`. `mesh-test` is
  unwired (its `NetworkTransactor` gets no `localChangeNotifier`, so the
  subscription is an inert no-op). A transactor that can't observe local commits
  degrades gracefully — the consumer keeps fetching/polling.
- **Subscription identity.** The vtab subscribes to exactly one collection id —
  `CollectionFactory.getCollectionId(options)` = `parseCollectionId(collectionUri)`
  = the URI path (`tree://app/users` → `app/users`). This equals the
  `header.collectionId` stamped on every block (`TransactorSource.createBlockHeader`)
  and therefore the `CollectionChangeEvent.collectionId`. Index sub-collections
  (`<uri>/index/<name>`) carry their own ids and are NOT separately watched —
  whole-table invalidation re-queries them anyway. The schema tree
  (`tree://optimystic/schema`) is skipped (schema writes aren't data-watch events).
- **Coarse invalidation.** `notifyExternalChange` fires every matching watcher as
  a global whole-table change: `full` watches fire with empty hits, `rows`/
  `rowsByGroup` watches surface their registered literals as possibly-changed.
  Over-firing only costs an extra re-query; it never misses a change.
- **Redundant self-wakeup (accepted in v1).** On a node that BOTH hosts AND
  authors a write, the local Quereus commit fires watchers precisely (tuple-level)
  via the normal post-commit path AND the storage funnel fires a coarse
  `notifyExternalChange`. The second is redundant but harmless. v1 does not attempt
  author-suppression; a future refinement could tag events with the authoring
  peer/actionId and let the vtab skip events it just authored.
- **Lifetime.** The subscription is established once after table init and released
  in `OptimysticModule.destroy` (DROP TABLE). It is deliberately NOT released in
  the per-statement `disconnect()` (a no-op that keeps the table initialized across
  statements) — doing so would kill reactivity after the first scan. Closing a
  `Database` without dropping its tables leaves the storage listener attached until
  the `CollectionFactory` is GC'd; its dispatch becomes a logged no-op once the
  `Database` is closed.
- **Host requirement.** Only nodes that host the collection's blocks observe these
  commits. Edge/client nodes that don't host blocks receive no push subscription
  and still fetch/poll.

#### Cohort-Topic Origination Bridge (networked reactivity)

The same `StorageRepo` change signal is also the **origination point** for *networked*
reactivity (and, later, matchmaking): a commit landing on a node that is a cohort
member for the collection's reactivity topic is emitted into the cohort-topic substrate
so notifications can fan out across the network — not just to in-process subscribers.

```
ClusterMember.handleConsensus            # consensus reached on a commit op
  → captureCommitCert(record)            # build CommitCert from record.commits (cluster-repo.ts)
  → onCommitCertificate(actionId, cert)  # → CommitCertStore.put  (BEFORE storageRepo.commit)
  → storageRepo.commit(...)              # critical section; emits CollectionChangeEvent at the end
StorageRepo.onAnyCollectionChange        # catch-all feed (every collection, not per-id)
  → makeCohortTopicChangeNotifier        # the bridge (cohort-topic/change-bridge.ts)
     → selfIsCohortMember(event)?        # non-member / tail-less event → no-op; reads event.tailId to
                                         #   resolve coord_0(H(tailId ‖ "reactivity")) and check FRET cohort
     → extractCommitCert(event)          # makeClusterCommitCertExtractor → CommitCertStore.get
     → CohortTopicService.onLocalCommit(event, commitCert)   # reactivity originates from here
```

- **Catch-all feed.** Origination must fire for *every* member commit, but
  `onCollectionChange(collectionId, …)` requires a known id and the bridge cannot
  enumerate collections. So `StorageRepo` exposes `onAnyCollectionChange(listener)`,
  fired alongside the per-collection listeners for the same `(pending → committed)`
  transitions. The bridge subscribes to it once for the node's lifetime.
- **Commit cert is authoritative; the notification is a hint.** The bridge forwards the
  cluster commit certificate (`CommitCert { thresholdSig, signers, minSigs }`)
  **unchanged** into `onLocalCommit`. Reactivity reuses `thresholdSig` bit-for-bit as a
  notification's signature and **never re-signs** (see `docs/transactions.md` §Design
  Decision 12). The cert is captured into a bounded TTL `CommitCertStore` *before* the
  commit is applied, because `StorageRepo.commit` emits the change event synchronously at
  the end of the call — so the cert must already be retained when the bridge resolves it.
  No retained cert (e.g. an idempotent re-commit) → the bridge skips origination rather
  than fabricating an unsigned one.
- **Decorator, not a replacement.** `makeCohortTopicChangeNotifier` returns an
  `IBlockChangeNotifier` that the `NetworkTransactor` takes as its `localChangeNotifier`;
  its `onCollectionChange` delegates straight to the `StorageRepo`, so the Quereus
  reactive-watch path above keeps working unchanged. Origination runs independently on
  the catch-all feed, regardless of whether anyone subscribed per-collection.
- **Wiring status (live, opt-in).** `createLibp2pNodeBase` now constructs the cohort-topic
  host and attaches the bridge when `cohortTopic.enabled` is set (default OFF). On an enabled
  node it: creates a `CommitCertStore` and composes its `put` into the `onCommitCertificate`
  sink threaded to `ClusterMember` (so the consensus cert is retained before the change event
  emits); post-assembly builds the host (`createCohortTopicHost`) over the running node + FRET;
  builds `selfIsCohortMember(event)` over real FRET membership for
  `coord_0(H(event.tailId ‖ "reactivity"))` (db-core default hashes, byte-identical to the host
  and the subscriber anchor; same `wantK` as the host); and installs the bridge as
  `node.blockChangeNotifier` via `attachCohortChangeBridge` — making origination live for **all**
  collections created on the node, since the Quereus collection-factory captures that notifier
  once. The host is exposed as `node.cohortTopicHost`. A node **without** `cohortTopic.enabled`
  keeps the bare `blockChangeNotifier = storageRepo` at zero cohort cost (no host, no cert store).
  When enabled, a missing FRET service or a host-construction failure **hard-fails** node startup
  (the operator opted in) — and, like every failure after `node.start()`, it **rolls back**: the
  factory stops the started node before rejecting with the original error, so a rejection never
  leaves a running node the caller has no handle to stop (`test/startup-rollback.spec.ts`). Rollback
  unwinds only what has a stop wrapper installed at the moment of the throw, which is why each
  wrapper is registered immediately after the resource it releases rather than at the end of the
  block. Node teardown releases the catch-all subscription and stops the host
  (clearing the gossip timer, unhandling the protocols) before transports close.
  - **Now end-to-end live** (`reactivity-notification-transport`). The enabled block also composes
    the reactivity notification transport onto the host: a `ReactivityOriginationManager` installs
    `onLocalCommit` (so the bridge's invocation builds a `NotificationV1` from `(event, commitCert)`),
    a `ReactivityForwarderHost` fans that frame out over the `/optimystic/reactivity/1.0.0/notify`
    protocol to direct subscribers + child cohorts, inbound notify frames route by topic to a
    node-level `ReactivitySubscriberRegistry` (exposed as `node.reactivitySubscribers`) for the
    subscriber role, and a `ReactivityPushStateGossipDriver` rides the host's cohort gossip transport
    for intra-cohort push-state convergence. The subscriber-id / dial-target space is the canonical
    peer-id string (the transport dials with `peerIdFromString`). Teardown stops the gossip timer,
    unsubscribes the inbound notify handler, and unhandles the reactivity protocols before the host
    stops. (The Quereus `Database.watch` → subscription-manager bridge that *constructs* subscribers
    remains the backlog `optimystic-network-reactive-watch-integration-test`.)
  - **Tail rotation is now live** (`reactivity-rotation-host-wiring-e2e`). `ReactivityOriginationManager`
    tracks the last-seen reactivity tail per collection and, when `event.tailId` **changes** between commits,
    fires `forwarderHost.markRotated(oldTopicId, { newTailId, effectiveAtRevision: event.rev }, now)` — the
    authoritative live-node rotation signal, because the pre-announce `rotationHint` cannot be built without a
    knowable successor tail id (random block ids; gated on `6.5-block-id-derivation`). The enabled block binds
    that `markRotated` seam, binds the recover serve's `rotationFor` to `forwarderHost.rotationRedirectFor` (so
    a recover reaching the draining old tail returns a `kind:"rotated"` redirect), and constructs + exposes an
    unref'd-timer `RotationReRegistrationScheduler` as `node.reactivityRotation` (torn down in the stop wrapper
    before `host.stop()`). The scheduler's `reRegister(plan)` move is wired by the deferred subscribe factory
    (the same `optimystic-network-reactive-watch-integration-test` that constructs managers); until then it is
    constructed + exposed + unit/mesh-tested but not driven by a node-internal manager. Anticipatory warm-up on
    a live node is signal-only (logged; no successor coord is fabricated).

## Mutation Contracts

### Functions That MUTATE In-Place
| Function | Mutates | Notes |
|----------|---------|-------|
| `applyOperation(block, op)` | block | Caller must clone if original needed |
| `applyOperations(block, ops)` | block | Calls applyOperation for each |
| `applyTransform(block, transform)` | block | Uses applyOperations internally |
| `apply(store, block, op)` | block | Also records op in store.transforms |

### Functions That CLONE
| Function | Returns | Notes |
|----------|---------|-------|
| `withOperation(block, op)` | new block | Safe alternative to applyOperation |
| `CacheSource.tryGet()` | structuredClone | Prevents cache corruption |
| `CacheSource.peek()` | structuredClone | Recency-neutral read; callers apply ops to the result |
| `Tracker.tryGet()` for inserts | structuredClone | Inserts are cloned on retrieval |
| `Tracker.peekMaterialized()` | structuredClone | Clones the staged insert before `applyTransform` mutates it |

### Storage Clone Requirements
**Memory storage MUST clone on get/save** to prevent cross-revision contamination:
```typescript
// CORRECT - memory-storage.ts
getMaterializedBlock(): return structuredClone(stored);
saveMaterializedBlock(block): store(structuredClone(block));
```

## Key Invariants

### Block Identity
- `blockId` = random ID (base64url; `randomBytes(32)`, `packages/db-core/src/transactor/transactor-source.ts:36`), immutable — not a content hash
- `actionId` = transaction identifier, unique per commit
- `rev` = revision number, monotonically increasing per block

### Transform Ownership
- `Transforms.updates[blockId]` arrays must NOT be shared between consumers
- `copyTransforms()` and `transformForBlockId()` must deep-clone arrays
- JSON serialization over network creates implicit deep copies

### Consensus Execution
- `handleConsensus()` executes on ALL cluster peers, not just coordinator
- `executedTransactions` map prevents duplicate execution (keyed by messageHash)
- Different operations (pend vs commit) have DIFFERENT messageHashes
- **Post-consensus local-execution failures are tolerated, not thrown.** Once
  consensus is reached the operation is authoritative; a member that cannot apply
  it locally (it is *ahead* — stale pend/commit returns `success:false` with
  `missing` — or *behind* — missing the prior pend, so `StorageRepo.commit` throws
  "Pending action … not found"; or *behind with no base*, below) logs
  `cluster-member:consensus-{pend,commit}-diverged`
  and tolerates the divergence rather than throwing. Throwing would reset the
  cluster stream the coordinator awaits and surface as a spurious `StreamResetError`,
  sinking an otherwise-successful transaction.
- **`latest` never advances past a revision the node can materialize.** A member can hold
  the *pend* for revision N of a block yet have missed the revision that created it —
  cohort membership drifts between a collection's revisions. `applyTransform` silently
  drops `updates` when there is no block to apply them to, so committing anyway would
  record rev N while materializing nothing: the block is then unreadable on that node
  (`materializeBlock` throws), unservable to peers (`SyncService.buildArchive` returns
  nothing), and every later pend for it is rejected — a permanent local wedge with no
  self-healing path. `StorageRepo.internalCommit` therefore **refuses**: it drops the
  unusable pending and fails the commit with a `missing-base-revision` reason
  (`MISSING_BASE_REVISION_REASON`, matched by `isMissingBaseRevisionFailure`). The same
  refusal covers a block whose existing `latest` is itself unmaterializable, so a node
  wedged by older code recovers on the next write touching that block.
- **A pend rejection is returned only when local storage confirms a revision loss.** When
  enough members vote reject, `ClusterCoordinator` throws a typed `ValidatorRejectionError`
  carrying the (free-form, wire-visible) reject reasons. `CoordinatorRepo.pend` then
  re-reads the affected blocks from its own storage: if any block's `latest.rev >= request.rev`
  — the same rule the members vote by — the rejection is *returned* as a `StaleFailure` carrying
  `conflict: true`, so `Collection.sync`'s bounded re-read/rebase/retry loop picks it up instead
  of an error escaping mid-batch and splitting a multi-tree commit. Every unconfirmed rejection
  still **throws** — including one whose confirmation read failed, and one only remote members
  could see (local storage behind). The reject-reason text is never parsed; confirmation is
  purely the local revision comparison.
- **…except against the writer's own durable work.** A write touching several blocks commits them
  a group at a time, so it can end up with some blocks durable and the rest refused — a *torn
  action* — and its retry reuses the same action id. Every revision comparison above therefore
  excludes the case where the holder of the requested revision *is this action*: `isOwnRevision`
  ([`network/stale-failure.ts`](../packages/db-core/src/network/stale-failure.ts)) is the single
  rule, and all five revision-vs-action checks call it — `StorageRepo.pend` and `.commit`'s
  `alreadyDone` partition, `ClusterMember.validatePendOperations` and `.validateCommitRevisions`,
  and `CoordinatorRepo.classifyStaleRejection`'s per-block confirmation. Without it the retry is
  refused by its own committed half on every attempt until the retry budget runs out and nothing
  lands. The carve-out is `latest.rev === request.rev` **only**: past the requested revision the
  follow-on commit is refused as stale anyway, so approving would defer the refusal by a round
  trip, and `latest` alone can no longer name who holds the requested revision. Rival behavior,
  and the signed reject prose that carries it, are untouched.
- **The writer's retry consumes its own committed log entry.** The carve-out above only stops the
  *storage* side refusing the retry; the client half is that a torn action's log entry is already
  durable when the failure is reported, because `NetworkTransactor.commit` commits the log tail
  BEFORE sweeping the remaining blocks. (It has a header-first step too, but that branch is
  unreachable from the only production caller — see the NOTE at the sweep — so in practice a
  touched header commits inside the sweep, after the tail.) A refresh taken between a failed
  attempt and its retry therefore **consumes** (`Collection.consumeOwnEntry`) an entry carrying the
  retry's own action id, instead of running it through the conflict filter and replaying it —
  replaying re-appends content the committed tail already holds, leaving the same action recorded
  twice in the log. Consuming drops the entry's actions off the head of `pending` and forces the
  replay that resets the tracker, so `hasUnsyncedChanges()` turns false and the write reports the
  success it is owed.
- **The collection, not the caller, holds the in-flight id.** Which action is in flight is a field
  on the instance (`Collection.inFlightActionId`), set for the duration of a write's attempt CYCLE
  by `Collection.beginInFlightAction(actionId)` and cleared by the disposer it returns;
  `updateInternal` reads the field and takes no parameter, so no refresh path can be correct-only-
  by-remembering-to-pass-it. `update()` and `updateAndSync()` refresh on a READER's behalf, leave
  the field unset, and the consume branch cannot fire. Both write paths set it: `Collection.sync`
  brackets its whole retry loop, and `TransactionCoordinator.commitOnce` marks each participant
  right after taking its latch, pushing the disposers into an array `commit` clears in a `finally`
  around the WHOLE retry loop. The coordinator's clear cannot be latch-scoped: its inter-attempt
  `collection.update()` — the only reader of the mark — runs after the commit span released its
  latches, because `Latches` is non-reentrant. (Before the field, the coordinator's refresh went
  through the same `update()` a reader calls and was indistinguishable from one, so a torn action
  committed through the coordinator replayed into a duplicate entry.)
  `packages/db-core/test/collection-own-action-replay.spec.ts` is the regression test at the
  collection tier and `packages/db-core/test/coordinator-own-action-replay.spec.ts` at the
  coordinator tier (single-collection tear, one participant tearing while another cleanly loses,
  and an abandoned commit leaving no mark behind);
  `packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts` ("a torn commit — tail
  durable, a later block refused") pins the same recovery end-to-end on the mesh.
- **A lost conflict race is returned too — and needs no confirmation.** A member holding the
  transaction that won a race against this one answers with a signed `conflict` vote naming the
  winner, and the coordinator raises `ConflictRaceLostError` (never `ValidatorRejectionError`:
  nobody judged the write invalid). `CoordinatorRepo.pend` returns it directly as a `StaleFailure`
  with `conflict: true` — no local re-read, because the loss is already proven by the votes and
  there is nothing local to confirm. `staleAt` stays **absent**: a rival *pend* holding the blocks
  is not a revision claim, so there is no confirmed number to report. This is the one returned
  rejection that is not a confirmed revision loss.
- **Pend retryability is an explicit field, not a payload shape.** `StaleFailure.conflict` says
  outright "this was a lost race, a re-read can win"; `isConflictFailure`
  ([`network/stale-failure.ts`](../packages/db-core/src/network/stale-failure.ts)) is the single
  rule every pend consumer calls, and it treats `conflict` as authoritative when present, falling
  back to inferring from `missing`/`pending` only for producers that never set it (including a
  peer on an older build — the repo protocol is plain JSON, so an unset field simply arrives
  absent). This is why the confirmed-loss response above needs no `missing` list: the local
  re-read knows the revision is taken but not which actions took it, and nothing rebases from
  `missing` anyway (it is only counted and logged). `NetworkTransactor.pend` *rebuilds* its
  aggregate `StaleFailure` from the per-batch responses, so it re-derives `conflict` across them
  — any conflicting batch makes the aggregate a conflict. The commit side is deliberately
  untouched: it keys on `CommitResult` shape (next bullet), and no commit producer sets `conflict`.
- **The revision a writer lost to travels as data, not prose.** `StaleFailure.staleAt`
  (`{ blockId, rev }`) carries the one machine-readable fact inside the free-form reject text, so a
  losing writer never has to parse it. Set **only** where the producer read the revision out of its
  own storage (`StorageRepo.pend`/`.commit`, and the confirmed branch of
  `CoordinatorRepo.classifyStaleRejection` — the site that matters most, since that failure carries
  no `missing`). A number lifted from another peer's reject text is never promoted to this field,
  and absent means "no confirmed number", never "not stale". It is **diagnostic only**: `conflict`
  remains the single retryability rule and nothing branches on `staleAt`. Where several candidates
  exist — a producer scanning multiple blocks, or `NetworkTransactor` rebuilding one response from
  many per-batch ones — every site picks the **highest** `rev` through the shared `highestStaleAt`
  ([`network/stale-failure.ts`](../packages/db-core/src/network/stale-failure.ts)), because the
  loser's next request has to clear every holder. Uniformity is the point: a producer reporting an
  arbitrary block would make the transactor's max across producers understate the constraint.
  `ClusterMember`'s promise-phase *rejection* deliberately stays prose-only — its reason is signed
  into `Signature.rejectReason`, so structuring it would change the signed byte layout. (Its
  *conflict* vote is the counter-example that proves the rule is about layout, not principle: the
  winner's hash is structured data in `Signature.conflictWith` because that variant was designed
  with the field in its signed payload from the start.)
  `SyncRetryExhaustedError.staleAt` is where it surfaces to an embedder.
- **The commit divergence split keys off `CommitResult`, not throw-vs-return.** A
  missing pend (thrown "not found"), a stale/ahead commit (`success:false` with
  `missing`), or a `missing-base-revision` refusal is divergence and tolerated; any other
  mid-commit fault (`success:false` with a bare `reason`, no `missing`) is propagated so
  `handleConsensus` rolls back the executed marker and rethrows — same as an unexpected
  *thrown* fault (`applyConsensusOperation`).
  **`StorageRepo.commit` makes the identical split one layer down, to decide what happens to
  the pending records the pend left behind.** A *behind* divergence (missing pend, or a
  `missing-base-revision` refusal) is followed by a reconcile that advances every block in the
  batch past the action, so nothing left pending could ever be promoted — commit drops the whole
  batch's records before reporting. A genuine fault is retried, and the retry replays those
  records, so they are kept. The two layers must agree: if the cluster ever stopped retrying
  propagated commit faults, the keep arm would become dead weight.
- **A *behind* member actively reconciles.** It holds no usable revision of the committed
  blocks, so it pulls the committed revision from the cohort (via the injected
  `reconcileBlock` callback — `SyncClient` fetch + `saveReplicatedBlock` in
  `libp2p-node-base`) and restores it locally, repairing the under-replication at the
  moment of the commit rather than waiting for someone to read the block. The read path
  is no longer blind to it: `CoordinatorRepo` is handed the *same* callback instance and
  runs it once the cohort has corroborated a revision the reader cannot promote locally
  (see [transactions.md](transactions.md#read-consistency-and-staleness)), so the two
  paths heal by identical rules. It does **not** trust a single peer: the target `(rev, actionId)` must be
  corroborated by a quorum of distinct cohort archives, and the block content must
  hash byte-identically across a quorum, before it persists (`cluster/reconcile-block.ts`
  over `cluster/quorum-restore.ts`; the primitives are shared with `CoordinatorRepo`
  read-repair, which excludes the reader's own revision from that quorum — see
  [transactions.md § Read Consistency and Staleness](transactions.md#read-consistency-and-staleness)).
  **Both** quorums cap their floor at `max(cohort peers excluding self, repairCorroborationClusterSize − 1)`
  — literally the same `corroboratorCapacity` function the read-repair path calls, so the two
  restoration paths cannot drift apart on it: a cohort with exactly one
  other peer cannot supply two corroborators *or* two block-carriers, so demanding two would
  make such a cohort permanently unable to heal rather than making it safe. Block ids are
  random, not content-addressed, so the content hash is a cross-peer *agreement* check and
  never a check against the requested id — at capacity one the sole peer's bytes are taken on
  its word, which is the same trust its (equally uncorroborable) revision claim already gets.
  Taking the MAX against a *declared* size — never against the number of peers a possibly
  shrunken view happens to show — is what keeps a shrunken view of a larger cohort out of that
  relaxed branch. `repairCorroborationClusterSize` is resolved by `resolveClusterPolicy`
  (`cluster/cluster-policy.ts`) from the operator's `clusterPolicy.assumedClusterSize`, falling
  back to `clusterSize` when it is absent — deliberately the strict fallback, so an unconfigured
  node keeps the floor of two. A genuine small deployment declares
  `clusterPolicy.assumedClusterSize` to heal, which — unlike lowering `clusterSize` — does not
  also lower its replication factor.

  **How many machines repair actually needs** (swept over `resolveClusterPolicy` +
  `corroboratorCapacity` + `quorumSize`, and pinned in `test/quorum-restore.spec.ts` under *how
  many answering peers a repair needs, by deployment size*). **The whole table is about
  *uncertified* claims** — an answering peer that serves nothing but its own word for the revision
  and the bytes. A peer that also serves a verified cohort commit proof is on a different track
  entirely and none of these rows constrain it; see *The certified exception* below the table.
  **Every row assumes the block already has at least as many cohort-peer holders as that row's
  *must answer* column demands** — those peers have to answer *and agree*, which only a peer that
  holds the block can do. A block with fewer holders than that is a different failure, and machine
  count does not fix it; see the paragraph below the table:

  | machines | cohort size declared? | peers besides the reader | peers that must answer *that reader* | can repair (given that many holders)? |
  | --- | --- | --- | --- | --- |
  | 2 | no (falls back to `clusterSize`, default 10) | 1 | 2 | **never** |
  | 2 | yes (`assumedClusterSize: 2`, or an honest `clusterSize: 2`) | 1 | 1 | yes, with no margin |
  | 3 | either | 2 | 2 | yes, with **no margin** |
  | 4+ | either | 3+ | 2 | yes, survives one unreachable peer |

  Three consequences are worth stating plainly, because all three have cost real debugging time.
  **Three machines is the minimum that can ever repair, not a size at which repair is safe**: the
  reader has exactly two peers and needs both, so one peer unreachable *from that reader* — healthy
  and reachable from everyone else — leaves that reader's copy permanently unrepairable. **Declaring
  `assumedClusterSize: 3` does not conjure a third peer**; it has the same zero tolerance as an
  undeclared three. And **the `4+` row's "survives one unreachable peer" is conditional on that row's
  holder assumption — two of them — not a blanket guarantee at that size**: wherever the
  corroboration floor is two (every row but the declared-two-machine one), a block that only one
  cohort peer holds *and cannot certify* cannot be repaired at *any* machine count, four-or-more
  included — more machines never manufactures a second copy of a block that only ever had one. Two
  things escape that. The declared two-machine row escapes it by size: its floor relaxes to one, so a
  lone peer's claim *is* adopted there and a singly-held block repairs like any other. And a lone
  holder that still has the cohort's commit proof escapes it at *every* size — see below. The usual
  way a block ends up stranded is being written while the deployment (or that block's cohort) was
  smaller. Growing the deployment afterwards *does*
  now copy it — that is the `RebalanceMonitor` `grown` arm below — but the copy is not instantaneous:
  a peer counts as holding the block only once a push to it is CONFIRMED, so a push that fails is
  re-detected and retried on later checks (bounded by `growthMaxAttempts`, default 5, after which
  that peer is given up on until it leaves the cohort and rejoins). Until a retry lands, the block
  still has its single copy and this is reported as `cluster-fetch:repair-deadlock` with
  `reason: 'sole-holder'` (below) — a diagnosis, not a fault of
  the read path, and one an operator at four-plus machines can otherwise easily miss.

  **The certified exception — when one holder is enough at any size.** Everything above measures a
  claim by how many *other peers* say the same thing. A peer that retained the cohort's commit proof
  for the revision it is serving does not need them: the proof carries the cohort's own signatures
  over that `(block, revision, action)` — and, when the commit declared a content digest, over the
  bytes too — so a verifier checks it offline against the proof's signer list instead of polling for
  a second opinion. Both restoration paths (`CoordinatorRepo` read-repair and the commit-path
  reconcile) run peer-attached proofs through `cluster/certified-claims.ts` first, and a claim whose
  proof verifies is selected with **no corroborating peer, at any cohort size** — the
  declared-two-machine row's relaxation, available everywhere, and earned rather than assumed. The
  content gate has the same short-circuit for a proof that declared a digest matching the served
  bytes. So the *never* in the two-machine undeclared row, and "a block only one cohort peer holds
  cannot be repaired at any machine count", are both statements about proof-less holders only. A
  certified lone holder repairs in either case. Three limits worth knowing:

  - **Ordinary corroboration still wins when it is higher.** A pair corroborated by peers at a
    *strictly higher* revision than the top certified one is selected over the proof, so a legacy
    uncertified tail written after the last proven revision stays readable. (A merely
    *uncorroborated* higher claim never outranks a proof — it is not evidence at all.)
  - **Proof retention is per revision, and not retroactive.** A revision that first landed
    proof-less keeps no proof even if a later certified heal of that same revision carries one.
    Blocks written before proofs existed, or by a member whose materialization disagreed with the
    declared digest, have none — those fall back to the table above. A repaired replica *does*
    serve the proof onward, so a certified block's coverage grows with each heal.
  - **A verified proof says the listed signers signed, not that they are this block's cohort.**
    Anyone holding N keys can stand up their own N-peer cohort and self-certify. Closing that needs
    a membership anchor (`feat-cluster-membership-threshold-cert-anchoring`, open); until then the
    residual is logged, never silently accepted. See *What a passing verdict does not say* above.

  Two signals name this rather than leaving it to be re-derived from logs:

  - **`repair-fault-tolerance`** (`cluster/cluster-policy.ts`), once per node construction, when
    the cohort size is undeclared *or* the resolved `repairCorroborationClusterSize` is three or
    fewer. It states the requirement, names the remedy, and says which of the two conditions fired
    (`cohortUndeclared`, `noRepairMargin`). It fires purely off configuration, so a
    correctly-provisioned large deployment sees the undeclared arm too — advisory, not a fault.
    (This is the renamed, widened successor to `assumed-cluster-size-unset`, which fired only when
    the size was undeclared and told operators three machines "can ignore this".)
  - **`cluster-fetch:repair-deadlock`** (`CoordinatorRepo.reportRepairDeadlock`), once per block,
    when a decline is provably permanent — not merely that this pass fell short. Carries a `reason`
    field with one of two values; they are different faults with different remedies, so each gets
    its own wording:
    - **`cohort-too-small`** — this node's cohort has fewer peers than the quorum would demand even
      if **every** one of them answered and agreed (`requiredEvenIfAllAnswered`, reported in the
      payload, compared against how many peers the cohort has). Per the table above, that is the row
      where repair says *never*: one peer besides the reader, with the size undeclared. Remedy: more
      machines, or an honest declared `clusterPolicy.assumedClusterSize` / `clusterSize`.
    - **`sole-holder`** — the cohort is big enough (does not trip `cohort-too-small`), but exactly
      ONE of its peers holds the block, that peer has no cohort commit proof for it, and every
      *other* peer answered that it holds nothing — an answer, not silence. Every row in the table
      above assumes the block already has as many cohort-peer holders as that row demands; this is
      the case where it does not, so it holds at any machine count whose corroboration floor is two —
      that is, everything but a declared two-machine cohort, where the floor is one, a lone holder IS
      corroborated, and the repair therefore succeeds rather than declining (so this reason cannot
      arise there).
      Scope is deliberately narrow: this node's own copy, if it has one, is excluded from the claim
      set (it cannot corroborate the revision it is repairing), so the message says "cohort peer",
      never "machine in the deployment" — a reader that holds the block itself still gets
      `sole-holder`. **Two remedies, not one.** The first is another cohort peer holding the block,
      i.e. committing any new revision of the block, which writes it to the current cohort. The
      second is the lone holder retaining the cohort's commit proof for the revision it serves: a
      certified claim needs no corroborating peer, so it converges inside the selection and never
      reaches this decline at all (which is also why the "a lone holder cannot second itself"
      wording stays accurate for every claim that does get here). That second remedy is not something
      an operator applies to an already-stranded block — the proof either was retained at commit time
      or was not — but it is why this case should get *rarer* over time rather than staying permanent:
      a repaired replica now serves the proof onward, so certified coverage spreads with each heal.
      What does not help either way is machine count or any configuration setting. The usual cause is
      data written while the deployment (or that block's cohort) was smaller — growing the deployment
      afterwards does not copy existing blocks to the new peers, so founding data written before
      proofs were retained can stay stranded at one copy indefinitely.

    Deliberately excluded from both: a shortfall where the cohort *could* reach quorum and some peer
    simply does not hold the block yet (that peer's own repair, or the next commit, fixes it); a
    cohort that unanimously answers "I hold nothing" (an agreed absence is an answer); and a pass
    with any silent peer (silence does not change the arithmetic — silent peers are still counted —
    but a node that could not ask everyone should not make a permanent claim, and the next clean pass
    costs nothing). There is deliberately **no** "the claims disagreed" exemption for
    `cohort-too-small`: a cohort too small to reach quorum stays too small whether its peers agree or
    not. Two or more disagreeing holders DO suppress `sole-holder` — that cohort has two copies whose
    peers simply have not settled yet, and a later pass can. Both reasons keep the per-pass
    `cluster-fetch:no-quorum` line, which still fires on every decline. The `cohort-too-small`
    message names *two* readings of the same numbers, because the node cannot tell them apart from
    the inside: a deployment that genuinely runs this few machines, or a cohort view shrunk below the
    real deployment by a partition or by routing influence — configuration will not fix the second.
    Suppression is per-`reason`, not once outright: an episode that starts as `cohort-too-small` and
    becomes `sole-holder` (the operator added the machines that reason asked for, and the block is
    still stuck) says the second thing too. It hangs off the existing `unsettledAheadClaims` entry
    and clears when the block converges. The reader-facing error is *not* yet aware of this:
    `BlockPossiblyStaleError` still implies a retry might help, which is wrong advice for a
    deadlocked repair — see the `NOTE:` at `reportRepairDeadlock`.

  No rev quorum, or no content quorum →
  it leaves the block for a later churn/rebalance retry (logged
  `reconcile:no-rev-quorum` / `reconcile:no-content-quorum`). Reconciliation is
  best-effort and bounded (`ReconcileTimeoutMs`, the shared `RECONCILE_TIMEOUT_MS` the read
  path's acquisition also uses — same operation, same bound):
  failures/timeouts are logged (`cluster-member:consensus-commit-reconcile-failed`),
  never thrown. A pass that ran to completion logs
  `cluster-member:consensus-commit-reconcile-attempted` — deliberately *attempted*, since the
  callback returns nothing and a quorum decline is a normal non-throwing outcome; `reconcile:restored`
  is the only line that means bytes actually landed. An *ahead* member already holds ≥ the rev, so it does not reconcile
  downward. Reconciliation deliberately runs **after** `StorageRepo.commit` returns, once
  its per-block latches are released: `saveReplicatedBlock` takes the same
  `Block.write:<blockId>` write latch, so fetching the base from inside the commit path
  would deadlock against the lock the commit already holds. That constraint is why a member
  with no base *refuses and heals* rather than *fetching then committing*.

  **Certified-claim log lines, and which of them are incidents.** Cohort commit proofs added five
  lines across the two repair paths — the `reconcile:` prefix is the commit-path reconcile, the
  `cluster-fetch:` prefix is `CoordinatorRepo` read-repair. Two of them are *incidents* and must not
  be read as ordinary shortages:

  - **`reconcile:certified-equivocation`** / **`cluster-fetch:certified-equivocation`** — two proofs
    that both verify certify *different actions into the same revision*. The whole revision selection
    declines rather than picking a side, so the block stays unrepaired permanently and by design.
  - **`reconcile:certified-content-equivocation`** — two proofs that both verify certify *different
    content digests for one revision*. Same outcome on the content gate.

  Both mean whoever holds the cohort's signing keys signed both sides. **This is a key compromise,
  not a capacity problem: adding machines or lowering a corroboration setting does nothing.** The
  remedy is investigating the cohort that signed — which keys, and what else they signed. Neither
  claimant is penalized, because which side is wrong is exactly what a verifying node cannot know.
  Each equivocation line is accompanied by the routine `reconcile:no-rev-quorum` /
  `no-content-quorum` decline for the same pass, which on its own reads as a routine shortage; the
  equivocation line is the one that says *why*, and is what makes the two declines distinguishable
  in a log search.

  The remaining three are informational:

  - **`reconcile:certified-selected`** / **`cluster-fetch:certified-selected`** — the certified rule,
    rather than peer corroboration, chose the revision. Carries `claimants`, which may legitimately
    be `1`: the corroboration is the proof's signature set, not other voters.
  - **`reconcile:proof-uncertified`** / **`cluster-fetch:proof-uncertified`** — a peer attached a
    proof that did not verify, with the `failure` reason. Expected in mixed-version deployments
    (`legacy-record`) and on relayed junk (`malformed-proof`); only the reasons that prove the
    artifact itself lies penalize the serving peer.
  - **`reconcile:content-rejected`** — a peer's proof verified but its served bytes contradict the
    digest that proof declared. Those bytes are dropped from the content quorum and that peer is
    penalized, while its (genuinely verified) revision claim still counts; repair continues on the
    other holders.
- **The coordinator tolerates the same divergence, in both its shapes.** When
  `CoordinatorRepo.commit` finds its own member did not execute during consensus, it falls back
  to a local commit — which can diverge for reasons the caller is not responsible for. A thrown
  missing pend and a returned `missing-base-revision` refusal are treated identically: if the
  record shows a simple majority approved the commit, report success
  (`coordinator-repo:commit-local-failed-cluster-succeeded`) and let replication converge this
  peer. Returning the refusal instead would surface a *landed* transaction as a stale loss, since
  db-core's `commitPhase` treats any returned `success:false` as a permanent stale failure and
  retries until its budget is exhausted. A `success:false` with any other reason is a genuine
  lost race and still reaches the caller.
- **A block read has three answers, not two: present, authoritatively absent, or unavailable.**
  `GetBlockResult` carries an optional `unavailable` field
  ([`network/struct.ts`](../packages/db-core/src/network/struct.ts)) that a repo sets ONLY when it
  knows its own answer is a guess; an absent field means authoritative, so every producer that
  never sets it (including `TestTransactor`) keeps its existing meaning. Two producers set it:
  `StorageRepo.get` flags `'unmaterializable'` when the block reads as absent but this node holds
  records proving it exists — the missing-base promotion refusal above, a `getBlock()` throw on a
  `latest` this node cannot materialize (truncated history, or a failed restore of a revision whose
  range it claims; caught **per block**, so one broken block no longer fails its whole batch), or a
  pending overlay that materialized nothing over an absent committed base. A block with **no
  committed revision at all** is deliberately NOT in that set: `getBlock` reports an absent base
  rather than throwing (nothing is being *failed* to reconstruct), so a pending-only insert read
  with a context is served from its pending overlay, and only an overlay that produces no block —
  a pending *update* with nothing to apply itself to — is flagged. A pending *delete* over a real
  committed base is likewise unflagged: an intended tombstone is an authoritative absent.
  `CoordinatorRepo.get` flags a locally-missing block whose cohort consult could not rule it out,
  and the reason **names what the consult established** rather than one catch-all:

  | what the repair pass found | flag |
  | --- | --- |
  | whole cohort answered "holds nothing" (the routine new-collection probe) | none — authoritative absent |
  | there was nobody to ask: `findCluster` returned an empty cohort, or only this node | none — authoritative absent |
  | part of the cohort answered, part was silent — or the consult threw outright | `'peers-unreachable'` |
  | this node knows of cohort members outside itself and could reach none of them | `'cohort-unreachable'` |
  | a peer positively claimed a revision that was neither corroborated to a quorum nor acquired | `'claimed-elsewhere'` |

  Note the second row: `'cohort-unreachable'` is *silence from a cohort this node knows about*, not
  isolation in general. A node whose routing view yields no cohort member at all — a cold boot with
  an empty routing table — consults nobody, and its local emptiness is served as an authoritative
  absent, unflagged. So a consumer relying on `'cohort-unreachable'` to detect isolation must also
  tolerate the unflagged absent; the two differ only in whether FRET still remembers peers.

  When several apply the sharpest evidence wins: a claim outranks any amount of silence, and total
  silence outranks partial. A consult that *throws* (the cohort lookup itself failed) stays
  `'peers-unreachable'` even on an isolated node — a routing failure says nothing about how many
  cohort members were reachable. `'cohort-unreachable'` tells the caller there is no
  better-connected coordinator to re-ask — but the absence is still **not** served as
  authoritative: a node that reached nobody has zero information about the cohort, and believing
  its own emptiness is exactly the failure the fail-closed rule exists to prevent (a partitioned
  node would otherwise report every never-locally-seen block as absent).
  Whether an isolated node's own view is good enough for a given read is per-read policy that
  belongs to the caller; `BlockUnavailableError.reason` carries the value out verbatim so a
  consumer can discriminate on it. `'claimed-elsewhere'` extends the fail-closed rule to an
  absence a peer has flatly contradicted: the same one-claim-raises-doubt tradeoff the
  currency bullet below accepts, mirrored onto the missing path. The unflagged first row is what
  keeps the one-round-trip path `createOrOpen` depends on. Silence is distinguishable from
  "I hold nothing" because `ClusterLatestCallback` is a
  three-way contract: an `ActionRev` is a claim, a resolved `undefined` is the peer answering that
  it holds nothing, and a **rejection** is silence — so implementations must let transport errors
  propagate, and the coordinator deadlines each per-peer query (rejecting, not resolving, on
  expiry) so a slow peer counts as silent too. One silent peer flags the whole consult, fail-closed:
  it could be the sole holder. A merely-stale block keeps its real local answer,
  unflagged, whatever the consult did; so do `skipClusterFetch` sync reads. Consumers: `NetworkTransactor.get`
  treats a flagged entry as *not* answered — it earns the second-chance retry an authoritative
  absent deliberately does not — and merges per block by ranking (see the currency bullet below
  for the full order). `TransactorSource.tryGet` converts a surviving blockless flagged entry
  into a thrown `BlockUnavailableError` (naming the block and reason, recording no read
  dependency), so a query against a collection this node cannot read fails loudly instead of
  returning zero rows. `BlockUnavailableError` is not a `StaleFailure`: `Collection.sync` does not
  absorb or retry it. Every other consumer that reads a `GetBlockResult` directly checks the flag
  before drawing a conclusion from an empty `state`: `Collection.bootstrapContext` (the log-tail
  read bypasses `TransactorSource`) throws rather than opening with no `ActionContext`;
  `NetworkTransactor.getStatus` throws rather than reporting the action `aborted`;
  `ClusterMember`'s promise-phase stale-revision gate votes *reject* rather than approving a pend
  whose revision it could not check; `SpreadOnChurnMonitor` keeps the block tracked rather than
  self-pruning it from the replication set.
- **A present answer separately says whether it is confirmed CURRENT — `unavailable` is about
  existence, `unconfirmedAheadRev` is about currency.** `GetBlockResult` carries a second optional
  doubt marker ([`network/struct.ts`](../packages/db-core/src/network/struct.ts)):
  `unconfirmedAheadRev`, set when a repo served real committed content it could not confirm is
  current because a cohort peer claimed a strictly higher revision the repair pass could not
  settle. Absent means confirmed, so every producer that never sets it keeps its meaning. One
  producer sets it: `CoordinatorRepo.get`, narrowly — the entry has a committed revision (never a
  plain absent; that is the existence flag's business), the served revision is still strictly
  below the claim after the repair pass ran, and the caller asked for a view that should contain
  the claim (an unpinned "latest" read, or a pin at/above the claimed revision — a read pinned
  *below* the claim is being served correctly and stays unstamped, which keeps a collection's
  context-pinned data reads quiet). The claim reaches `get` from both non-converging shapes: a
  claim that failed the read-repair corroboration quorum (`queryClusterForLatest` returns the
  highest such claim on its no-quorum path — evidence of doubt only, never a revision to adopt;
  relaxing the quorum instead is the attack `quorum-restore.ts` exists to prevent), and a
  corroborated revision this node failed to converge onto. A cohort that is merely silent and
  claims nothing never stamps — silence carries no revision to be behind of, so the merely-stale
  pin above holds. The doubt **outlives the consult that formed it**: a corroborated-but-unacquired
  pass marks the block seen, so the read-repair window skips the next consults, and a doubt that
  lived only in that consult's return value would let every read inside the window serve the same
  content as confirmed again. `CoordinatorRepo` remembers the unsettled claim per block and keeps
  stamping from it; only a consult that actually ran may clear it, or the node reaching the claimed
  revision. Consumers mirror the existence flag: `NetworkTransactor.get` treats a marked
  entry as *not* answered (it earns the second-chance retry) and merges per block by the ranking
  **confirmed block > unconfirmed block > authoritative absent > unconfirmed absent >
  unavailable** — the confirmed-over-unconfirmed split is load-bearing, since without it the
  stale marked entry and the fresh confirmed one fetched by its own retry tie and first-arrival
  (the stale one) wins the merge. When the marker survives the retry, every reachable coordinator
  said the answer may be behind: `TransactorSource.tryGet` then throws `BlockPossiblyStaleError`
  for any read whose view should CONTAIN the claim — the same at/above test the coordinator applies
  when it stamps, i.e. an **unpinned** read or one pinned at/above the claim (a read pinned *below*
  the claim legitimately asks for an older view and keeps working),
  `Collection.bootstrapContext` does the same for its direct tail read — the unpinned tail read
  is the one seam where a lagging collection can learn a newer revision exists, and silently
  seeding the context from a doubted tail is exactly how a collection view froze in the field —
  and `NetworkTransactor.getStatus` throws rather than judging actions from a state it could not
  confirm. `BlockPossiblyStaleError` is `BlockUnavailableError`'s sibling, not a `StaleFailure`:
  `Collection.sync` surfaces it instead of absorbing it into its retry loop. Accepted tradeoff: a
  node partitioned from every coordinator able to confirm currency used to read stale data
  silently and now raises on those reads until the partition heals (see the `NOTE:` at the
  `tryGet` throw site). Tripwire, recorded at the no-quorum site in `queryClusterForLatest`: one
  uncorroborated claim is enough to raise doubt, so a single lying cohort peer can deny unpinned
  reads of a block it falsely claims to be ahead on — cheaper than the silent-staleness it
  replaces, and revisited when commit-certificate verification can make a claim attestable.
- **"What revision did this read observe?" is a separate field from "what revision does this repo
  hold?"** `GetBlockResult` carries an optional `materialized`
  ([`network/struct.ts`](../packages/db-core/src/network/struct.ts)): the `(rev, actionId)` the
  returned `block` actually is. It differs from `state.latest` for exactly one case — a read that
  pins `context.rev` below the revision at which *that block* last committed, so the repo serves
  older content than it holds. `state.latest` deliberately keeps its own meaning (the newest
  revision the answering repo holds), because other consumers depend on it: `StorageRepo.get`'s
  read-driven promotion pre-scan compares `context.committed` against it, and `CoordinatorRepo.get`
  drives read-repair off it. The revision and its action id are **one field** on purpose: a site
  that passes content on must label it with both, and two separately-optional fields could
  disagree — which is exactly how old bytes once went out under a newer revision's number and
  action id (see the `serveBlockArchive` bullet below). Producers: `StorageRepo.get` populates it
  from the `actionRev` that `IBlockStorage.getBlock(rev)` already returns — on the plain committed
  read, and on the pending-overlay read as the revision of the *committed base* the pending was
  applied over (a pending has no revision of its own). A pending-only insert — a block pended but
  not yet committed, read back by its own writer — genuinely has no committed base, so the field is
  **absent** on that answer rather than fabricating a revision; `TransactorSource.tryGet`'s
  `materialized?.rev ?? state.latest?.rev ?? 0` fallback then records revision `0`, the honest "no
  committed revision observed". `TestTransactor` mirrors that. `CoordinatorRepo` and
  `NetworkTransactor` forward peer entries verbatim, and the repo protocol is plain JSON, so the
  field rides along untouched. Consumers: `TransactorSource.tryGet` records
  `materialized?.rev ?? state.latest?.rev ?? 0` as the read dependency and re-emits the same number
  through `getReadRevision` so a `CacheSource` hit stamps the cache identically (recording
  `state.latest` there claimed the reader had observed content it never read, and the validator's
  stale-read check — exact equality against the block's current revision — then wrongly passed);
  `serveBlockArchive` labels the archive it serves with it; and `sourceBlockMeta` drops a push's
  metadata when it disagrees with `state.latest`. Being optional with that fallback is what let
  every producer that cannot report a materialized revision stay unchanged.
- **A peer asked for revision N serves revision N labelled N, or serves nothing.**
  `serveBlockArchive` ([`storage/block-archive.ts`](../packages/db-p2p/src/storage/block-archive.ts))
  answers every block-repair fetch, and labels the archive — revision number, action id, and the
  commit proof it looks up — from `materialized`, never from `state.latest`. The receiving side
  (`BlockStorage.saveRestored`) stores the archive's bytes under the archive's action id, so an
  archive that paired rev-1 bytes with rev 2's number and action id (what serving from
  `state.latest` did) silently overwrote the asker's own good rev 2 with rev 1's content, and left
  rev 1 unrecorded so every later read repeated the corruption. Two rules make that unrepresentable:
  the label IS the materialized revision, and a served revision strictly above the pin is refused
  (`undefined`, the "holds nothing" answer every caller already handles, which `restoreRevision`
  turns into a loud "not found during restore attempt") — that arm fires only for a repo that does
  not report `materialized` at all (a plain `IRepo` describing its latest) when that latest is newer
  than the pin. A served revision at or below the pin is the block unchanged since the pin.
- **The asker does not take that on faith.** Honest serving is one end of the rule; the other is
  that `BlockStorage.restoreRevision` vets every archive off this wire before a byte of it reaches
  storage (`vetRestoredArchive`), because the wire itself verifies nothing —
  `RestorationCoordinator.queryPeer` returns the response's archive straight through. An archive is
  refused whole (logged, and reported to the caller as the same "not found during restore attempt"
  an absent one produces) unless it names *this* block, every revision key is a revision in its one
  canonical spelling, each entry carries an action whose own `rev` — when it declares one — matches
  the key it is filed under, its LOWEST revision is at or below the pin, its declared `range` agrees
  with the revisions it carries and is not open-ended, and nothing it restates contradicts content
  this node already holds (`noDivergentRewrite`, comparing by `canonicalJson`; an identical
  restatement is not a conflict, so a re-restore stays idempotent). The lowest-not-exact rule is
  deliberate: `ActionContext.rev` is collection-wide, so the honest answer to a pin at 9 for a block
  last changed at rev 2 *is* rev 2, and demanding the pin's exact number would turn working
  historical reads into hard failures.
- **A restore claims coverage only up to the pin.** What lands in `meta.ranges` is
  `[archive floor, pin + 1)` — never the archive's declared `range`. Extending up to the pin is the
  one inference in the guard (a peer answering a pinned fetch with revision M ≤ N asserts nothing
  changed in `(M, N]`); without it `inRanges(N)` stays false and every later read at that pin re-runs
  the whole restore, never converging. Stopping at the pin is the matching limit: entries above the
  pin are still written, but claiming them would let a peer widen its own no-re-ask window by padding
  an archive with fabricated high revisions. Two accepted tradeoffs are recorded at the code site — a
  lying peer's answer is sticky across the span it was asked about, and the overwrite guard is
  first-writer-wins, so a poisoned revision becomes unreadable rather than wrong. Both are stated to
  be revisited if a restore ever gains a way to *verify* an archive.

### Collection Header Blocks
- Header blockId = collection name (deterministic)
- All nodes MUST share the same header block for a collection
- Two entry points, differing only in what they do when the header probe comes back empty:
  - `Collection.open()` — checks local storage first, then cluster; resolves `undefined` when
    the header is *authoritatively* absent (nothing has ever been committed under this id).
    Nothing is staged, so a caller that ignores the `undefined` cannot later sync a phantom
    collection. A header whose log will not open is a fault, not an absence, and throws — as
    does a header the storage layer could not **retrieve** (an unreconstructable revision, an
    unreachable cohort), which surfaces as a thrown `BlockUnavailableError` rather than an
    absence (see the three-valued block answer above).
  - `Collection.createOrOpen()` — same probe, but stages a fresh header in the local tracker on
    a miss (nothing reaches storage until `sync()`), logging `collection:invented` under the
    `optimystic:db-core:collection` namespace.
- Which one a caller gets is decided by whether *inventing* the collection is a correct answer:
  - Pure reads take `open`. An invented collection reads as a legitimately empty dataset, which
    an application cannot distinguish from — or defend against — a collection it simply could not
    reach. The plugin's table catalog (`tree://optimystic/schema`) reads this way.
  - First writes and bootstrap paths take `createOrOpen`.
  - A collection that has been *declared* but never written to also takes `createOrOpen`, because
    it genuinely has no committed header yet — its header is only committed on the first write, so
    at the block layer "empty" and "absent" are the same state. This is why the plugin's data and
    index trees keep create-on-missing even on read paths.
- `Tree` and `Diary` mirror both entry points (`Tree.open` / `Tree.createOrOpen`,
  `Diary.open` / `Diary.createOrOpen`). `Tree.open` returns before any B-tree is constructed when
  the header is absent, so no trunk over an invented root is ever built.

#### The revision context is monotonic
- A `Collection`'s `ActionContext.rev` is the revision it last knows itself committed at. Every
  assignment from a read goes through `Collection.advanceContext`, which may **advance** the
  revision or leave it alone but never lower it — not to an older revision, and not to `undefined`.
  This covers both sites that read one: `attachToLog` (bootstrap from the committed log tail, then
  adopt `Log.getActionContext()`, which resolves `undefined` for a tailless or entries-empty chain)
  and `updateInternal` (adopt `Log.getFrom(...).context`, which resolves `undefined` for a log that
  will not open). In `updateInternal` the adoption is also **ordered**: it must precede the
  conflict replay — see "Conflict replay must read at the revision it is adopting, not the one it
  is leaving" above before moving that statement.
- The rule exists because a read that found *less* than what the client already committed is a
  read that lost information, not a revision rollback. Accepting it makes the next `sync` request a
  revision that is long gone, and — since `syncInternal` re-runs `updateInternal` between retries —
  every retry repeats the same doomed request, burning the whole retry budget and surfacing as a
  contention-shaped `SyncRetryExhaustedError` rather than the real fault.
- Monotonicity means a refresh can end **below** where it started looking. `updateInternal` reads
  the committed tail's revision (the authoritative "latest committed under this id") before the
  walk, and compares it against where the walk left the collection; landing short means the refresh
  demonstrably closed nothing. That is reported — `collection:context-short-of-tail
  id=… tag=… before=… after=… tail=…` on the same namespace — and nothing more: it does not throw (this
  same `update()` runs blanket-style over every registered collection between commit retries) and
  it does not adopt the tail's number (the two numbers come from different read paths, and adopting
  the higher one erases the disagreement). The comparison is local to one node's own reads, so
  silence is not proof the collection is current — see `docs/debugging.md` § "Did the refresh
  itself fail to close the gap?" for how an operator reads presence and absence.
- Adoption is also the one seam where **lineage divergence** is observable, and that is a
  different failure from lagging. Revision numbers are per-collection counters, so two
  separately-built copies under one id can each sit at the same revision under different actions
  while each stays internally self-consistent — which is exactly why `context-short-of-tail`
  cannot see it (both of its numbers come from one chain). `advanceContext` therefore compares the
  two contexts' action ids across every revision they both name one for, and reports the LOWEST
  one they disagree at — the point the lineages actually parted, which is usually below either
  side's current revision once a forked copy has kept writing. The line is
  `collection:lineage-divergence id=… tag=… site=… forkRev=… heldAction=… readAction=… heldRev=… readRev=…`.
  Like the shortfall line it only logs — adoption proceeds unchanged, which makes it a
  per-discovery report rather than a per-refresh one. Both adoption sites run it and `site=` says
  which: on `updateInternal` (`site=refresh`) it contrasts this node's copy with the stored log,
  while on `attachToLog` (`site=attach`) it contrasts the tail block's `state.latest` (adopted on
  trust by `bootstrapContext`) with a walk of that tail's own chain, so a line there indicts
  storage rather than a replica. `tag=` on all three lines names the reporting *handle*
  (`Collection.instanceTag`), since one process routinely holds several over one collection id and
  their lines otherwise read as one handle contradicting itself.
- A header that reads *authoritatively absent* while the collection holds a committed revision is
  a contradiction, not an absence: the client has proof something was committed under this id.
  `updateInternal` throws `CollectionHeaderVanishedError` (naming the collection and the held
  revision) instead of no-opping. Like `BlockUnavailableError`, it is not a `StaleFailure`, so
  `sync`'s retry loop does not absorb it. A collection that has **never** committed holds no
  revision, so there is nothing to contradict — the absent-header no-op stays correct for it,
  which is what keeps `createOrOpen`'s invent path working.

## Cohort-Topic Port Boundary

The cohort-topic substrate is split across packages so that **db-core stays free of any network/disk dependency** (the same bar that keeps blocks, trees, and logs transport-agnostic).

- **Pure logic in `db-core`** (`packages/db-core/src/cohort-topic`): wire formats + codecs, tier addressing (`coord_d`), the registration store + TTL, willingness / promotion-demotion state machines, sharding, the capacity barometer, walk *decisions*, and gossip *merge*. It depends only on a hash function and byte-array peer IDs.
- **Transport binding in `db-p2p`** (`packages/db-p2p/src/cohort-topic`): the FRET + libp2p implementations — protocol handlers, `RouteAndMaybeAct` routing, cohort assembly, threshold-sig collection, cohort gossip transport, membership-cert fetch, size estimator.

db-core defines seven **ports** (`packages/db-core/src/cohort-topic/ports.ts`) that db-p2p implements: `ITopicRouter`, `ICohortGossipTransport`, `IMembershipSource`, `ICohortThresholdCrypto`, `IMembershipPublishSink`, `ISizeEstimator`, and `IRingHash`. db-core substrate modules take these by injection; db-p2p constructs the FRET-backed versions and composes them. `RingCoord` and `PeerRef` are db-core-owned types — db-p2p maps `RingCoord` onto FRET's coordinate type.

`coord_d` hashing uses db-core's **own** SHA-256 via `IRingHash` (`RING_BITS` default 256 = the full digest, byte-compatible with FRET), **not** a FRET hash import. The guard `packages/db-core/test/no-fret-import.spec.ts` fails the build if anything under `db-core/src/**` imports `p2p-fret` or `libp2p`.

### Registration-record lifecycle

`packages/db-core/src/cohort-topic/registration/` owns the cohort-side **local** soft state — the store, the deterministic load-sharding under it, and the TTL lifecycle. Peer ids are raw `Uint8Array` (the substrate's `PeerRef.id` form, *not* the structural `network/types.ts` `PeerId`); the wire layer carries them as base64url, and the renewal/handoff bridges translate at that boundary.

- **Store** (`store.ts`) — `createRegistrationStore()` returns an in-memory `RegistrationStore` doubly indexed by topic then participant (outer map → inner map), giving O(1) `getByParticipant`/`delete`, O(participants) `listByTopic`, plus `directParticipants` (the stock count driving promotion) and `evictStale(now)` (removes and returns records where `now − lastPing > ttl`, strict greater-than). `appState` is the application's opaque slot; the layer never interprets it.
- **Slot assignment** (`sharding.ts`) — `createSlotAssigner(hash)` exposes `assignSlots(participantId, cohortEpoch, members)`: members sorted ascending by id, `slot = H(participantId ‖ cohortEpoch) mod k` (full-digest MSB-first mod, no bigint), `primary = order[slot]`, `backups = order[slot+1 .. slot+2]` wrapping mod `k` (capped at `k − 1`). Deterministic and order-independent; the renewal and handoff sides share one assigner.
- **TTL renewal** (`renewal.ts`) — participant side pings the primary every `ttl/3`; three consecutive failures promote `backups[0]` via a re-attach RPC, all-fail re-runs lookup from `d_max`. The `cohortEpoch` hint refreshes **lazily** (on the next `primary_moved` reply, not at failover). Cohort side `onRenew` touches `lastPing` + gossips, or returns `primary_moved` when a rotation moved the slot off this member; `sweepStale` evicts + gossips each eviction.
- **Rotation handoff** (`handoff.ts`) — per-member state machine over an injected transport: `start()` recomputes slots under the new epoch and broadcasts a primary inventory; `onInventory` pulls each record now assigned to this member from its previous holder, re-stamps its `primary`/`backups`, and acks; the previous holder **dual-serves** (answers renews) until that ack arrives (`isServing`/`onAck`).

Transports (`RenewalParticipantTransport`, `RenewalGossip`, `HandoffTransport`) are injected, so storage + sharding + TTL are unit-testable in isolation with mocks. Cross-member replication runs over the cohort-gossip driver in the host (`packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts`): the `RenewalGossip` `touch`/`evicted` hooks append to a per-coord delta queue, and a periodic host timer (`gossipIntervalMs`, default 5 s) drains the batch into a signed `CohortGossipV1` broadcast each round — alongside the TTL sweep, membership-cert refresh, and demotion check. Each frame carries its `coord`, so a node serving many cohorts routes inbound gossip to the right per-coord store/view.

### Service composition

The substrate's two top-level entry points compose the lower modules behind the ports above:

- **`CohortTopicService`** (`packages/db-core/src/cohort-topic/service.ts`) — the **participant-facing** service. It drives the full lifecycle for a node that wants to attach to a topic and runs purely over injected ports: `ITopicRouter` (walk / register / direct-dial via FRET's `RouteAndMaybeAct`), `ICohortGossipTransport`, `IMembershipSource`, `ICohortThresholdCrypto`, `IMembershipPublishSink`, `ISizeEstimator`, and `IRingHash`. It owns no FRET or libp2p import.
- **`CohortMemberEngine`** (`packages/db-core/src/cohort-topic/member-engine.ts`) — the **cohort-side** engine. It runs on the `k` peers FRET names as the cohort: handling inbound registrations/renewals, willingness checks, promotion/demotion decisions, gossip merge, and membership publication.

The participant pipeline is **walk → register → gossip → promote**: the participant estimates `d_max` from the size estimator and walks inward toward the topic root, registers at the landed cohort via the router (`key = coord_d(self, topicId)`, `activity = RegisterV1`, `wantK = k`, `minSigs = k − x`), the cohort replicates and reconciles soft state over gossip, and promotion/demotion redirects flow back as threshold-signed notices.

The **FRET host** (`packages/db-p2p/src/cohort-topic/host.ts`) scopes the cohort side **per served coordinate**. A node belongs to many cohorts — one per coord FRET routes to it — so the host keeps a lazy `servedCoord → CoordEngine` registry rather than a single node-level engine. Each `CoordEngine` owns its own registration store, gossip bus, willingness/traffic/renewal/cold-start, and a `CohortMemberEngine`, and threshold-signs / shards with the FRET cohort assembled **around the served coord** (`coord_d(P, topicId)`), not the node's own ring position. FRET's activity callback does not carry the routed key, so the host recomputes it from the decoded `RegisterV1` (`coord(treeTier, participantCoord, topicId)`) and dispatches to `registry.forCoord(servedCoord)`; a `RenewV1` (no `treeTier`) is resolved instead by the held record (`registry.findHolder`), falling back to `unknown_registration` when no local engine holds it. The node-wide collaborators (hash, slot assigner, barometer, threshold signer, the FRET ports, and the participant-facing service) are singletons injected into every engine. The promotion tier inputs are coord-derived: `treeTier` is fixed at instantiation, `parentCoord = coord_{d−1}(P, topicId)`, and `childCohortCount` is `0` for the current single-tier-0-cohort milestone.

### Protocol IDs

`db-p2p` registers four libp2p protocols on the FRET node, binding the db-core ports to FRET + libp2p:

```
/optimystic/cohort-topic/1.0.0/register       — Register, renew, re-attach
/optimystic/cohort-topic/1.0.0/cohort-gossip  — record replication, willingness, load barometers
/optimystic/cohort-topic/1.0.0/promote        — threshold-signed promotion/demotion notices
/optimystic/cohort-topic/1.0.0/membership     — membership certificates
```

The package split is strict: **db-core never imports FRET or libp2p** (enforced by `packages/db-core/test/no-fret-import.spec.ts`); **db-p2p** (`packages/db-p2p/src/cohort-topic`) is the only place the ports are bound to FRET's `RouteAndMaybeAct`, two-sided cohort assembly, and size estimator.

## Matchmaking subsystem

Matchmaking is the directory application of the cohort-topic substrate (`docs/matchmaking.md`): "find me peers that match a label." db-core owns the transport-agnostic pieces (`packages/db-core/src/matchmaking`): the stable topic anchor (`topic-anchor.ts`, `H(kind ‖ label ‖ "match")` — non-rotating, unlike reactivity), the V1 wire codecs + per-entry re-validation (`wire.ts`), the provider/seeker registration state (`provider.ts` / `seeker.ts`), the pure capability filter + query evaluation (`capability-filter.ts` / `query-eval.ts`), the pure hang-out-vs-continue decision engine (`seeker-walk.ts`), and the pure multi-cohort sweep orchestration (`multi-cohort-seeker.ts`). db-p2p wires these to the substrate (provider/seeker managers, the cohort query handler, the seeker walk client that drives register → query → hang-out/escalate, the root aggregate-count producer, the seeker-side traffic bounds, and the cohesive public module). The advisory trust model is the spine: a cohort vouches only for "these were the registrations I held"; the seeker re-validates each forwarded entry's `registrationSig` independently, so the cohort signature can stay single-member (advisory) rather than threshold.

### Multi-cohort sweep + aggregate counts

For a *hot* topic whose providers span many tier-`d ≥ 1` cohorts, the prefix-biased single-cohort sample is unrepresentative, so a seeker that wants a cross-ring sample (voting quorums, fairness audits) does a **sweep** (`docs/matchmaking.md` §Multi-cohort sweep):

- **Root-side producer** (`packages/db-p2p/src/matchmaking/aggregate-counts.ts`, `buildAggregateCount`) — a *promoted* root cohort answers with an `AggregateCountV1`: log-bucketed provider counts per tier-1 prefix shard, **threshold-signed**. Two invariants are enforced: (1) a **depth gate** — it returns `undefined` when tree depth `< aggregate_count_minimum_tier` (default 1), so a cold cohort that fell through to `NoState` summarizes nothing; (2) **log-bucketing** through the db-core `logBucketCount` (largest power of two `≤ n`), which rounds *down*. Unlike `QueryReplyV1`'s single-member signature, the aggregate carries the cohort-topic threshold-sig envelope `(signature, signers)` — it attests a cohort-agreed *registered*-provider count. Per-shard counts, depth, epoch, and the threshold signer are injected (the FRET host's root `CoordEngine` binds them); the canonical image (`aggregateCountSigningPayload`) sorts buckets so signer/verifier agree.
- **Seeker-side orchestration** (`packages/db-core/src/matchmaking/multi-cohort-seeker.ts`, pure) — `selectShards` ranks the buckets by population (high first), accumulating bucketed counts until they cover `wantCount`, capped at a fan-out ceiling. Because bucketing rounds down, the true population is always `≥` the reported sum, so selection naturally **over-provisions** rather than under-selecting. `runMultiCohortSweep` fetches the aggregate (injected `MultiCohortSweepPorts`), optionally threshold-verifies it, queries each elected shard, and unions the deduped + `registrationSig`-re-validated providers — a cold/untrusted aggregate yields an empty set so the caller falls back to the single-cohort sample.

### topicTraffic consumption + adversarial bounds

Every `Accepted`/`Promoted` reply carries the substrate's `topicTraffic` barometer (`directParticipants`, `arrivalsPerMin`, `queriesPerMin`, `childCohortCount`). The hang-out engine consumes it (`seeker-walk.ts` `decide`); the seeker walk client also folds `max(childCohortCount)` across the walk into `SeekerWalkResult.maxChildCohortCount`, which the public session / voting `QuorumDiscovery` binding uses as the *single-cohort-vs-sweep* signal (`> 0` ⇒ hot ⇒ escalate to the sweep).

Because the reply's traffic is signed by the cohort **primary's single member key, not a threshold signature** (the response is advisory), a malicious primary can over- or under-report. `packages/db-p2p/src/matchmaking/traffic-validation.ts` (`boundReportedTraffic`) makes the bounded harm explicit (`docs/matchmaking.md` §Adversarial cohort traffic reporting):

- **Over-report** (fake hot tier ⇒ seeker hangs out): `capPatienceMs = max(0, patienceRemaining)` — a fabricated hot tier wastes at most the seeker's remaining wall-clock patience, then the walk proceeds with its one register hop. No spatial flood: the walk only ever steps *toward the root*.
- **Under-report** (fake cold tier ⇒ seeker escalates): `escalateAfterTiers = 1` (one extra hop per tier); `maxWalkHops(dMax) = (dMax + 1)` is the total-hop ceiling, since escalation is monotone toward `d = 0`.

These hold **by construction** of the toward-root-only walk, so the function documents + asserts the bounds rather than changing the topology. It also **emits** `TrafficCrossCheckSignal`s (over-/under-report suspicion, cross-checking a reply's reported population against the seeker's own immediate-query yield); `reportTrafficCrossCheck` is a thin bridge into the existing reputation subsystem (`IPeerReputation.reportPeer`, `ProtocolViolation`). The aggregation/decay/penalty policy that turns advisory signals into a sanction stays the reputation subsystem's job — matchmaking provides the emission points only.

### Public module

`packages/db-p2p/src/matchmaking/module.ts` composes the lower pieces into the two public roles (`docs/matchmaking.md` §Overview): `MatchmakingProviderSession` (`register(topic, payload)` / `renew` / `withdraw` / `setCapacity` / `signalFull`) and `MatchmakingSeekerSession` (`register` / `query` / `walk` — the hang-out walk escalating to the sweep on a hot topic). `createMatchmakingQuorumDiscovery` binds the db-core voting `QuorumDiscovery` port to walk (single-cohort) + sweep. The `*Session` classes are the substrate-wired entry points; the same-named db-core `MatchmakingProvider` / `MatchmakingSeeker` are the transport-free state builders they compose (named `*Session` to avoid the collision). All substrate I/O — walk transport, one-shot query, `d_max` estimate, sweep ports — is injected, the same "everything behind a port, mock-tier e2e pending" posture as the rest of the subsystem.

### Voting-quorum assembly

The voting subsystem's **discovery** flow is a thin composition over that surface — `packages/db-core/src/matchmaking/voting-quorum.ts` (`VotingQuorumAssembler`). It adds only the glue; every genuinely voting-layer concern (eligibility-proof minting, the quorum selection rule, ballots/tally/dispute) is injected or out of scope.

- **Anchor.** `quorumTopic(proposalHash) → { kind: "quorum", label: proposalHash }`, resolved via the matchmaking anchor to `topicId = H("quorum" ‖ proposalHash ‖ "match")`. Quorum topics are short-lived: the tree demotes once the proposal closes and voters stop renewing.
- **Eligibility-proof-bearing registration.** `registerEligibleVoter` binds the caller-minted opaque proof into the provider `capabilities` under the reserved `voter-eligibility:` tag prefix, then registers as a normal `MatchmakingProvider` (default `capacityBudget = 1` — a voter accepts one vote-collection RPC). Because `providerSigningPayload` covers `(topicId, capabilities, capacityBudget)`, the provider's `registrationSig` attests the proof verbatim, and it survives forwarding as a `ProviderEntryV1` for self-checkable re-validation.
- **discover → verify → select pipeline.** `assembleQuorum` (1) drives the single-cohort `walk`; (2) escalates to the multi-cohort `sweep` when the topic is hot (`childCohortCount > 0`) or `preferSweep` is set; (3) dedups the unioned candidates by `participantId`; (4) applies the optional, additive `reputationPrefilter`; (5) re-validates each entry's `registrationSig` (`verifyProviderEntry`) **and** the injected `verifyEligibility` — both must pass; (6) applies the injected `select` rule (default first-`targetSize`). It never dials voters, never collects ballots, never tallies.
- **Discovery seam.** db-core is transport-free, so the walk/sweep I/O is injected as a `QuorumDiscovery` port (bound in db-p2p to `MatchmakingSeeker.walk` + `multi-cohort-seeker`). The per-entry `EntrySigVerifier` and the provider `sign`/`registerProvider` hooks are likewise injected, matching the rest of the subsystem.
- **Snapshot / TTL semantics.** A voting window (`patienceMs` 30–300 s) can outlast `provider_ttl` (60–90 s). The assembled set is a TTL-bounded **snapshot**: voters renew to stay listed, a voter that stops renewing ages out and may be returned-then-dead between assembly and vote-collection, and the voting layer re-validates liveness on dial. Matchmaking does not pin voters. Delegation: the seeker role (coordinator or a delegated assembler peer) owns `patienceMs` and the re-validation duty; a handed-back set is independently checkable, so a coordinator may trust-but-verify by re-running steps 5–6.

## Third-Party Address Learning

libp2p tells a peer's addresses only to the peers it is **directly connected to**.  There is no relay-side gossip of reservations, and this stack registers no peer-routing service (no kad-dht, no `peerRouters`), so a dialer has no `findPeer` fallback either.  A cohort here is chosen by *key position*, not by who happens to be connected, so a node routinely lands in a cohort with a peer it has never met.  When that peer is reachable only through a circuit relay — a phone, a laptop behind NAT — the third party holds an empty address list for it and a dial by peer id alone fails immediately with `NoValidAddressesError`, while membership logs on every node still read healthy.

db-p2p therefore learns third-party addresses from **its own protocol messages**, which already carry them: `ClusterRecord.peers[*].multiaddrs` and a redirect payload's `{ id, addrs }`.  Every ingress for those addresses funnels through one writer, `packages/db-p2p/src/peer-address-book.ts` — the only place in this repository that writes the libp2p peerStore:

- `ClusterService.processOperation` merges the record's peer map *before* deciding to redirect and *before* running consensus, since both go on to dial those peers.
- `ClusterClient.update` merges the peer map of the record a member returns (the coordinator's half of the same exchange).
- `ClusterClient` and `RepoClient` merge a redirect target's `addrs` *before* dialing it, so the very first hop benefits.
- The dispute path deliberately does **not** merge: a challenge's `originalRecord` is attacker-supplied and already flagged as unverified on that path.

Merging a multiaddr only makes a dial *attempt* possible — the dialed peer still authenticates by peer id at the noise handshake, so an address from an unverified record can waste a dial but can never impersonate.  What needs bounding is cost, not authenticity — and the ingress is genuinely unvalidated: `ClusterService` learns before `checkRedirect` and before `cluster.update` checks a signature, and inbound stream authorization (`authorizeInboundStream`) is opt-in, so the peer map is whatever the dialer chose to send.  Two caps bound it: `MAX_MERGED_ADDRS_PER_PEER` (8 addresses per peer per message) and `MAX_LEARNED_PEERS_PER_RECORD` (64 peers per record — real cohorts are `clusterSize`, single digits).  Both record ingress points share one traversal (`mergeRecordPeerAddresses`) so the second cap cannot be applied in one place and forgotten in the other.

The mirror duty falls on the **producer**: a node may only put into those messages addresses a third party can actually reach.  Two sources feed a `ClusterRecord.peers` entry (and a redirect payload's `addrs`), in this order — the remote address of each **outbound** connection this node holds to that peer, then that peer's peerStore addresses.  **Inbound** connections contribute nothing, because an inbound `remoteAddr` is the far side's ephemeral source socket (the port its OS picked for that one connection): unreachable by anyone else, indistinguishable from a listen address once on the wire, and therefore merged by the recipient anyway — burning a slot against `MAX_MERGED_ADDRS_PER_PEER` and a dial attempt.  One predicate, `publishableConnectionAddr` in `peer-address-book.ts`, decides the direction half of that rule, and one function beside it, `publishableAddrsForPeer`, joins both halves into the address set a producer may publish — connection addresses first (libp2p has just succeeded with those), then the peerStore's, de-duplicated. Every producer goes through it: `findCluster` and all three redirect-address resolvers (`libp2p-node-base.ts`'s injected one, and the fallbacks in `ClusterService` and `RepoService`). The redirect resolvers used to read connections *only*, which is how the same peer could be described with a circuit address in a cluster record and with no address at all in a redirect — for a relay-only peer that had dialed us, the peerStore was its only address anywhere on this node. That is one rule with one implementation now; the two `getConnectionAddrs` component hooks are async in consequence, since a peerStore read is.  `packages/db-p2p/docs/cluster.md` § Access Control carries the full rationale.

Cohort members with no dialable address are still admitted — dropping them would shrink the cohort below `clusterSize` and put the consensus super-majority out of reach — but `findCluster` logs `findCluster:addressless-members` whenever the count is non-zero, so the condition is visible rather than silent.  That diagnostic is load-bearing for the producer rule above: an inbound-only member whose peerStore is still empty now publishes no address at all, and this is the line that says so.

"Publishable to a third party" and "dialable by us" are separate questions, and a relay is where they come apart.  A relay learns its own reservation holders by the address they advertise, `/<relay's transport addr>/p2p/<relay's peer id>/p2p-circuit` — which every other node can use and the relay itself cannot, since using it would mean relaying to the client through itself.  So that address stays **published** (a cohort sibling reaching the client through our relay is the working path) while being undialable by the one node holding it.  `classifySelfDialability`, next to `publishableConnectionAddr` in `peer-address-book.ts`, answers the second question; `Libp2pKeyPeerNetwork.connect` consults it once on the cold path and throws `SelfRelayOnlyAddressesError` rather than attempting a dial that cannot succeed, and `findCluster` reports the count as `selfRelayOnly` on `findCluster:done`.  Both conditions produce the same libp2p error text otherwise, so without the split a log cannot say whether a member was never taught an address or was taught one we cannot use — and only the first of those is ever repaired by a retry.

The seam is the optional `recordPeerAddresses?(peerId, multiaddrs: string[])` on `IPeerNetwork` (`packages/db-core/src/network/i-peer-network.ts`); implementations without an address book (test doubles, the in-memory mesh harness) simply omit it.  `packages/db-p2p/test/relay-third-party-address-gap.spec.ts` pins the libp2p-level premise: if a future libp2p ever propagates third-party addresses on its own, that spec's first assertion fails and tells us this whole mechanism has become redundant rather than load-bearing.

## Cluster Authentication

The cluster two-phase commit uses **cryptographic signatures**, not to be confused with ACLs.  Each peer in a `ClusterRecord.peers` entry carries a `publicKey: Uint8Array` derived from their libp2p peer ID.

- **Promise phase**: each cluster member signs the promise hash with its private key
- **Commit phase**: each cluster member signs the commit hash with its private key
- **Validation**: every peer verifies all signatures against `record.peers[peerId].publicKey` before accepting the record

This proves that the peers listed in the cluster actually voted — a coordinator cannot forge votes.  The signing and verification flow lives in `ClusterMember`: `signVote` signs the hash+vote payload with the local peer's Ed25519 private key, `verifySignature` reconstructs the public key from `record.peers` via `publicKeyFromRaw` and verifies the signature, and `validateSignatures` runs verification for all promises and commits on every incoming record.  The signing payload includes the vote type and reject reason (if any), preventing vote tampering.

**Important**: cluster authentication is about _identity verification_ (did this peer really vote?), not _authorization_ (is this peer allowed to write?).  Authorization decisions like per-collection permissions belong at a higher layer (e.g. application or collection module), not in the cluster consensus path.  The one authorization seam this library *does* provide is the coarse per-stream gate below — "may this peer talk to my database at all?" — not per-collection permissions.

## Inbound Stream Authorization

The four database protocols — `repo`, `cluster`, `sync`, `block-transfer` — otherwise go straight from "inbound stream opened" to "decode and execute the operation".  Any peer that can open a connection can therefore issue database operations.  An application embedding this library whose database is *private* (only nodes it admitted may read or write) needs a seam ahead of decoding; `authorizeInboundStream` is it.

```ts
const node = await createLibp2pNode({
  /* … */
  authorizeInboundStream: (remotePeerId, protocol) => memberSet.has(remotePeerId),
  authorizeInboundStreamTimeoutMs: 5_000  // optional; this is the default
});
```

It is **one node-level option threaded to all four services** (`packages/db-p2p/src/libp2p-node-base.ts`, `inboundAuthorization`), not four per-service options: "is this peer allowed to talk to my database?" is a property of the node, not of the protocol, and four independently-settable options make it easy to secure three surfaces and silently miss the fourth.  Each service still accepts the same option in its own init (`RepoServiceInit`, `ClusterServiceInit`, `SyncServiceInit`, `BlockTransferServiceInit` all extend `InboundStreamAuthorizationInit`) so the services stay independently testable and usable outside the node factory.  The gate itself lives in `packages/db-p2p/src/inbound-authorization.ts`.

Semantics:

- **Absent predicate → today's behavior exactly.**  Each service holds `InboundStreamAuthorization | undefined`; when it is `undefined` the handler awaits nothing extra and no gate code runs.  This is the default.
- **Supplied predicate → fail closed.**  Only a literal `true` allows the stream.  `false`, a throw, a rejection, expiry of the timeout, or an inbound connection with no resolvable remote peer id all **deny**, and denial aborts the stream *before* any frame is decoded or any operation executed.  Failures are logged (via the service's error logger), never swallowed.
- **Once per inbound stream, not per operation.**  All four protocols are strictly one request per stream — each handler's generator `return`s after the first response, so a second frame queued on the same stream is never read or parsed.  Per-stream and per-operation authorization are therefore equivalent here.  (The `repo` protocol's `RepoMessage.operations` is an array, but the handler executes `operations[0]` only.)  A single `commit`/`pend`/`pull`/`push` may still name many block ids; the gate is not a per-block ACL.
- **Peer id encoding**: the predicate receives `connection.remotePeer.toString()` — the libp2p base58btc/CIDv1 string (`12D3KooW…`).  Compare against that, never against a multiaddr or a raw public key.
- **What a caller observes**: a stream reset.  Denial is deliberately *not* reported on the wire — telling an unauthorized peer "you are not a member" confirms membership state to exactly the party the embedder decided not to trust, and the four protocols have four different response shapes with no common error frame.  The denial is loud on the *denying* node instead: logged with peer id, protocol and reason, and the stream is aborted with an `UnauthorizedInboundStreamError` carrying `ERR_INBOUND_STREAM_UNAUTHORIZED`.
- **Self-dials never reach the gate.**  libp2p refuses to dial self at three layers (connection manager, dial queue, upgrader), and every internal caller short-circuits self before dialling anyway (`ClusterCoordinator.updateMember`, `clusterLatestCallback`, `fetchArchiveFromPeer`, `RestorationCoordinator`, `SpreadOnChurnMonitor`).  An embedder predicate that only knows about remote members will therefore never deny its own node.
- **Cost**: the predicate sits in the hot path of every inbound stream.  Keep it to an in-memory lookup; memoize anything that would otherwise hit storage or the network per stream.

**Scope**: the four database protocols only.  The `dispute` protocol (`packages/db-p2p/src/dispute/service.ts`, which asks this node to vote on a challenge) and the reactivity, matchmaking, cohort-topic and libp2p built-in (`identify`/`ping`/`dcutr`/…) protocols the same node registers are *not* gated by this option.  To refuse a peer across *every* protocol at once, including `identify`, use the connection-level `connectionGater` option instead (`NodeOptions.connectionGater` → libp2p's `denyInboundConnection`); the two are complementary — the gater decides whether to talk to a peer at all, this hook decides whether an already-connected peer may touch the database.

### Equivocation Detection

`ClusterMember.detectEquivocation()` catches peers that flip their vote (approve → reject or vice versa) for the same transaction phase. During `mergeRecords()`, if an incoming signature has a different vote type than the existing one for the same peer:

- The **first-seen** signature is preserved (the flip is rejected)
- A `PenaltyReason.Equivocation` penalty (weight 100) is reported via the reputation service
- A single equivocation triggers a ban (weight 100 exceeds the default ban threshold of 80)

Same-type re-delivery (retransmission) is not flagged, avoiding false positives.

### Validity Disputes & Cascading Consensus

When cluster peers disagree on transaction validity, the transaction is blocked and escalated to progressively wider audiences until one side achieves consensus. The losing side is ejected and the ring segment self-heals. The coordinator is implicitly on the "approve" side (it validated before sending to the cluster), so disagreeing members independently orchestrate the escalation through a deterministically-selected dissent coordinator. See [Right-is-Right](right-is-right.md) for full details.

## Read Dependency Validation

Read dependency tracking prevents **write-skew anomalies** in optimistic concurrency control. A block read during a transaction is recorded as a `ReadDependency` (`{ blockId, revision }`), and validators check that none of those blocks have been modified before allowing the transaction to commit. Most reads are recorded (default), but purely-structural *navigation* reads are excluded from the conflict set — see the point-lookup exclusion note below and `docs/correctness.md` Theorem 5.

**Data flow**: `TransactorSource.tryGet()` records reads → `Collection` delegates → `TransactionCoordinator` aggregates across collections → `TransactionSession.commit()` collects reads into the `Transaction` → `TransactionValidator` checks each read against current block state.

Key design decisions:
- Reads are captured at `TransactorSource.tryGet()` (and `CacheSource.tryGet()`) level. Each read carries a `ReadPurpose` (`value` | `navigation`), defaulting to `value` everywhere so an unclassified read is always retained (fail-safe — a forgotten tag can only over-reject, never miss a conflict). The `ReadDependencyCollector` keeps the highest revision (max-wins) and the stronger purpose (value-wins) per block, and `getReadDependencies()` returns only the `value` reads.
- **Point-lookup navigation exclusion:** a `BTree.get(key)` descent tags the interior branch nodes it merely walks through as `navigation` and upgrades the terminal leaf back to `value` (`markReadValue`), so the interior reads drop out of the conflict set. This is safe because any concurrent change to the queried result also bumps the retained leaf (`docs/correctness.md` Theorem 5). Range scans, `find`, writes, the root, the collection header, and all log-chain reads stay retained (`value`) — the exclusion is conservative and opt-in.
- `CacheSource` naturally deduplicates — only the first read of a block reaches `TransactorSource`
- Reading a **non-existent** block records *nothing* — both `TransactorSource` and `CacheSource` skip an absent block, so a transaction is **not** invalidated when a block it failed to find is later created. (This is deliberate; it used to happen by accident via a `revision: 0` record. Whether phantom-read protection should exist as a *designed* capability — with a "must still be absent" assertion distinct from revision equality — is an open question, not a settled "no".)
- `BlockStateProvider` is optional in `TransactionValidator` — when absent, read validation is skipped (backward compatible)

## Proximity Verification

`CoordinatorRepo` rejects write requests for blocks the node is not responsible for. FRET routing is the primary guard; proximity verification catches misrouted requests.

- **Write path (strict)**: `pend`, `cancel`, `commit` throw `Not responsible for block(s): ...` if any block fails the cluster membership check
- **Read path (soft)**: `get` logs a warning but still serves — reads are best-effort
- **Fail-open**: If `findCluster` throws (network failure), the check assumes responsible to avoid false rejections
- **Caching**: `LruMap` with 1000 entries and 60s TTL avoids repeated `findCluster` lookups

## Cluster Health Monitors

Two topology-aware monitors react to peer arrivals/departures via `connection:open`/`connection:close` events on libp2p. Both are `Startable`, debounce rapid changes, and suppress activity during detected partitions.

### RebalanceMonitor

Tracks whether the local node's responsibility for blocks has changed after topology shifts. Emits `RebalanceEvent` with `gained`/`lost` block lists, `newOwners` for lost blocks, `grown` (see below), and `floor` (the replication floor `N` = `getCohortSize()`). Throttled to one scan per `minRebalanceIntervalMs` (default 60s).

**Cohort growth (`grown`).** Both departure-driven push paths (rebalance `lost`, spread-on-churn) fire only when a node *loses* a block, so a block whose cohort merely GREW was never copied to the peers that joined it. `grown` closes that: blockId → the cohort peers not yet CONFIRMED to hold that block (never self). Per block the monitor remembers `{ responsible, cohortPeers, pendingPeers, growthAttempts, abandonedPeers }`; a **missing** entry means "prior cohort empty", so the first check after start/restart reports the whole non-self cohort — that is what heals a block committed while the deployment was one machine. Losing responsibility clears all of that growth state, so a regain re-reports. `growthBlockBudget` (default 64) caps grown blocks per check (filled fresh-growth-first, retries with the remainder, so a stuck retry set cannot starve peers that just joined); a dropped block's snapshot is deliberately left un-updated so the next check re-detects it.

**Confirmation-driven seen set.** Reporting a peer `grown` does NOT record it as seen — only the reaction's feedback does. `handleRebalanceEvent` returns a per-block `GrowthOutcome { satisfiedPeers, complete }` in its `growth` map, and the node-base handler feeds each one to `RebalanceMonitor.recordGrowthOutcome`. A peer enters a block's seen set only once a replica is confirmed on it, or once the block otherwise reached its floor; a block the reaction had NO information about (its confirm was deduped against one already in flight) gets **no map entry**, and the monitor leaves that block untouched. So a push that fails any way at all — dial timeout, receiver refused to persist, partition mid-reaction, reaction threw — leaves the peer un-seen and the next check re-reports it. Three bounds keep that from becoming a live loop:

- **`growthMaxAttempts`** (default 5): that many consecutive `complete: false` outcomes for a block moves its still-unsatisfied peers into a per-block abandoned set, no longer pushed to. Each check intersects both the seen and abandoned sets against the current cohort, so an abandoned peer that leaves and rejoins is retried from scratch. The counter resets on a `complete: true` outcome and on any check where the block owes nothing (so leftovers from a departed peer are never spent on the next joiner); it is a *lower* bound on retries rather than an exact count — see the `NOTE:` in `recordGrowthOutcome` for the two cases that blunt it.
- **`growthRecheckIntervalMs`** (default `minRebalanceIntervalMs`, `0` disables): checks otherwise fire only on libp2p connection events, so a failed push on a then-quiet network would never be retried. While growth work is outstanding (unconfirmed peers, or blocks deferred by the budget) the monitor arms an unref'd self-re-arming timer that calls `maybeRebalance()` — the existing `minRebalanceIntervalMs` throttle still bounds the push rate. `stop()` clears it.
- **Reaching the floor counts as satisfied.** When a block confirms on `min(floor, new-peer count)` peers, every reported peer is marked satisfied — including ones the confirm loop skipped once the floor was met — because the block is adequately replicated and re-pushing the remainder forever would be a live loop. The nothing-local-to-push case (a block observed `gained` and `grown` on the same check) is likewise marked complete.

`getGrowthDiagnostics()` exposes `{ blocksAwaitingConfirmation, abandonedPairs, recheckArmed }`; the node-base `cohort-growth:` log line carries the first two.

**Gated release (confirm-before-untrack).** A `lost` block is no longer untracked synchronously. `BlockTransferCoordinator.handleRebalanceEvent` returns `{ pulled, released, retained, replicated, underReplicated, growth }`: `released` holds only blocks it **confirmed** replicated to ≥ `floor` new owners (via `confirmReplicated`, which pushes and counts holders reporting the block *not* `missing`). The node-base handler untracks + marks GC-eligible ONLY those; a block whose push failed / was partition-skipped stays in `retained` — still tracked and served — and is retried next rebalance. This closes the release-before-confirm hole (`docs/arachnode-ring-handoff.md` § Part 2).

**Push payload.** Both `executePush` and `executeConfirm` carry the source's `state.latest` as `blockMeta` (built by the shared `sourceBlockMeta()` in `block-transfer-service.ts`, which spread-on-churn uses too), so a pushed replica lands at the source's `(rev, actionId)` rather than a fabricated rev-1. That match is load-bearing: a replica at a fabricated action id can never corroborate the source's claim in a read-repair quorum vote, so the vote would still see one claimant and decline. Both also carry the cohort's commit proof for that same revision, built together with the metadata by `sourceBlockCertification()` from ONE unpinned read — see **Certified push** below.

### RingShiftCoordinator (advertise → confirm → release)

`packages/db-p2p/src/storage/ring-shift-coordinator.ts` carries a damped `RingSelector.shouldTransition()` decision through the responsibility handoff so a ring shift never drops a key below `N`:

- **Move-out** (`R → R+1`): Phase A advertises the target ring (`status='moving'`, `moveFrom` records the old range) while still serving everything; Phase B confirms every shed block is replicated to ≥ `N` qualifying holders; Phase C sets `status='active'` at the new ring and releases the shed range (untrack + GC-eligible). Any Phase-B failure — partition, unreachable holders, floor unmet — rolls back to `active` at the old ring. No shed block is released unless *every* shed block confirmed.
- **Move-in** (`R → R-1`): Phase A only — sheds nothing, advertises the inner ring and pulls the gained half via restoration/rebalance.

**Qualifying holders** come from `arachnode-partition.ts`: a peer counts toward another mover's floor only if its *advertised (target)* partition covers the key (`qualifiesForFloor`), which excludes a concurrent same-range mover; whereas `isServingHolder` treats a `moving` peer as still covering its *old* range (fail-toward-old-holder), so a mid-handoff crash leaves the range covered. `reconcileOnStart()` refreshes a stale `moving` advertisement (crash between advertise and release) back to `active` at the old ring. Ring shifts run only when the rebalance reaction is wired (a move-out is unsafe without the confirm/release path).

### SpreadOnChurnMonitor (Middle-Out)

Proactively pushes tracked blocks to expansion targets on peer departure. Only "middle" peers (FRET `neighborDistance` rank < d) spread, bounding fan-out to 2d across the cluster. Uses `BlockTransferClient.pushBlocks()` with reason `'replication'`, carrying the source block's `state.latest` as `blockMeta` (so the replica's revision mirrors the source) and the retained commit proof for that revision.

On the receiver, `BlockTransferService.handlePush` persists each pushed block into **local** storage via `IBlockReplicaStore.saveReplicatedBlock()` → `BlockStorage.saveReplica()`, which seeds metadata, advances `latest` monotonically (never downgrades on a stale push), deletes any pending record this node still holds for the landing revision's action id (Invariant P — see [repository.md](repository.md#invariant-p--a-pending-record-and-a-committed-record-never-coexist-for-one-action)), and makes the block durably servable. The monotonic no-op path (the pushed revision is one this node already holds) writes no committed record, so it owes no Invariant-P deletion — the one thing it can still write is a back-filled commit proof, described below. A block is reported `accepted` only when it was both parseable and persisted; a parse/validation/persist failure surfaces it in `missing`. The sender only records a target as `succeeded` when the response does not list the block in `missing`, so a non-throwing round-trip that failed to persist is correctly counted as a failed push.

**Certified push.** A pushed block is content the receiver will serve — and, because `saveReplicatedBlock` advances `latest` monotonically, content it will later *corroborate* in a read-repair vote. Accepting a push on the pusher's word alone is therefore how a peer manufactures its own corroborators. So `handlePush` requires, per block, the cohort's `BlockCommitProof` for the revision the push declares:

- The wire carries `blockProofs` alongside `blockMeta` (`BlockTransferRequest`). Producers build the two together with `sourceBlockCertification()` from a single unpinned read, so a proof is never paired with metadata for a different revision. The proof itself comes from `servableProof()` — the same accessor that decides what a peer attaches to a served repair archive — which fails closed on a missing accessor, a throwing lookup, or a stored proof whose message names a different `(blockId, rev, actionId)`.
- The receiver runs one `certifyContent()` call, which covers the signer cap, the vote signatures and thresholds, the claim matching the declared `(rev, actionId)`, and the declared digest matching the pushed bytes. A failure reports the block in `missing` (the existing failure surface, which senders already handle by falling back or retrying) and logs `push:reject-uncertified` with the `ProofFailure` reason. Thresholds come from `proofThresholds(components.superMajorityThreshold)`, threaded from the node's single resolved `consensusConfig` — the same value `assertSuperMajorityCoupling` already binds the member and coordinator to.
- Decisions are strictly **per block**: in a multi-block push the verifying block is accepted beside one that is refused. `handlePull` is untouched — it serves this node's own storage.
- A block accepted on a proof **stores** that proof (`saveReplicatedBlock`'s 4th argument), so the receiver can re-prove onward what it verified instead of becoming a corroboration-only holder. This holds even when the push does **not** advance `latest`: a receiver that already holds the pushed revision back-fills the proof onto it (§ *Persistence and retention* → *Back-filling onto an already-held revision*), so a revision that landed proof-lessly — a legacy uncertified push, a corroboration-only heal — stops being corroboration-only the moment valid evidence for it arrives. The back-fill happens in `StorageRepo`, not in `saveReplica`'s monotonic guard, because it must first check the proof's declared digest against this node's *own* materialization: the proof was verified against the pushed bytes, and a diverged holder's bytes at the same `(rev, actionId)` may differ.
- **`requirePushCertificate`** (`BlockTransferServiceInit`, default `true`; set per node via the `blockTransfer` option on `createLibp2pNodeBase`) is the migration escape hatch. Pre-proof blocks can never be certified — the signatures no longer exist — so a deployment holding pre-proof data sets it `false` during migration, which restores the pre-proof acceptance path and logs `push:accept-uncertified`. The failure mode of `false` is silent acceptance of forged content. The failure mode of `true` is wider than "no new holders", because a push that a receiver refuses is a push that never *confirms*: an uncertified block stays readable while two or more holders remain, but `BlockTransferCoordinator.confirmReplicated` never counts a holder for it, so a rebalance keeps it `retained` instead of releasing it, and `RingShiftCoordinator`'s confirm phase — which requires **every** block in the shed range to reach the floor — aborts the whole shift on it (`docs/arachnode-ring-handoff.md` § Phase B). The escape hatch is therefore on the *receivers*, not on the node that cannot shed: clearing that backlog means running receivers with the flag `false` until the affected blocks have been rewritten under current code. Any block written again under current code gets a proof, so only cold, never-updated blocks stay uncertified. A push carrying a proof that *fails* verification is rejected regardless of the flag — that is not a legacy block, it is a bad one.
- **What the gate does and does not buy.** It ends acceptance on a peer's bare word: forged content now has to arrive under a self-consistent, fully-signed cohort record binding the exact bytes. It does **not** prove those signers are *this block's* cohort — the standing caller obligation stated under *Durable commit proof* above, unclosed until proof anchoring lands (`feat-cluster-membership-threshold-cert-anchoring`). Push is on exactly the same footing as the two repair paths here, no better and no worse.
- **Mixed versions.** An upgraded sender pushing to an un-upgraded receiver: the extra field is ignored and the push behaves as before. An un-upgraded sender pushing to an upgraded receiver: rejected under the strict default, diagnosable from `push:reject-uncertified ... reason=no-proof`.

**Dynamic d**: Under rapid churn (3+ departures in sliding window) or low cluster health (FRET estimate/clusterSize < threshold), `effectiveD` scales up, capped at `clusterSize / 2`.

**Partition suppression**: Skips spread when `PartitionDetector.detectPartition()` returns true.

Both monitors are initialized through `NetworkManagerService.initRebalanceMonitor()` / `initSpreadOnChurnMonitor()` and stopped together in `NetworkManagerService.stop()`.

## Observability

Transaction metrics are instrumented with `debug` logging and optional verbose tracing:

- **Timing**: Phase-level timings (`gather`, `pend`, `commit`, `total`) with `trxId` correlation
- **Correlation IDs**: `trxId` in coordinator, `actionId` in network-transactor, `messageHash` in cluster-coordinator
- **Verbose mode**: Set `OPTIMYSTIC_VERBOSE=1` for detailed batch, peer list, and FRET candidate logging
- **Enable**: `DEBUG=optimystic:*` for standard logs, combine with `OPTIMYSTIC_VERBOSE=1` for full tracing

## Common Pitfalls

### 1. Shallow Copy of Transforms
**Bug**: `copyTransforms()` spreads `updates` object but arrays inside are shared.
```typescript
// WRONG
{ updates: { ...transform.updates } }  // Arrays still shared!

// CORRECT
{ updates: Object.fromEntries(
    Object.entries(transform.updates).map(([k, v]) => [k, structuredClone(v)])
)}
```

### 2. Storage Returns References
**Bug**: In-memory storage returns stored objects directly; mutations corrupt storage.
```typescript
// WRONG
getMaterializedBlock(): return this.blocks.get(key);

// CORRECT (hand-rolled store)
getMaterializedBlock(): return structuredClone(this.blocks.get(key));
```

**Now structural for kernel-backed stores.** Every store built on the shared
`KvRawStorage` kernel (`packages/db-p2p/src/storage/kv-raw-storage.ts`) over a
`RawStoreDriver` no longer needs — and must not reintroduce — the `structuredClone`
discipline. Values cross the driver boundary as `Uint8Array` produced by `JSON`-encode
(`raw-store-codec.ts`) and consumed by `JSON`-decode, so every save stores an independent
byte snapshot and every read decodes a fresh object *by construction*. The in-memory
driver (`memory-store-driver.ts`) stores byte references directly with no cloning. The
conformance suite (`src/testing/raw-storage-conformance.ts`) asserts clone-on-store /
clone-on-read against any driver, so a backend that shortcuts the byte boundary is caught.
The clone rule above still applies only to a store that keeps live object references (none
do today). The optional write-through cache (`cached-store-driver.ts`) sits inside that byte
boundary for the same reason: it caches the encoded `Uint8Array`, never a decoded object, so
the kernel still decodes a fresh object per read and needs no cache-side cloning. The
conformance suite runs against the cached compositions too.

### 3. Independent Node Storage
**Bug**: Each node has its own storage. Consensus doesn't automatically sync data.
**Fix**: Nodes must fetch missing blocks from cluster peers via `restoreCallback`.

### 4. Check-Then-Act Race in Consensus
**Bug**: Checking `executedTransactions.has()` then setting after async work.
```typescript
// WRONG
if (executed.has(hash)) return;
await doWork();  // Another call can start here!
executed.set(hash, now);

// CORRECT
if (executed.has(hash)) return;
executed.set(hash, now);  // Set IMMEDIATELY
await doWork();
```
**Two markers, two lifetimes.** The *in-memory* guard above must be set eagerly (before
any `await`) — it is the synchronous check-and-set that closes the concurrent apply-window
race. The *durable* marker (`stateStore.markExecuted`), used only for post-restart dedup,
is the opposite: it is written **after** `doWork()` (the apply loop) succeeds. Writing it
eagerly would leave a stuck marker on a caught fault or a crash mid-apply, and on
redelivery `handleConsensus` would short-circuit at the async `wasTransactionExecuted`
check — silently dropping the transaction on that member forever. The window between
"apply succeeded" and "durable write landed" is safe to re-run on restart because
re-applying an already-applied consensus transaction is idempotent (the "ahead" divergence
path in `applyConsensusOperation` tolerates it as a no-op).

### 5. Latch Deadlocks
**Bug**: Latches are per-node, not distributed. Concurrent transactions on same block can deadlock.
**Symptom**: Test hangs indefinitely during concurrent writes.

### 6. Importing a Barrel That Re-exports You
**Bug**: A module imports, at runtime, an `index.ts` barrel sitting at or above it — the package
root barrel (`src/index.ts`) or its own subtree's (`src/log/index.ts` from `src/log/log.ts`).
Barrels here re-export their whole directory, so the module depends on a file that depends on the
module — Node evaluates the whole group as a cycle, and whichever module is entered first decides
which parts of the cycle are still half-built when the rest runs. The root barrel is the worst
case (every module under `src/` lands in one cycle); a subtree barrel is the same defect at
smaller radius. A *sibling* subtree's barrel (`src/blocks/index.js` from `src/btree/`) is fine —
it does not re-export the importer.
**Symptom**: `ReferenceError: Cannot access 'X' before initialization`, pointing at a
module-scope value in an apparently unrelated file, reproducing only under some entry orders
(classically: a spec that passes in the whole suite and dies when run standalone).
**Fix**: Import directly from the module that defines the symbol. Clause-level `import type` /
`export type` is exempt — under `verbatimModuleSyntax` it is erased whole and creates no runtime
edge. An *inline* `import { type X }` is not exempt; it still emits `import {} from '...'`.
**Enforced by**: `packages/db-core/test/barrel-import-cycle.spec.ts`.
NOTE: that guard only scans `db-core`. The other packages were swept and are clean as of this
writing; if one of them ever grows the pattern, lift the spec into a shared, per-package check
rather than copying it.

### 7. A Full Row Where a Key Tuple Belongs (Quereus vtab)
**Bug**: Three differently-addressed value lists reach the vtab's key-building code and look
identical to a reader — a **full row** (one cell per table column, read as `row[pkDef[i].index]`),
a **primary-key tuple** (one cell per PK column in key order, read as `tuple[i]` — this is what
`UpdateArgs.oldKeyValues` and a point lookup's seek args carry), and an **index-column tuple** (one
cell per index column, possibly a leading prefix). Passing one where another is expected produces a
*wrong but perfectly well-formed* tree key.
**Symptom**: no error anywhere — a composite-PK point lookup matches nothing; a same-key UPDATE is
reported as colliding with itself; a DELETE removes nothing. Only shows up when the PK columns are
not the table's leading columns in PK order, so it hides completely in the common single-column-PK
case.
**Fix**: the two tuple shapes are distinct nominal (branded) types in
`packages/quereus-plugin-optimystic/src/schema/key-tuples.ts`, obtainable only from their arity-checking
constructors (`RowCodec.asPrimaryKeyTuple`, `IndexManager.asIndexColumnTuple`). `Row` is deliberately
left unbranded — it crosses the engine boundary constantly — and is kept out of tuple parameters by
the tuples being `readonly` while `Row` is mutable. The constructors refuse an already-branded input,
so neither tuple kind can be laundered into the other through them. Arity checks alone are *not*
sufficient: when every table column is in the PK, the two shapes are the same length.
**Enforced by**: `packages/quereus-plugin-optimystic/test/key-tuple-types.spec.ts` (`@ts-expect-error`
assertions, checked by `yarn typecheck`) plus the runtime round-trips in
`test/oldkeyvalues-compact-shape.spec.ts`.

## Quereus SQL Dialect

Quereus is **not** SQLite. It is a distinct SQL engine aligned with [The Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf). The most important departure: **columns default to NOT NULL** unless explicitly marked `NULL`. Use `pragma default_column_nullability = 'nullable'` for SQL-standard behavior. Other notable differences include empty primary keys for singleton tables (`PRIMARY KEY ()`), native temporal/JSON types, all-virtual-table architecture, operation-specific CHECK constraints, and no triggers. See the [quereus-plugin-optimystic README](../packages/quereus-plugin-optimystic/README.md#quereus-sql-dialect) and the [Quereus SQL Reference](https://github.com/nicktobey/quereus/blob/main/docs/sql.md) (Section 11) for the full list.

## Type Glossary

| Type | Description |
|------|-------------|
| `Transform` | Single block mutation: `{ insert?, updates?, delete? }` |
| `Transforms` | Multi-block mutations: `{ inserts, updates, deletes }` by blockId |
| `BlockOperation` | `[entity, index, deleteCount, inserted]` - splice-style op |
| `ActionId` | Unique transaction identifier (was `TrxId`) |
| `ActionRev` | `{ actionId, rev }` - revision with its transaction |
| `messageHash` | Hash of consensus message, used for deduplication |
| `ClusterRecord` | Consensus state: peers, promises, commits, message |

## Debugging Tips

### Duplicate Entries
1. Check if storage clones on get/save
2. Check if transforms are deep-cloned before sharing
3. Check `executedTransactions` race conditions

### Missing Data Across Nodes
1. Verify `restoreCallback` is configured
2. Check if header block is shared (same blockId)
3. Verify cluster fetch mechanism in `CoordinatorRepo.get()`
4. If a write-only peer "never sees" another peer's rows: this is **by design** —
   sync is pull-on-read (see *Quereus vtab read path* above). The peer must issue a
   read to converge; the read shape is irrelevant (`count(*)` pulls like any scan).
   There is no background propagation unless cohort-topic reactivity is enabled.

### Consensus Timeouts
1. Check for latch deadlocks (concurrent access to same block)
2. Verify network connectivity between peers
3. Check `staleThreshold` (2000ms default) for cleanup timing

