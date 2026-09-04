description: A cold schema application on a solo node spent about half its time asking the operating system for this machine's own network addresses on every single write; that answer is now computed once. Also adds cost gates so the operation cannot get slower unnoticed, and carries the plugin across a breaking change in the query engine.
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/bench-findcluster.mjs, packages/db-p2p/docs/cluster.md, packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts, packages/quereus-plugin-optimystic/test/repro-issue8.mjs, packages/quereus-plugin-optimystic/test/ordering-claim-guard.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, tickets/backlog/feat-schema-batch-hooks-for-apply-schema.md, tickets/backlog/feat-optimystic-persisted-planner-statistics.md
----

# What landed

Three separable pieces of work, driven by GitHub issue #8 and a follow-up report of the same
operation failing on an Android device.

## 1. `findCluster` stopped re-deriving this node's own addresses

Every commit resolves its block's cohort (`CoordinatorRepo.commit` → `getClusterPeerIds` →
`findCluster`), and `findCluster` puts this node's own addresses into the cluster record it builds.
It got them from `libp2p.getMultiaddrs()`, which on Node re-derives announce addresses from
`os.networkInterfaces()` — a full network-interface sweep. Measured: **3.19 ms of a 3.49 ms call**,
recomputing an identical answer every time.

`Libp2pKeyPeerNetwork` now derives them once and holds the result until libp2p reports
`self:peer:update` (the event fired when this node's own address set changes).

| | before | after |
|---|---|---|
| `findCluster`, solo node | 3.85 ms/call | **0.010 ms/call** |
| cold `apply schema`, 22 objects | 2.07 s | **0.21 s** |
| cold `apply schema`, 67 objects | 4.89 s | **0.61 s** |

The end-to-end gain (8–10×) is larger than `findCluster`'s own 49% share of the operation because
`os.networkInterfaces()` is a blocking syscall — it was also stalling unrelated async work.

**Scope of the win, measured after the fact (2026-09-04) and worth stating before anyone quotes the
table above.** The sweep happens only when there is a wildcard listen address to expand. On one host:

| node configuration | `getMultiaddrs()` |
|---|---|
| TCP listener (what the figures above were measured on) | 4.44 ms/call |
| dial-only client, websockets, no listen addrs | **0.001 ms/call** |

So this materially helps **listening** peers — service and reference nodes, which commit as much as
anyone — and is close to a no-op for an edge or mobile client that only dials out. That matters
specifically because the on-device report driving this issue is the second shape: the fix was
measured, shipped, and then explicitly *not* offered to the reporter as a likely cause of their
symptom (issue #8 comment 5545490485).

## 2. Cost gates for the coordinated cold-apply path

`local-transactor-read-cache.spec.ts` already guarded the `local` transactor. Nothing guarded the
**coordinated** path — which is exactly the one that regressed in the field when a downstream host
stopped routing schema creation through a local transactor. `cold-apply-cost.spec.ts` now gates it
on five axes, counting operations rather than wall clock, over a 1-node mesh (~2 s, no sockets):

| gate | quantity | measured (22 / 67 objects) |
|---|---|---|
| 1 | raw-storage driver calls per object | 32.7 / 23.5 |
| 2 | coordinated commits per object | 1.59 / 1.19 |
| 3 | per-object cost must not GROW across the two scales | 32.7 → 23.5 (falls) |
| 4 | `findCluster` calls per commit | 2.40 / 2.23 |
| 5 | `ITransactor.get` per object (ceiling per scale) | 40.9 / 55.0 |

## 3. Quereus 4.19 migration

4.19 retired `TableSchema.estimatedRows`. The row count now reaches a module through
`BestAccessPlanRequest.estimatedRows`, and its in-memory home is `TableSchema.statistics.rowCount`,
which `ANALYZE` populates. `getBestAccessPlan` reads the request field, matching the shipped memory
module's `request.estimatedRows || 1000`. The persistence slot was deliberately left inert — see
findings.

# Testing notes

- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` all clean.
- Full suite **5,459 passing, 0 failing**; integration **739 passing, 0 failing**.
- Both new test groups were verified to FAIL without their fix — see findings.
- Two diagnostic harnesses are kept as tools, not tests (they are `.mjs`, so the `*.spec.ts` glob
  never runs them): `repro-issue8.mjs` reproduces a cold apply through either transactor with
  injectable storage latency, cache budget and transactor timeout; `bench-findcluster.mjs` times
  `findCluster` against its internals. `repro-issue8.mjs` is what will verify any device-side fix.

# Review findings

Adversarial pass over the implement diff, before re-reading the handoff. Everything below was
resolved in this pass except where a ticket arm is named.

## Major — resolved

**The statistics migration was not the behaviour-preserving rename its own comment claimed.**
Mapping `StoredTableSchema.estimatedRows` to and from the new `TableSchema.statistics` looks like a
pure type migration and is not one. The old field was **inert in practice** — quereus never set
`TableSchema.estimatedRows` for a plain virtual table (only its materialized-view helpers did), so
the value the store path copied was `undefined` on every real table. The new `statistics` field is
populated by `ANALYZE`. Wiring them together would therefore have:

- made `ANALYZE` dirty the stored schema, so the next table initialization fails `schemasEqual` and
  commits a **schema rewrite per table** — a distributed write caused by what a user reads as a
  statistics-only command;
- silently delivered the first bullet of an existing, deliberately-deferred ticket
  (`feat-optimystic-persisted-planner-statistics`), including walking into the multi-node question
  that ticket defers the feature over;
- round-tripped `rowCount` while dropping `columnStats`, so a restarted table would present as
  *analyzed* with no column statistics behind it.

Resolved by making the migration genuinely inert: neither conversion site touches the slot, which
keeps the stored format byte-identical with every schema persisted before 4.19 (no rewrites). In-session
`ANALYZE` is unaffected — quereus keeps statistics on its own catalog and passes the count through
the request. Both sites carry a `NOTE:`. Per *Before you file a ticket*, the site was already claimed:
the analysis is appended as an arm to `feat-optimystic-persisted-planner-statistics` rather than
filed fresh, and it hands that ticket's implementer a free backward-compatible slot plus the three
decisions to make.

## Minor — fixed in this pass

- **`ordering-claim-guard.spec.ts` carried a field that no longer exists.** Its fixture set
  `estimatedRows` on a `TableSchema`; after the migration nothing supplied a row count at all. Moved
  to the request, where the module now reads it, with a comment on why. **Correction to my own first
  reading:** I initially recorded this as a test disarmed by my change. It was not — the spec asserts
  ordering claims, not cost, and still passes at `TABLE_ROWS = 5`. The field was decorative before
  and after. This is hygiene, not a caught defect, and is written down that way so the next reader
  does not inherit the overstatement.
- **Gate 3 cannot see the quantity that is actually growing.** `ITransactor.get` per object measures
  40.9 / 55.0 / 80.6 at 22 / 67 / 250 objects — each created object re-reads a growing catalog. The
  read cache absorbs it before it reaches the driver, so gate 3 (driver calls) reads *flat* while
  this rises; nothing would have caught it. Added gate 5. It asserts a **ceiling per scale** rather
  than gate 3's no-growth rule, because the growth is real and present — a no-growth assertion would
  have failed on arrival. The gate pins the shape against getting worse; it is not a blessing of the
  curve, and says so, pointing at `feat-schema-batch-hooks-for-apply-schema` whose batch-scoped
  context is what would stop the re-read.
- **`cluster.md` documents how a record's entry for a *remote* member is built, and said nothing
  about self's.** Self's entry is the one this change altered. Added a bullet covering the
  memoization, its cost rationale, and its two consequences.

## Tripwires — recorded at the site, not filed

- **The memo's invalidation is neither instantaneous nor unconditional.** libp2p reaches
  `self:peer:update` through `AddressManager._updatePeerStoreAddresses`, which is **debounced by
  1000 ms** and then does a fire-and-forget peer-record write. So a published record can carry the
  previous address set for ~1 s after a transport starts or stops listening, and a peerStore write
  failure leaves the memo stale until the next successful address change. Acceptable today —
  addresses change at startup and relay-reservation time, not per commit, and a stale entry lands on
  paths that already handle missing/undialable addresses. `NOTE:` at the site names the revisit
  condition (routine address churn, or an unexplained stale-address dial failure). Not a ticket: it
  is conditional, not a defect waiting on a dormant path.

## Checked and clean

- **Round-trip symmetry.** `schemasEqual` compares the *stored* shape and both sides are produced by
  `tableSchemaToStored`, so the migration cannot cause spurious rewrites — verified by reading the
  comparator rather than assuming.
- **Invalidation completeness.** Traced `transport:listening` / `transport:close` / observed-address
  confidence → `_updatePeerStoreAddresses` → `peerStore.patch` → `self:peer:update`. It is the right
  event; its timing is the tripwire above.
- **Other `getMultiaddrs()` call sites.** One other exists (`routing/libp2p-known-peers.ts`); it is
  not on a per-commit path, so it is left alone. `findCoordinator` measured 0.05 ms/call and needed
  nothing.
- **Listener lifecycle.** The new `addEventListener` matches the existing `setupConnectionTracking`
  pattern in the same class — same lifetime, same absence of a removal path. No new leak class
  introduced; changing that convention would be a separate change to both.
- **Both new test groups fail without their fix.** Reverting the memo fails 2 of the 4 key-network
  tests; dropping the read-cache wrap fails gates 1 and 3 with the intended messages. The other two
  memo tests (addresses still correct, each caller gets its own array) pass either way by design —
  they guard properties the memo could break, not the memo's presence.
- **Mutation safety.** `getSelfMultiaddrs()` returns a fresh array per call; the value goes into a
  caller-owned `ClusterPeers` record that is not frozen. Covered by a test.
- **Gate-4 scope is narrower than it looks, and says so.** The proxy sees the lookups the
  *transactor* drives; each mesh node derives its cohort from its own key-network view, so
  coordinator-side `getClusterPeerIds` calls are not counted. Documented in the spec rather than left
  to be misread.

## Empty categories

- **No pre-existing failures.** Every package was green before and after; `tickets/.pre-existing-error.md`
  was not written because there was nothing to report.
- **No new tickets filed.** Both findings that warranted one landed on already-claimed sites, so per
  *Before you file a ticket* they were appended as arms to the open tickets
  (`feat-optimystic-persisted-planner-statistics`, and the on-device analysis previously added to
  `feat-schema-batch-hooks-for-apply-schema`) rather than filed fresh.
- **Nothing routed to `blocked/`.** The one genuine design question found — whether to persist
  `ANALYZE` output — already has a ticket that owns it; re-asking it as a decision ticket would
  duplicate that ticket's own deferral.

# Still open, and not this work's to close

Issue #8's on-device report is **not explained**. The coordinated path completes in 0.21 s here for
the same 22-object schema that did not finish in 47 minutes on an Android emulator. Ruled out:
timeout-induced retry storms (a 50 ms transactor timeout produced an identical 35 commits) and
read-cache thrash (688 KB working set against React Native's 8 MB budget; even a forced 256 KB budget
only moves driver calls 1,575 → 2,524). The reported 3–4 commits/sec is reproducible as the *normal*
rate at 5 ms/storage-call and is not a loop signature — but 22 objects budgets ~35 commits, and 47
minutes at that rate is ~9,000. The rate is explained; the volume is not.

The decisive datum was requested on the issue (comment 5535112952): distinct `blockId` count versus
line count in a 60 s window of `commit:solo-cohort` logs taken deep into the run. Repeats mean a
commit loop on our side; distinct ids mean the host's founding path does far more work than the 22
declared objects. `feat-schema-batch-hooks-for-apply-schema` carries the full analysis and is marked
not-to-scope until that answer arrives.
