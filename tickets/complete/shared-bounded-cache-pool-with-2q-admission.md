description: The per-workspace memory caches now share one process-wide pool with a byte budget and an admission rule that keeps frequently used records from being flushed by one-off bulk reads. Reviewed, three defects fixed, and the pool source made reviewable again after it had been committed as a binary file.
files: packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/test/shared-cache-pool.spec.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p/test/support/cache-test-helpers.ts
----

# Shared bounded cache pool with 2Q admission

## What shipped

`SharedCachePool` (`src/storage/shared-cache-pool.ts`): one bounded, clean-value cache pool
per process, joined by default by every `CachedStoreDriver`, so N workspaces' caches compete
inside ONE memory budget instead of each sizing itself as if it were alone.

- Keyed `(storeId, class, blockId, actionId?)`. The store id leads because header block ids
  are derived from collection names and therefore collide across stores.
- Two budget rails: bytes (`maxBytes`) and entry count (`maxEntries`). Every entry charges a
  fixed base on top of its content, so cached negatives and empty containers are never free.
- 2Q admission: first touch goes to the A1in probation FIFO, re-hits there do not promote,
  A1in eviction leaves a ghost key, and a later admission of a ghosted key goes straight to
  the protected Am LRU. One-pass bulk scans live and die in probation.
- Large-value bypass at 1/16 of the byte budget; always evicts, never refuses; `stats()`
  observability; live `setBudget`; platform-default budgets (8 MB React Native, 16 MB
  browser, 32 MB Node) behind a lazy `defaultCachePool()`.

`CachedStoreDriver` was rewritten so every cached value lives on a pool entry the pool's
queues link directly — residency and accounting became the pool's problem while all coherence
semantics from the prereq (write-through, proven-absence negatives, completeness flags stored
inside the entry they describe, generation guards, promote invalidate-never-synthesize) stayed
in the driver. `CachedRawStorage` gained optional `pool`/`label` args and a `dispose()`.

Still **not wired into any production call site** — same as the prereq, and by the same
reasoning: adoption is the consumer's choice per the docs' wiring guidance. Everything below
was exercised through tests.

## Review findings

The implement-stage diff was read first, before the handoff summary. Findings by disposition:

### Fixed in this pass

- **The pool's source file was committed as a binary blob.** `const SEP` held a raw NUL
  *byte* — not the escape sequence — embedded directly in the source. Git classified the
  whole file as binary (`shared-cache-pool.ts | Bin 0 -> 16428 bytes` in both implement
  commits), so the entire 423-line implementation had no diff, no blame, and could not be
  reviewed by any normal means; `grep` reported it as a binary file and text tools skipped
  it. Runtime behavior was correct — NUL is genuinely the ideal separator, since no block id
  or action id can contain it — so this was purely a source-hygiene defect, but a severe one:
  the file would have stayed unreviewable for its whole life. Now spelled as an escape sequence
  rather than a raw byte, so the file is plain text and diffs normally. Every other file in the diff was scanned for
  embedded control bytes — this was the only one. The comment above `SEP` also gave a wrong
  reason for why keys cannot alias; replaced with the real one (no id can carry a NUL, and
  block ids — being user-supplied collection URI paths — may well contain spaces).

- **2Q silently degraded to plain LRU whenever the entry rail bound before the byte rail.**
  `pickVictim` gave probation a share of the byte budget (`a1inBytes > maxBytes/4`) but no
  share of the entry budget. Entries small enough that the entry count binds first — cached
  negatives are near-empty, and the default `maxEntries` is `maxBytes/512` — leave `a1inBytes`
  permanently under its byte target, so every admission took its victim from Am and a one-pass
  scan flushed the entire protected set. Exactly the pollution the admission layer exists to
  prevent, reachable through the ordinary probe path. Fixed by mirroring the byte share on the
  entry rail (`a1in.size > maxEntries/4`). **Measured**, not inferred: the new regression test
  loses 8 of 8 protected entries under the old policy and keeps 8 of 8 under the new one.

- **`unregisterStore`'s defensive sweep de-accounted entries without telling their owner.**
  It used `drop`, which by contract does not fire `onPoolEvict` because the owner is already
  removing its own reference. On this path the owner has *not* asked for anything, so the
  entries were stripped from the pool's accounting while the driver kept referencing and
  serving them — unbounded, uncounted, stale. Unreachable through `close()` (which clears
  first), but `unregisterStore` is public on an exported class. Now unlinks and notifies the
  owner like any other eviction; it deliberately does not ghost and does not count as a budget
  eviction, since a lifecycle release is not memory pressure. Test added.

- `stats()` declared `amBytes` with `let` and never reassigned it. Now `const`.

- Docs corrected for the above: `docs/storage.md` §6's 2Q bullet said "~25% of the byte
  budget"; it now states both shares, why both are needed, and that the share picks the
  victim's queue rather than capping A1in. The large-value-bypass bullet now says explicitly
  that it gates admission, not later growth.

### Tests added (the implementer's set was a starting point)

The handoff was honest that charge accounting is hand-tracked per-delta and had no test
recomputing a charge from scratch — it asked a reviewer to spot-check the revision and
pending-list paths, including the interval-merge shrink case. Four tests added, all
constant-free (they assert that operations returning to the same logical state return to the
same occupancy, so they cannot rot when the charge constants are retuned):

- Idempotent rewrites of metadata / revision / transaction / materialized values do not drift
  occupancy across repeats, and a longer value costs exactly its extra content bytes.
- A pend → unpend cycle returns the pending-id set to its prior charge, repeatedly — the add
  and remove deltas are exact inverses.
- Contiguous revision coverage merges intervals rather than charging one per revision: the
  marginal cost of each successive 100-revision chunk is identical, the first chunk costs
  strictly more (entry base plus the one interval), and sparse coverage of the same byte
  content costs strictly more than merged coverage. This is the shrink case the handoff
  flagged.
- Plus the two regression tests for the fixed defects above.

Suite: **1763 passing, 44 pending (pre-existing skips), 0 failing**; lint clean; `tsc` clean.
No pre-existing failures surfaced, so `tickets/.pre-existing-error.md` was not written.

### Checked and found sound (no change)

- **Coherence under eviction.** The whole point of the rewrite is that eviction at any instant
  is safe. Traced every path: the pool-discipline rule (mutate driver state first, pool call
  last, never touch cache state after) is followed everywhere, including the three coupled
  mutations in `promote`, which re-fetches the block state after the earlier mutations may
  have reaped it. The value and identity fill guards, the generation guards, and the
  completeness-flag-inside-the-entry design all survive the move onto pool entries. The
  conformance suite passing over both a 2 KB pool (pure read-through) and a 16 KB pool
  (constant churn) is the broad evidence.
- **Key aliasing.** Investigated whether a block id or action id could break the key
  encoding. Block ids can contain spaces (collection ids are user-supplied URI paths), but
  the separator is NUL, which no id can carry, and action ids are base64url — so the split is
  unambiguous. No defect; only the misleading comment, fixed above.
- **Concurrency.** All pool mutations are synchronous, and `ensureRevs`/`ensurePendList`
  contain no `await`, so two in-flight reads of the same key cannot both admit.
- **`close()` always defined** — checked the claim independently: the kernel never
  feature-detects `driver.close`, and only `cached-raw-storage.ts` and tests compose
  `CachedStoreDriver` in-repo.
- Source hygiene otherwise: `cached-store-driver.ts` is 859 lines but roughly half is doc
  comment, and the methods are short and single-purpose (it implements a 15-method driver
  interface); no split warranted. The test-helper extraction into `test/support/` is a clean
  move with no duplication left behind.

### Recorded as tripwires, not tickets

- **Container entries evade the large-value bypass on growth.** `updated()` does not re-check
  the 1/16 admission limit, so a block's revision map or pending-id set can grow past it and
  squat where a single oversized value would have been refused. Fine today and
  self-correcting — an over-share entry keeps `a1inBytes` above target so probation evicts it
  preferentially, and anything past `maxBytes` is evicted outright — and it needs roughly 20k
  revisions on one block at the 32 MB Node default to matter. `NOTE:` on
  `SharedCachePool.updated` names the trigger and the fix (gate growth on `admits` in the
  owner's revision/pending-list paths); `docs/storage.md` cross-references it.

### Not filed, with reasons

- **No new tickets were filed.** Every finding was either fixable inside this pass or
  genuinely conditional; none needed a root-cause site that this pass could not reach.
- **No accepted-tradeoff `NOTE:` was overridden** — the sites touched carried none.
- **Fairness between stores** stays deliberately unenforced, as the handoff argued. The
  argument holds on inspection: Am protection is what prevents indefinite starvation of a
  re-used working set, so a greedy store can only starve entries that were never re-used.
- **Charge constants** (`ENTRY_BASE` 256, `REV_SLOT`/`INTERVAL_SLOT` 56, `ID_SLOT` 40,
  2 bytes/char) remain engineering approximations of JS object overhead rather than profiled
  numbers. Left as-is: nothing correctness-bearing depends on them, they only need the right
  order of magnitude for the budget to mean what it says, and the new accounting tests are
  deliberately written not to depend on their values.
