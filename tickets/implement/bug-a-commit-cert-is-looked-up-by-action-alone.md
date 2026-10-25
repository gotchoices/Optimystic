description: When one write spans several collections (a table and its indexes) that are agreed in separate rounds of signatures, a node keeps only one signature set per write, so a change notification for the table can go out signed by the index's round and be refused by listeners. Keep each round's signatures under the collection it committed, so each notification carries its own.
architecture: docs/internals.md#cohort-topic-origination-bridge-networked-reactivity
files: packages/db-p2p/src/cluster/commit-cert.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cohort-topic/change-bridge.ts, packages/db-p2p/test/cohort-topic/change-bridge.spec.ts, packages/db-p2p/test/cluster-consensus-divergence.spec.ts, packages/db-p2p/test/cluster-invalidation.spec.ts, docs/internals.md
repro: static
----
# Keep a commit certificate per (action, collection tail)

## The defect

A commit certificate (`CommitCert`, the cohort's `approve` commit signatures over one consensus record) is retained in `CommitCertStore` (`packages/db-p2p/src/cluster/commit-cert.ts`) keyed by `actionId` alone, and `put` overwrites. The change bridge resolves a `CollectionChangeEvent`'s certificate with `store.get(event.actionId)` (`makeClusterCommitCertExtractor`).

A transaction writing several collections commits them under one action id. When they travel together they are one consensus record (a batch) with one certificate — no problem. When they cannot (`NetworkTransactor.commitMany` answers `undefined`, so `TransactionCoordinator.commitPhase` falls back to one request per collection, sent concurrently), each collection is its own record with its own certificate, signed by its own tail's cohort. On a member in both cohorts, `ClusterMember.applyConsensusCommits` for the two records can interleave across their awaits:

```
record T (table):  captureConsensusCommitCert → put(A, certT) → await storageRepo.commit(T) ...
record I (index):                  captureConsensusCommitCert → put(A, certI)
record T:          ... commit emits CollectionChangeEvent(collection=table, tailId=tailT)
bridge:            selfAppliedTail ✓ → get(A) → certI   ← wrong record's signatures
```

The notification for the table is then signed by the index's cohort, while a subscriber judges it against the table tail's root group (`CommitLogTrustAnchor`, docs/reactivity.md § Authentication and integrity) and refuses it; the subscriber wakes only at its watch service's next tick. In groups no larger than one cohort both records are signed by the same machines, so the wrong certificate still verifies and nothing is visible.

Repro is static (read from code). The race needs two records of one action applying concurrently on one member, which is ordinary for the per-collection fallback but not reproduced here.

## What a record's certificate is for

Origination fires only for an event whose `tailId` is among the blocks this node applied (`selfAppliedTail` in `packages/db-p2p/src/cohort-topic/change-bridge.ts`). The certificate it needs is the one from the record that committed that tail. So the right key is `(actionId, tailId)`:

- A consensus record's commit operations each carry `tailId` (`CommitRequest.tailId`, `packages/db-core/src/network/struct.ts`). The tails a record **commits** are `commits.filter(c => c.blockIds.includes(c.tailId)).map(c => c.tailId)` — the same test `selfAppliedTail` applies to the resulting event. A batch record yields one tail per collection, all under the one certificate; a single-collection record yields one.
- A record that commits no tail — the sweep of a tail-then-sweep commit (`commitTailThenSweep` in `packages/db-core/src/transactor/network-transactor.ts`), landing a collection's non-tail blocks on another cohort — yields none. Its events can never originate, so the store keeps nothing for it. (Today that record's `put` also overwrites the tail record's certificate under the same action id.)

### Invalidations

`ClusterMember`'s consensus invalidation path captures a certificate under `invalidationActionId(invalidatedActionId, disputeId)` (`inv:…`), which is unique to one reversal of one collection (`InvalidateRequest.collectionId`), so it has no cross-collection ambiguity. But `InvalidateRequest` carries no tail id, and the capture runs before the invalidation is applied, so there is no tail to key it under. Nothing emits an invalidation change event on a live node yet (the dispute subsystem is dormant — see the `[dispute-subsystem-dormant]` comments in `packages/db-p2p/src/libp2p-node-base.ts`), and the only fixture event (`packages/db-p2p/test/cohort-topic/invalidation-notification.spec.ts`) carries no `tailId`, so it would not pass `selfAppliedTail` anyway. Recommended: store an invalidation's certificate **action-wide** (no tail), and have `get(actionId, tailId)` fall back to the action-wide entry only when no per-tail entry exists. Commit records never write action-wide entries, so the fallback cannot hand a commit event another collection's certificate. Record at the invalidation capture site, as a `NOTE:`, that an invalidation event will need a `tailId` to originate at all once the subsystem is wired.

## Interface changes

`CommitCertificateSink` (`packages/db-p2p/src/cluster/cluster-repo.ts`) is also the public node option `NodeOptions.onCommitCertificate` (`packages/db-p2p/src/libp2p-node-base.ts`). Add the tails as a third argument, so existing two-argument sinks keep working:

```ts
/** `tailIds`: the collection tails this record committed, each of which this certificate signs for.
 *  Empty for a record that committed no tail (a sweep). `undefined` for an action-wide certificate
 *  (an invalidation, which names one collection by construction but no tail). */
export type CommitCertificateSink = (actionId: ActionId, cert: CommitCert, tailIds: readonly BlockId[] | undefined) => void;
```

The sink still fires once per record that reaches `minSigs` (an external sink may want every certificate, the sweep's included). `CommitCertStore`:

```ts
put(actionId: ActionId, cert: CommitCert, tailIds: readonly BlockId[] | undefined, now?: number): void;
get(actionId: ActionId, tailId: BlockId | undefined, now?: number): CommitCert | undefined;
```

- `put` with an array writes one entry per tail (an empty array writes nothing); with `undefined` writes the action-wide entry.
- `get` returns the `(actionId, tailId)` entry if retained, else the action-wide entry for `actionId`, else `undefined`.
- TTL and the entry cap (`DEFAULT_COMMIT_CERT_TTL_MS`, `DEFAULT_COMMIT_CERT_MAX_ENTRIES`) count per entry, as now. A simple encoding is one Map keyed by a composite string; an action id or block id cannot contain a separator you choose only if you pick one that base64url and the `inv:` form never produce (e.g. `\u0000`), or use a nested `Map<ActionId, Map<BlockId | undefined, …>>` and count entries yourself. Pick whichever keeps eviction simplest.

`makeClusterCommitCertExtractor` reads `store.get(event.actionId, event.tailId)` and adds the tail to its "no commit cert retained" log line.

`captureCommitCert` / `captureConsensusCommitCert` take the tails from the record's commit operations (`applyConsensusCommits` already has `commits`); the invalidation path passes `undefined`. The composed sink in `createLibp2pNodeBase` forwards the third argument to both `certStore.put` and the caller's sink.

## Tests

One new test, the reproduction, at the store/extractor layer in `packages/db-p2p/test/cohort-topic/change-bridge.spec.ts`: put certT under `(A, [tailT])`, then certI under `(A, [tailI])`; an event for `(A, tailT)` resolves certT and one for `(A, tailI)` resolves certI (today the first resolves certI). Fold into the same test, or the existing round-trip test, that a sweep put (`[]`) retains nothing and that an action-wide put is found by a `get` naming any tail of that action but does not shadow a per-tail entry. Update the existing store/extractor/end-to-end cases and the two `onCommitCertificate` specs (`cluster-consensus-divergence.spec.ts` "fires onCommitCertificate…", which can assert the record's tail arrives as the third argument; `cluster-invalidation.spec.ts`, which can assert `undefined`) to the new signatures — no further new tests.

## Docs

- `docs/internals.md` § Change Notification: the "catch-all feed is never held" bullet cites this defect as one reason not to hold the catch-all feed. Reword it: the certificate is now resolved per collection tail, so that reason is gone; the remaining reasons (tail-rotation detection and the owned-block feed want no delay) stand. Do **not** start holding the catch-all feed here — that is the subject of backlog `feat-a-network-watch-wake-sees-the-whole-commit`; its arm that says it "needs `bug-a-commit-cert-is-looked-up-by-action-alone` first" should say, in one line, that this has landed.
- `docs/internals.md` § Cohort-Topic Origination Bridge: update the diagram lines (`onCommitCertificate(actionId, cert, tailIds)`, `CommitCertStore.get(actionId, tailId)`) and the bullet that says the cert store is keyed by action.
- Keep `yarn lint:docs` green.

## TODO

- Change `CommitCertStore` (`put`/`get` signatures, per-tail and action-wide entries, TTL/cap per entry) and `makeClusterCommitCertExtractor` in `packages/db-p2p/src/cluster/commit-cert.ts`; update the store's doc comment.
- Add `tailIds` to `CommitCertificateSink`; derive the committed tails in `applyConsensusCommits` → `captureConsensusCommitCert` → `captureCommitCert`; pass `undefined` from the invalidation capture, with the `NOTE:` about an invalidation event needing a `tailId` to originate.
- Forward the third argument in the composed sink in `createLibp2pNodeBase`; update the `onCommitCertificate` option's doc comment.
- Check `packages/db-p2p/src/testing/reactivity-mesh-harness.ts` and any other `put`/`get`/sink caller (`grep -rn "onCommitCertificate\|certStore\|CommitCertStore" packages`) compiles against the new signatures.
- Add the reproduction test and update the existing specs listed above.
- Update `docs/internals.md` and the backlog ticket line as described, and the doc comment in `packages/db-p2p/src/storage/storage-repo.ts` that cites this ticket as a reason the catch-all feed is not held (same rewording as internals.md).
- `yarn workspace @optimystic/db-p2p build`, its tests (`yarn test` in `packages/db-p2p`), and `yarn lint:docs`.
