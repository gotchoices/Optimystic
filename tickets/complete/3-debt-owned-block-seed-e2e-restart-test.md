description: A restarted node now has a test proving it really does relearn, at startup, which blocks it already holds — plus a cross-backend test pinning exactly which blocks that startup scan finds, and corrections to several comments that described the wrong set.
prereq:
files: packages/db-p2p/test/owned-block-seed-node-wiring.spec.ts, packages/db-p2p/src/owned-block-seed.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p/test/owned-block-seed.spec.ts
----

# Owned-block startup seed — node-level restart test + cross-backend contract pin

## Background

A node's two resilience monitors (churn-spread and rebalance) share one `Set<string>` of "blocks
this node holds". The live feed that fills it fires only on a new commit or a received replica — so
blocks left durable by a *previous* process run stay untracked after a restart, and a freshly
restarted node under-protects exactly the data it already holds. `createLibp2pNodeBase` closes that
with a fire-and-forget startup scan over the storage backend's block-id enumeration
(`seedOwnedBlocksFromStorage`).

Every piece of that was unit-tested in isolation. The **assembly** was not: that node construction
calls the scan with the *shared* set, under the "at least one monitor consumes it" gate, and that
the ids actually arrive.

## What landed (implement stage)

### New spec: `packages/db-p2p/test/owned-block-seed-node-wiring.spec.ts`

**Arm 1 — real restart.** One `MemoryRawStorage` instance handed to two sequential
`createLibp2pNode({ storage })` calls. Faithful, not simulated: `resolveStorage` returns a supplied
`IRawStorage` verbatim and nothing on the stop path closes or clears it. node1 commits 3 blocks
through the real coordinated repo (`clusterSize: 1` → self-only consensus) and pends a 4th without
committing; node2 boots over the same storage and commits **nothing**, so anything in its tracked
set can only have come from the startup scan. Asserts set equality on all 4 ids.

**Arm 2 — the gate is the feed, not the spread block.** One node with spread disabled and the
rebalance path enabled, over pre-populated storage. Here the feed is registered by the rebalance
block, and the scan's gate must see it — a path arm 1 cannot reach.

Both arms poll (25 ms interval, 5 s deadline, error names the missing ids) rather than sleeping —
the scan is dispatched with `void …` and is not awaited by construction. Both stop their nodes in
`finally`.

The tracked set is read as `(monitor as any).trackedBlocks` (the monitors expose only a count).
That is the stronger assertion: it proves the set IS the shared instance, not just that a count
moved.

### Comment corrections

The scan enumerates every block with **any** durable metadata — a **superset** of what the live feed
tracks, because a plain pend also writes metadata (`BlockStorage.savePendingTransaction` seeds
`{ latest: undefined, ranges: [] }` for a block that has none, before storing the transform). Three
comments claiming the narrower population were corrected, and a `NOTE:` tripwire was added recording
the accepted over-inclusion, why it is benign today, and the revisit condition.

### The plan ticket's pend-only assertion was inverted

The plan asked for an assertion that a pended-but-never-committed block is **not** seeded. That is
false at the node seam, and the test asserts the opposite. Verified independently during review — see
findings below. **No production behavior was changed**: filtering to committed-only would require
reading and decoding metadata for every id at startup (a per-block read on the filesystem backend,
exactly the cost the streamed key enumeration exists to avoid), and the over-inclusion is inert
because every consumer of the shared set re-checks local data before acting.

## Review findings

### Verified before anything else

Read the implement diff first, then re-derived its load-bearing claims from source rather than from
the handoff:

- **The pend-writes-metadata chain is real.** `BlockStorage.savePendingTransaction`
  (`block-storage.ts:107-119`) writes metadata for a block that has none before storing the pending
  transform, and all five `listBlockIds` implementations (memory/kv, fs, sqlite, leveldb, indexeddb)
  key off the metadata store. The implementer's reading is correct.
- **Arm 1's "real restart" premise holds.** `resolveStorage` (`libp2p-node-base.ts:330-334`) returns
  a supplied storage verbatim, and there are only six `rawStorage` references in the whole node-base
  file — none of them a close or a clear on any path, stop included.
- **Arm 1's set-equality assertion is not timing-dependent today.** `SpreadOnChurnMonitor` sweeps
  only on a `connection:close` event followed by a debounce (`spread-on-churn.ts:120, 162-186`), and
  `RebalanceMonitor` is event-debounced the same way. A solo node with no peers runs no sweep, so
  nothing untracks the pend-only block mid-test. The spec now says this explicitly, naming the event.
- **The caching layer does not distort the enumeration.** `CachedStoreDriver.listBlockIds`
  (`cached-store-driver.ts:201-203`) passes straight through to the inner driver; funnelled writes
  keep the inner metadata store authoritative, so there is no stale-enumeration hazard.
- **Docs are current.** No file under `docs/` mentions owned-block seeding or block-id enumeration,
  so there was nothing stale to update — checked rather than assumed.

### Major — resolved architecturally, no ticket filed

**The new interface contract was documented but unenforced.** The implement stage added a normative
requirement to `i-raw-storage.ts` — enumerate every block with any durable metadata, and do *not*
read each block's metadata to filter by committed revision — and then declared its own coverage
boundary as "only the in-memory backend is exercised; no test runs against a real on-disk backend."
That is a contract four out-of-package backends must honor with nothing checking them.

Rather than file a point ticket per backend, this was closed at the seam: all four external backends
(filesystem, SQLite, LevelDB, IndexedDB) already run the shared `runRawStorageConformance` suite, so
**one** case there covers all of them and every future backend. Added
`listBlockIds enumerates a BlockStorage pend-only block (metadata seeded before the transform)` to
the suite's `BlockStorage` parity slice, with a comment naming what it exists to stop (a backend
"helpfully" adding a committed-revision filter).

It passed on all four backends unmodified — so it is a **pin**, not a fix. That is the point: the
contract is now enforced where it was previously only described, and the ticket's declared coverage
gap is closed at the layer where it is cheap.

### Minor — fixed in this pass

- **The comment sweep was incomplete, and the worst instance was missed.** The implementer correctly
  identified that "a pend-only block has no metadata and is not enumerated" is a raw-driver-layer
  statement, not a node-level one, and annotated `owned-block-seed.spec.ts` accordingly — but three
  sibling sites kept the stale framing. The worst is the filesystem backend
  (`file-storage.ts:243-251`), where the stated *reason* for gating on `meta.json` was "enumerating
  it yields exactly the blocks with a committed revision / persisted replica — the same population
  the live change feed tracks." That is now known-false, and it sits directly above the code a future
  maintainer would edit. Corrected there, in the shared conformance suite
  (`raw-storage-conformance.ts:359`), and in the filesystem spec (`file-storage.spec.ts:305-306`) —
  each now states which layer its assertion holds at and points at the other.
- **The same explanation was copied into five places.** Condensed the `owned-block-seed.ts` docstring
  paragraph and the new spec's 13-line inline block into pointers, leaving the full rationale in the
  one greppable `NOTE:` and the normative statement in the interface doc.
- **Two unnecessary `as any` casts in the new spec.** `repo.pend(...)` and `repo.commit(...)` request
  literals were cast to `any`. `ActionId` and `BlockId` are plain string aliases and `PendRequest.rev`
  is optional, so both literals were already well-typed — the casts bought nothing and would silently
  swallow a field rename in the exact production path the test exists to exercise. Removed; `tsc`
  confirms clean (db-p2p's tsconfig includes `test/`, so the specs are genuinely typechecked). Also
  folded `pendCommit` onto `pendOnly`, which it duplicated verbatim.

### Considered and deliberately not changed

- **`(monitor as any).trackedBlocks` / `node: any`.** Real type-safety erosion, but it is the class
  already tracked by `debt-node-attachment-reads-bypass-typed-surface`, and it is the *correct*
  assertion here (reading the set proves shared identity, which a count cannot). Appending this as an
  Nth instance would add no information to that ticket.
- **The inverted pend-only assertion.** Re-derived independently; the implementer is right and the
  disagreement, if any, would be about production filtering behavior rather than about the test.
  The accepted-tradeoff `NOTE:` is the right disposition — the alternative costs a per-block read at
  every startup to remove an over-inclusion that self-corrects.
- **Spec verbosity.** Still comment-heavy at 200 lines after the trim, but the remaining prose
  carries non-obvious rationale (why the pend-only expectation is inverted, why polling, why a
  private field is read). Not churned further.
- **Pre-existing lint diagnostic** at `file-storage.spec.ts:252` ("unreachable code" after
  `this.skip(); return;`) — outside this diff, untouched, and not papered over.

### Tripwires

No new ones. The implementer's `NOTE:` on `seedOwnedBlocksFromStorage` already parks the only
conditional concern in this diff (the over-inclusion, revisit-if a consumer ever acts destructively
on set membership alone), and the filesystem backend's own scan-cost `NOTE:` predates this work.

### New tickets filed

**None**, and the reason is not "looks good": every finding was either a comment or type correction
resolvable inside this pass, or — for the one finding with real class behind it, the unenforced
`listBlockIds` contract — closed by a single shared conformance case rather than by a queued ticket.
Nothing required a change whose risk or scope exceeded a review pass.

## Validation

Full monorepo, after the review changes:

- `yarn lint` — clean.
- `yarn build` / `yarn typecheck` — clean.
- `yarn test` — **all workspaces green, 0 failing.** `@optimystic/db-p2p` 1810 passing / 44 pending
  (up 5 from the implement stage's 1805 — the new conformance case across db-p2p's five conformance
  registrations); filesystem 54, SQLite 51, LevelDB 46, IndexedDB 45 — each up one, all passing the
  new contract case unmodified.
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.

The implement stage additionally ran a negative control: temporarily passing a fresh `Set` instead of
the shared owned-block set at the seed call site made **both arms fail** with
`startup seed never delivered […] (tracked: [])`, then reverted. That proves the spec catches the
exact shared-set regression it exists to catch.

## Remaining coverage boundary (unchanged, deliberate)

- **Both monitors disabled → no scan.** The gate holds, but with no monitor wired there is no tracked
  set to inspect, so it is not observable at node level. Covered by the two monitor wiring specs.
- **Backend without block-id enumeration.** Second half of the same gate; covered by the helper
  spec's no-op case.
- **Stop during scan.** With a handful of ids the scan finishes far too fast to hit deterministically
  at node level; the helper spec covers the mechanism. A timing-dependent arm here would be flaky.
- **Node-level restart is exercised only against the in-memory backend.** The on-disk backends live
  in sibling packages. The review pass narrowed this: the *contract the restart depends on* is now
  pinned per backend by the shared conformance suite, so what remains unexercised is the node
  assembly over a real on-disk store, not the enumeration semantics it relies on.
