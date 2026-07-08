description: A block used to keep a full copy of itself at every saved version, so disk grew forever; now it keeps full copies only at periodic checkpoints (plus the newest and oldest it holds) and rebuilds the in-between versions on demand from small change-logs.
prereq:
files: packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/test/block-storage.spec.ts, docs/repository.md, docs/architecture.md
difficulty: hard
----

# Complete: materialization checkpoint sweep

## What shipped

Block storage stops keeping a full materialized copy at every revision. It retains a full copy only at
**retained** revisions — the tip, each contiguous range floor, and every `CHECKPOINT_INTERVAL`th rev
(default 32) — and prunes the redundant intermediate copies incrementally as commits land. Every forward
transform is kept for every revision, so any held revision is reconstructed by replaying transforms from the
nearest retained copy at or below it. Storage growth drops from O(revisions × block size) to
O(revisions × delta size). `meta.ranges` is unchanged by sweeping (no transform is dropped, so every claimed
rev stays reconstructible).

Implementation summary (see the implement commit `e36bd62` for the full design writeup):
- `BlockStorage.isRetainedRev` — the tip / floor / checkpoint predicate; floor is a separate mandatory clause.
- `BlockStorage.pruneSupersededMaterialization` (new `IBlockStorage` method) — deletes the prior latest's
  materialization unless it is retained; no-op on a tombstone rev.
- `StorageRepo.internalCommit` calls it last, after `setLatest`, under the per-block commit latch.
- `materializeBlock`'s read-path re-cache is gated on `isRetainedRev` so cold historical reads don't regrow
  storage.
- Optional `checkpointInterval` constructor arg (default 32) so tests inject a small cadence.

## Review findings

Reviewed the implement diff with fresh eyes before the handoff, then re-derived the retention/reconstruction
argument from the source. Aspects scrutinized: retention-predicate correctness (incl. multi-range floor),
descending-walk reconstructibility post-sweep, the read-path re-cache gate, crash-window leak bounds,
`recover()` interaction, the replica/deletion write path, delete-routing idempotency across drivers, docs
accuracy, and lint/tests.

### Fixed in this pass (minor)

- **Stale-metadata re-cache bug in `materializeBlock` (correctness/efficiency regression).** `getBlock`
  captures `meta` *before* `ensureRevision`, which may restore the target's range during the same read.
  The new re-cache gate read `meta.ranges` from that pre-restore snapshot, so on a restore-then-replay read
  `rangeFloorOf` fell into its fallback (treating the target rev as its own floor ⇒ wrongly "retained") and
  re-cached a materialization the sweep is designed to prune. This regrows storage via reads of restored
  ranges — and post-this-ticket a swept peer serves exactly the floor+transforms archive shape that makes
  intermediate revs replay, so it is reachable in production, not just theory. It over-caches (safe
  direction — never breaks reconstructibility), but it silently undercuts the sweep's stated "reads don't
  regrow storage" guarantee. **Fix:** the gate now reads metadata *fresh* (`storage.getMetadata`) so the
  just-restored range is visible; falls back to the passed snapshot only if the fresh read is absent.
  **Test:** added `restore-then-replay read does NOT re-cache a swept rev` — verified it *fails* against the
  pre-fix source (asserts the swept rev's materialization stays absent) and passes after. This also makes
  `rangeFloorOf`'s documented-unreachable fallback genuinely unreachable again for reads.

- **`docs/architecture.md` storage-model bullet was stale.** It claimed "old revisions and materializations
  are swept opportunistically" — but transforms (revisions) are now retained forever; only materializations
  are pruned, incrementally at commit, to checkpoints. Rewrote the bullet to the checkpoint-materialization
  model and cross-linked `repository.md`. (`docs/repository.md` was already updated by the implementer.)

### Tripwires (recorded, not filed as tickets)

- **Crash-before-prune leaks ≤1 block copy per crash event.** A crash between `setLatest` and the prune
  leaves the prior materialization un-pruned; later commits prune only their *own* prior, so that one copy is
  never auto-reclaimed. Harmless (state stays consistent + every rev reconstructible) and bounded. **Decision:
  accept.** It is self-limiting (per-crash, not per-commit), and the cumulative cost is (crashes × block size)
  — negligible. Already recorded as a `NOTE:` at the prune call site (`storage-repo.ts`) with the remedy
  (bounded look-back window or periodic reconciliation) if it ever accumulates materially. Test 6 asserts the
  real guarantee (reconstructibility + prune resumes). No `debt-` ticket — filing one for a ≤1-copy harmless
  leak would be queue noise.
- **Cold non-checkpoint historical reads re-replay up to `checkpointInterval` transforms.** Already a `NOTE:`
  at the re-cache site with the escalation path (cache at nearest checkpoint below target). Fine while
  historical reads are rare.
- **`checkpointInterval` is per-instance, not persisted.** Divergent intervals over one raw store would
  retain/prune to different cadences. Not reachable in production — every factory (`libp2p-node-base.ts`,
  `quereus-plugin-optimystic/collection-factory.ts`) constructs with the default 32. Only a test-shaped
  concern; the sweep tests deliberately never mix intervals on one store.

### Investigated, no defect

- **Replica/deletion write path (`saveForwardRevision`) never prunes.** Correct by design, not a gap: each
  replica/deletion revision is a single-point range (`[rev, rev+1)`), so it is its own floor and would be
  retained anyway; and replica transforms are full-block inserts (`{ insert: block }`), so there are no delta
  savings to reclaim. Pruning that path would be a pointless no-op. Cold-range transform offload is separately
  tracked in `backlog/feat-cold-range-transform-offload`.
- **Multi-range floor computation.** Traced `rangeFloorOf(meta.latest.rev, [[2,3],[10]])` = 10; prune's
  `prior` is always the immediate prior tip in the latest's range, so it never targets a rev below that
  range's floor and never deletes a floor (floor clause). Test 4 covers a non-checkpoint upper floor (rev 10).
- **`getBlock(r)` post-sweep never throws "Failed to find materialized block" for a held `r`.** The floor is
  always retained and floor ≤ r, so the descending walk always finds a base. Test 1 asserts a correct
  non-throwing read at every rev 1..9 (content `items.length === r-1`).
- **`recover()` interaction.** recover advances `latest` across a crashed-commit's promoted rev without
  pruning; the newly-interior old tip is exactly the bounded crash leak above. At most one rev sits in the
  promoted-but-not-latest gap (commits are one-rev-at-a-time under the latch), so the ≤1 bound holds.
- **Delete routing.** `saveMaterializedBlock(actionId, undefined)` → driver `deleteMaterialized`, idempotent
  on an absent key (verified `memory-store-driver`, `kv-raw-storage` put-or-delete branch). No-op on a
  tombstone rev confirmed by test 3.

### Major findings

None. No new `fix/`, `plan/`, or `backlog/` tickets filed — the one reachable defect was minor and fixed
inline, and the residual concerns are genuinely conditional (recorded as tripwires above).

## Validation

- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/db-p2p test` — **1305 passing, 36 pending, 0 failing** (1304 prior + 1 new
  regression test).
- `eslint` on the changed source + test files — clean.
- The new regression test was verified to *fail* against the pre-fix source, confirming it guards the bug.
