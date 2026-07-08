description: Documentation was added explaining the per-collection write-speed limit and how to shard a hot collection across sub-collections to work around it.
prereq:
files:
  - docs/optimystic.md
  - docs/crdt-sync.md
difficulty: easy
----

## What shipped

- **`docs/optimystic.md`** — new "Write Throughput and Collection Sharding" section (between "Operational Basics" and "See Also") covering: the per-collection log-tail-cluster throughput ceiling, how to recognize a hot collection (three signals), how to shard, the cross-shard atomicity tradeoff, OCC-starvation interaction, and the long-term HLC fix.
- **`docs/crdt-sync.md`** — conditional trigger note prepended to `§Migration Path`: start Stage 1–5 only when a hot collection cannot practically be sharded; sequence via `prereq:`; do not advance stages without measuring.

## Review findings

**Verified against code (all claims accurate):**

- `resolveRace` super-majority promise+commit round — `packages/db-p2p/src/cluster/cluster-repo.ts:1442`, threshold at `:741`. ✓
- `cluster-member:consensus-pend-diverged` log key — real, logged on pend divergence at `cluster-repo.ts:1150`. ✓
- `committedCollections` / `failedCollections` reconciliation reporting — `packages/db-core/src/transaction/coordinator.ts:265,614`. ✓
- `Tree.createOrOpen`, `TransactionSession`, `ActionsEngine`, `QuereusEngine` — all exist and are the correct names. ✓
- Theorem 3 = "Multi-Collection Atomicity of Intent (Eventual, Reported Visibility)" — `docs/correctness.md:124`, matches the doc's characterization exactly. ✓
- Priority aging + structural read exclusion "both implemented" — `transaction.ts:92`, `collection.ts:328`. ✓

**Internal links:** All 9 cross-references in `optimystic.md` resolve to existing files in `docs/` (checked programmatically). The three called out by the implementer (`crdt-sync.md`, `transactions.md`, `correctness.md`) are present. ✓

**Minor — fixed inline:** The sharding code snippet used `parseInt(userId.slice(-4), 16) % 8`. For any non-hex `userId` (UUIDs with dashes, usernames, emails) `parseInt(..., 16)` returns `NaN`, so every write collapsed into a single `messages-NaN` shard — the example silently did the opposite of its stated goal (even distribution). Replaced with a stable string hash over the whole key that works for any string id, and added a sentence explaining why to hash the whole key rather than slice a suffix or hex-parse. `docs/optimystic.md:282`.

**Use cases 1–5 from the handoff:** hot-collection diagnosis reads self-contained against the three signals; sharding example now realistic and copy-safe; cross-shard atomicity warning is prominently sectioned with the partial-landing possibility spelled out and linked to Theorem 3; crdt-sync note is properly conditional ("the signal is observed contention… that sharding cannot practically resolve"); all links accurate. No further changes needed.

**Tripwire (carried from implementer, confirmed):** `cluster-member:consensus-pend-diverged` counts re-races (pend divergences), not throughput — it is the best current observable for OCC contention but not a direct ops/sec metric. If per-collection observability counters are ever added to cluster-repo, they would supersede this signal. Not filed as a ticket (conditional, no single code site warrants a `NOTE:` comment); recorded here for the record.

**Empty categories:** No major findings (nothing warranting a new ticket) — the change is documentation-only with no runtime surface, and every factual claim checked out against the code. No test/lint run applies: the change touches only markdown, which is not part of the TypeScript build or test graph; link resolution was checked directly instead.

**Deferred (not blocking, from handoff Known gaps):** per-shard `clusterSize` tuning and explicit per-collection ops/sec instrumentation were intentionally left out to avoid scope creep. Reasonable — both interact with other subsystems (Byzantine-fault thresholds; observability tooling) and belong in their own tickets if/when needed. No action.
