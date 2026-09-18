description: When a storage node accepts a pending change to a block, the change now arrives with, and is stored with, the version of the block it was written against, so every later step that applies the change can refuse to apply it to a different version, including the steps that have no commit message to consult.
prereq: a-staged-edit-keeps-the-version-it-was-computed-against
files: packages/db-core/src/network/struct.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/pending-claim.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-core/test/commit-digest-threading.spec.ts, docs/internals.md, docs/repository.md, packages/db-p2p/docs/storage.md, docs/correctness.md
difficulty: hard
repro: static
severity: corruption
likelihood: unusual
----

# A pend carries, and storage keeps, the version each block's change was computed against

Second of three tickets split from the plan ticket of the same slug. The first (`a-staged-edit-keeps-the-version-it-was-computed-against`) made the writer's declared base trustworthy without touching any format. This ticket is the **representation change**: it changes what a pend puts on the wire and what block storage keeps for a pending record. The third (`a-rival-pend-is-superseded-only-by-a-writer-that-built-on-it`) uses the new field in the rival-pend rule.

## The defect, in one sentence

A change to a block is a list of edits that only make sense against one version of the block, and the node applying the change stores the edits without that version, so wherever the sender did not volunteer the version separately (on the optional per-block commit declaration, `CommitRequest.blockDigests[id].baseRev`) the node applies the edits to whatever version it happens to hold and records the result under the new number, forking the block silently.

Two apply sites are unguarded today, both in `StorageRepo` (`packages/db-p2p/src/storage/storage-repo.ts`):

- **Arm one, a commit that declares nothing for the block.** `internalCommit` abstains when `blockDigests[id].baseRev` is absent (its guard's own comment says so): an author that could not describe the block from memory, a deletion, or a sender running older code.
- **Arm two, the read-driven promotion in `get`.** When a reader's context proves an action committed elsewhere, the node finishes applying any pending record it holds for it. There is no commit message, so nothing to check, and the loop walks the context's committed list in revision order **skipping** entries whose record it does not hold, so a node that missed one change to a block applies the next one straight over the stale copy. The `NOTE:` at that loop says exactly this.

Neither can be closed from local information: revisions are allocated per collection, so "my version is one below the committing one" is false for ordinary correct writes (the retired decision `st-commit-contiguity-guard-premise`), and "I hold no record for that entry" is the normal case for every action that never touched this block. The version has to travel with the change.

## The design, settled

### Wire: `PendRequest.baseRevs`

Add to `PendRequest` in `packages/db-core/src/network/struct.ts`:

```ts
/** Per block, the committed revision of the base the author's update operations were computed
 *  against. Present for a block whose transform is update-only and whose base the author knows;
 *  never for an inserted or deleted block (base-independent), and absent for a block the author
 *  did not read through a source that reports revisions. Omitted entirely when empty. */
baseRevs?: Record<BlockId, number>;
```

- **Producer.** `Tracker.stagedBaseRevs(blockIds)` from the first ticket, at both pend producers: `Collection.syncAttempts` passes it to `TransactorSource.transact`, which puts it on the pend; `TransactionCoordinator.pendCollection` reads it from `collection.tracker` the way the commit side reads digests from the same tracker. Wrap with a helper like `blockDigestsField` (suggested `baseRevsField`) so an empty map omits the key: the request is hashed verbatim into every cohort signature preimage, and a pend that declares nothing must serialize exactly as before.
- **Per-batch narrowing.** `NetworkTransactor.pend` splits one action's transforms across coordinators and sends `{ ...blockAction, transforms: batch.payload }`. Narrow `baseRevs` to the batch's own ids at send time, exactly as `digestsFor` narrows commit digests, so a retry re-split onto other coordinators still gets its own subset and no cohort signs for a block it is not responsible for.
- **Compatibility on the wire.** Messages are JSON; a receiver built before the field ignores it and still hashes the bytes it received, the same argument `blockDigests` rests on (pinned by the "mixed-version hash guarantee" tests in `commit-digest-threading.spec.ts`; add the pend counterpart). The operations hash (`collectOperations`) enumerates inserts, updates and deletes only, so a validated multi-collection pend's `operationsHash` is unaffected.

### Storage: `BlockMetadata.pendingBases`

Add to `BlockMetadata` in `packages/db-p2p/src/storage/struct.ts` a sibling of `pendingRevs`:

```ts
/** The committed revision each pending record's update operations were computed against, keyed
 *  by the record's action id — the pend's `baseRevs[blockId]`. Absent for a record whose pend
 *  carried no base for this block (inserted, deleted, or unknown to the author) and for records
 *  written before the field existed. Kept beside `pendingRevs`, and for the same reason: the raw
 *  drivers move a pending record into the committed store byte-for-byte on promotion, so the
 *  record's value has to stay a plain transform. */
pendingBases?: Record<ActionId, number>;
```

A **sibling map rather than a change to `pendingRevs`' shape**, deliberately: metadata written by the release shipping the morning after this plan must stay readable without a migration, and a record with no base entry simply reads as base-unknown. Written, dropped and swept in the same metadata writes as the claim (`BlockStorage.recordClaim` grows to carry both; `deletePendingTransaction`, `sweepDeadClaims`, `setLatest`'s drop of the promoted action, `recover`, `saveReplica` and `saveDeletion`'s same-action delete). `IBlockStorage.savePendingTransaction` gains a `baseRev: number | undefined` parameter before the latch; `PendingClaim` gains `baseRev?: number`; `listPendingClaims` joins it. `internalCommit` and the promotion loop need the claim of **one** action: add a single-action reader (suggested `IBlockStorage.pendingClaimOf(actionId)`) rather than listing every record on the hot commit path.

`StorageRepo.pend` stores the base **as told**, validated only as `typeof === 'number'` (untrusted wire data with no ingress schema, the same posture `validateCommitOperations` takes toward `blockDigests`; a malformed or surplus entry is ignored per id, never thrown on). A member has no grounds to second-guess the author's claim about the author's own computation; the first ticket is what makes an honest author's claim correct. In particular the pend does **not** refuse when the declared base is *ahead of or behind* this member's latest: a member holding a torn or abandoned higher revision would otherwise cast a reject that, at three members, fails every honest retry (the writer re-reads the majority's revision and declares it again), whereas the same mismatch at commit time is one member's refusal, heals by reconcile, and the cohort still commits on majority durability. Record that reasoning as a `NOTE:` at the pend site.

### Apply sites

**`internalCommit`** (arm one). Let `stored` be the pending claim's `baseRev`, `declared` the commit's `blockDigests[id].baseRev` (still typed `unknown`, validated as today). For an update-only transform (`!transform.insert`, and treat a delete-only transform as base-independent too, matching what the producer never declares for it):

1. Both numbers and unequal → refuse through `refuseMissingBase` with a distinct detail (`stored base X disagrees with declared base Y`) and its own log line. An honest writer after the first ticket never does this; the shape it closes is a member holding a **stale pending record from an earlier attempt** of a retried action (its retry's pend never reached this member) that receives the retry's commit: the old record's operations were computed against a different base, and the old guard would apply them wherever the member's latest happened to equal the new declaration.
2. `effective = stored ?? declared`; a number, and `latest?.rev !== effective` → refuse exactly as today.
3. Neither → apply as today, logging `commit:base-undeclared` so the residual is countable.

**Read-driven promotion in `get`** (arm two). For each context entry whose pending record this node holds, before calling `internalCommit`: an insert-carrying or delete-only record is base-independent and promotes; otherwise promote only when the stored base is a number equal to `latest?.rev`. Anything else **declines**: leave the record and `latest` untouched, stop walking further entries for this block (each later one builds on this one), log `get:promote-declined` with the block, action, stored base and local latest, and do **not** set `unavailable` (the content served is real committed content, merely behind, and the reader's floors and the coordinator's read-repair are the mechanisms for "behind"). A declined record is not dead: this node's latest reaches the stored base only through a replica or reconcile, and when that lands `sweepDeadClaims` removes the record if its slot is passed, or a later context read promotes it if not. Declining is deliberately distinct from `refuseMissingBase` (which deletes the record because it can never be promoted here): keep the existing `MissingBaseRevisionError` catch for the no-base-at-all case.

### The compatibility answer for a pend that supplies no base

Settled here, not left to the implementer. A pend carrying no base for an update-only block is **accepted and stored without one**. At commit, the guard falls back to the commit's own declaration and then abstains, so senders running older code (or a drift-blind source, as in test doubles) keep committing exactly as today. At read-driven promotion such a record is **declined**, per the maintainer's guidance that the promotion should decline a record whose base it cannot establish and let block repair supply the version. The cost falls only on base-less senders: their held-but-missed records no longer come current on a read, only through the next commit's reconcile or the coordinator's read-repair. The alternative, refusing a base-less pend outright, was rejected because it turns every such writer's write into a hard failure on a release that may run mixed versions for a while. Arm one therefore stays open for base-less senders alone, by choice, and the docs must say so in those words rather than "not covered".

One consequence to state in the handoff: the existing `storage-repo.spec.ts` promotion tests that pend with bare transforms ("context-driven pending block serving (TEST-5.4.3)", "read-driven promotion under the write latch", the change-event tests that promote through `get`) must now pend with a `baseRevs` entry to keep promoting. That churn is the new contract being pinned, not collateral.

## Edge cases & interactions

- **Per-batch narrowing and retry re-splitting**: narrow at send time, never once up front; a batch whose blocks all lack a base omits the field.
- **Torn-action retry with the same action id**: `satisfied` blocks skip the save, so their base is not rewritten; re-pended blocks get the retry's base. A redelivered pend for the same action overwrites record, claim and base together.
- **`PendRevisionTakenError`**: nothing written, base included.
- **Crash between the metadata write and the record write**: an inert base entry beside an inert claim; every reader joins against the pending namespace, so it is harmless and is dropped with the claim.
- **Latching**: the base is written under the same block latch as the record; `pendingClaimOf` is read-only and takes none.
- **Idempotent commit redelivery** of a revision already landed: partitioned as already-done before the guard runs (existing test); unchanged.
- **Crash-D3 recovery** (`recover`): drops the promoted action's claim; drop its base too.
- **Hostile or malformed `baseRevs`**: a non-number or an id the transforms do not touch is ignored for that id; a junk numeric base can force refusals and reconcile churn (as a junk `blockDigests.baseRev` can today) but never a fork.
- **Promotion decline vs. the pending overlay read** (`context.actionId`): the record is still there after a decline, so the overlay read still applies it; the `unavailable`-flag reasoning in that branch must be re-read against the new decline path (a decline sets no flag).
- **Promotion decline vs. `readBlockHealing`**: the promotion runs before the healing read; a decline does not touch `latest`, so the coverage argument in `readCommitBase`'s second NOTE is unchanged.
- **Vote-time digest check** (`previewCommitDigest`, `validateCommitDigests`): unchanged here; the third ticket adds the stored-versus-declared disagreement as a signed reject.
- **The local transactor in the Quereus plugin** passes the request straight to `StorageRepo.pend`, so it carries the base with no plugin change; confirm with the plugin suite.
- **Every `NOTE:` and doc paragraph that names `backlog/bug-a-pended-transform-does-not-carry-its-base`** (grep the string across `packages/` and `docs/`) is rewritten by this ticket where it describes arms one and two, and left for the third ticket where it describes the rival check (`pending-claim.ts`, `race-resolution.ts`, `validatePendOperations`, Theorem 1 Case 2, Theorem 9). Point the remaining ones at the third ticket's slug.

## Key tests

- `block-storage.spec.ts`: the base is recorded with the claim in one metadata write and dropped with it on delete, sweep, promotion and same-action replica; `listPendingClaims` and `pendingClaimOf` join it; metadata written without the field reads as base-unknown.
- `storage-repo.spec.ts`, the "commit — declared base revision (fork guard)" suite extended with pends that carry `baseRevs`: a commit that declares **nothing** is refused on the gapped member and lands on the healthy one (arm one closed); stored and declared bases that disagree are refused with the distinct detail; neither present applies (the residual, named as accepted); an insert-carrying record commits regardless.
- `storage-repo.spec.ts`, promotion: the plan ticket's scenario. Seed a block at revision 1 on two members; member A takes revision 2 (base 1); member B misses it; both hold the pend for revision 3 (base 2); a read on B with a context naming revisions 2 and 3 declines (latest stays 1, content unchanged, record still present, no `unavailable`); the same read on A promotes to 3. Then land revision 2 on B through `saveReplicatedBlock` and repeat the read: B promotes to 3 and the two members' content hashes agree. Also: a base-less record is declined; an insert-carrying record is promoted regardless of base; a decline on the first missing entry stops the walk for that block.
- `commit-digest-threading.spec.ts`, pend counterpart: `NetworkTransactor.pend` gives each peer only its batch's bases, omits the field on an all-undeclared batch and when nothing is declared, and subsets at send time on retry; `Collection.sync` sends a base for every update-only block and never for an inserted or deleted one; a pend message hashes identically after a JSON round-trip by an unaware peer, and the field is folded into the hash rather than ignored.
- Coordinator: `pendCollection` carries the bases of the collection's tracker (mirror the "Collection.sync declares its blocks" shape).
- Negative controls for the review: with the stored-base comparison neutered, exactly the arm-one and promotion tests fail.

## TODO

- Wire: `PendRequest.baseRevs` and its field helper in db-core; producers in `TransactorSource.transact` and `TransactionCoordinator.pendCollection`; send-time narrowing in `NetworkTransactor.pend`.
- Storage: `BlockMetadata.pendingBases`; `IBlockStorage.savePendingTransaction` signature, `PendingClaim.baseRev`, `listPendingClaims`, new `pendingClaimOf`; `BlockStorage` writes, drops and sweeps the base with the claim on every path listed above; update `docs/repository.md` "A pending record claims a slot" and `packages/db-p2p/docs/storage.md` "Block Metadata".
- `StorageRepo.pend`: store the validated base per block; add the `NOTE:` on why the pend never refuses on a base mismatch.
- `StorageRepo.internalCommit`: the three-step rule above; rewrite the guard's forty-line comment so it describes the stored base as primary and the declaration as fallback, and drops the "two arms not covered" paragraph in favour of the residual as accepted for base-less senders.
- `StorageRepo.get`: the decline rule in the promotion loop; replace the loop's `NOTE:`; log line.
- Tests as listed; run `yarn workspace @optimystic/db-core test`, `yarn workspace @optimystic/db-p2p test` and the plugin suite in the foreground, plus `yarn typecheck` and `yarn lint:docs`.
- Docs: `docs/internals.md` "An update-only transform is applied only to the base its author read" (the base now travels with the pend; arms one and two closed; base-less residual stated as accepted); `docs/repository.md` "Declared block content" (what `baseRev` on the commit still does, and that the pend's base is now primary); `docs/correctness.md` §2 and Theorem 14's "A declaration buys one more thing" paragraph; `packages/db-p2p/docs/storage.md` invariant 3.
- Handoff: list every remaining `NOTE:` that still points at the old backlog slug and confirm each now names the third ticket.
