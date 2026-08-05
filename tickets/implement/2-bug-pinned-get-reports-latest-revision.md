description: When a node asks storage for an older version of some data, storage hands back the older content but labels it with the newest version number. Anything relying on that label — notably the check that catches a transaction built on out-of-date data — is being told the data is fresher than it is.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/transform/cache-source.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
repro: verified
----

# A revision-pinned `get` returns pinned content stamped with the node's newest revision

## What happens (verified at the storage layer)

`StorageRepo.get` honours the caller's `context.rev` when materialising content —
`blockStorage.getBlock(context?.rev)` returns
`{ block, actionRev }` where `actionRev` **is** the revision the content was
materialised at (`packages/db-p2p/src/storage/block-storage.ts:60-62`). But the
result it returns discards `actionRev` and reports the node's newest committed
revision instead (`packages/db-p2p/src/storage/storage-repo.ts:316-322`):

```ts
return [blockId, {
    block: blockRev.block,                      // materialised at context.rev
    state: {
        latest: await blockStorage.getLatest(), // the node's NEWEST rev — not the above
        pendings
    }
}];
```

Observed directly (probe: commit `block-1` at rev 1 with `items: ['v1']`, commit
rev 2 adding `'v2'`, then `repo.get({ blockIds: ['block-1'], context: { rev: 1, committed: [] } })`):

```
latest   -> items: ["v1","v2"], state.latest: { actionId: "a2", rev: 2 }
pinned@1 -> items: ["v1"],      state.latest: { actionId: "a2", rev: 2 }
```

Content is correctly pinned to revision 1; the revision reported alongside it is 2.

## Why the label matters

`TransactorSource.tryGet` reads exactly that field to decide what revision a read
observed (`packages/db-core/src/transactor/transactor-source.ts:63-65`):

```ts
const rev = state.latest?.rev ?? 0;
this.collector.record(id, rev, purpose);
this.readRevisions.set(id, rev);
```

Two consumers are misled:

- **Read dependencies.** `ReadDependencyCollector` now holds "observed block X at
  revision 2" for content that is revision 1. The validator's stale-read check
  compares the recorded revision against the block's actual revision; they match,
  so the check passes. A transaction can therefore commit having been validated
  against a revision whose content it never actually read.
- **`CacheSource.revisions`.** The miss-load path learns the same number via
  `getReadRevision`, so the cache stamps pinned content with the newer revision.
  Every later cache HIT re-emits that wrong revision into the collector. This also
  feeds `Collection.createReadTracker`'s `revision <= pinRev` seed filter, though
  that direction is merely over-conservative (a mis-stamped entry is dropped from
  the seed and refetched) rather than wrong.

**Honesty about scope:** the mis-stamping itself is *verified* (above). The
end-to-end consequence — a transaction actually committing on unread data — is
**inferred from reading the validator and collector, not observed**. What would
confirm it: an end-to-end test where a collection whose `actionContext.rev` lags
storage reads a block a peer has since advanced, then commits, and the commit is
wrongly accepted. Note that `tickets/backlog/debt-e2e-stale-cache-hit-read-rejected`
proposes almost exactly that harness for a different reason; whoever builds it
should cover this case too.

## Reachability

Any read where the caller's `actionContext.rev` is behind the storage node's
latest AND the block changed in between. That is the ordinary lagging-reader case
in a multi-writer setup, not a dormant path. It is also precisely the situation
`Collection.createReadTracker` constructs on purpose — it builds a `TransactorSource`
with a deliberately pinned `actionContext`. That view passes `recordReads: false`
by default, so the pinned committed-read path does not currently feed the collector;
the exposure today is the ordinary main-path read, and `recordReads: true` would
widen it.

Independent of `bug-external-commit-invisible-after-staged-txn`: different
package, different site, no shared code. Fixing that one does not fix this one
(cache clearing is driven by log entries, never by revision comparison).

## Design note for whoever implements

The information is already available — `getBlock` returns `actionRev`, it is just
thrown away. The straightforward fix is to carry the materialised revision on the
result and have `TransactorSource` prefer it over `state.latest.rev` when present,
falling back to today's behaviour when absent so repos that do not report it keep
working. `state.latest` should keep meaning "the newest revision this node holds" —
callers do rely on that (`StorageRepo.get`'s own promotion pre-scan compares
`context.committed` against it), so do not redefine it in place.

The reach is cross-package: `GetBlockResult` is produced by `StorageRepo`,
`CoordinatorRepo`, `ClusterRepo`, the network transactor, and several test
doubles. Adding an optional field keeps all of them compiling; only the repos that
actually pin need to populate it. A local alternative — clamping the recorded
revision to `min(state.latest.rev, actionContext.rev)` inside `TransactorSource` —
needs no schema change and errs safe (it under-reports, causing spurious
rejections rather than wrong acceptances), but it is a guess rather than the truth
and would produce false aborts whenever no commit landed between the pin and
latest. Prefer reporting the real value; fall back to the clamp only if the
interface change proves genuinely disruptive, and say so in the handoff.

Two adjacent board tickets touch neighbouring lines but not this defect — check
them before editing so the changes compose:
`tickets/backlog/feat-phantom-read-protection` (same file
`transactor-source.ts`, but about ABSENT blocks recording no dependency — this
ticket is about the revision recorded for a PRESENT one) and
`tickets/backlog/bug-orphaned-pending-after-divergent-commit` (same file
`storage-repo.ts`, but the commit/promotion path, not `get`).

## TODO

- Add an optional materialised-revision field to the per-block get result type
  (alongside `state`), documented as "the revision the returned content was
  actually materialised at", and populate it in `StorageRepo.get` from
  `blockRev.actionRev`. Leave `state.latest` semantics untouched.
- Populate the same field in the other `GetBlockResult` producers where the
  materialised revision is known (`CoordinatorRepo`, `ClusterRepo`, network
  transactor); leave it absent where it genuinely is not known rather than
  guessing.
- In `TransactorSource.tryGet`, record and store the materialised revision when
  the result carries one, falling back to `state.latest?.rev ?? 0` otherwise.
  Both `collector.record` and `readRevisions.set` must use the same value —
  `CacheSource` learns from `getReadRevision`, so a split would stamp the cache
  differently from the collector.
- Add a `packages/db-p2p/test/storage-repo.spec.ts` case asserting the probe shape
  above: commit two revisions of a block, `get` at `context.rev = 1`, assert the
  content is revision 1's AND the reported materialised revision is 1 (while
  `state.latest.rev` remains 2).
- Add a `packages/db-core` test that a pinned read records a read dependency at
  the pinned revision, not at the transactor's latest.
- Run `yarn test` in `packages/db-p2p` and `packages/db-core`. Also run
  `packages/quereus-plugin-optimystic`'s suite, since it exercises the same read
  path end-to-end through `StorageRepo`.
