description: A storage node can now say in one word how full it is — slack, steady, shedding or refusing — using percentages its operator configures, and everything that reacts to a full disk reads that one answer instead of its own. A node with almost no room left also stops telling the network it will take on the most work.
architecture: packages/db-p2p/docs/storage.md, docs/arachnode-ring-handoff.md
files: packages/db-p2p/src/storage/storage-pressure.ts, packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/src/storage/storage-account.ts, packages/db-p2p/src/blob/cache-budget.ts, packages/db-p2p/src/index.ts, packages/db-p2p/test/storage-pressure.spec.ts, packages/db-p2p/test/ring-selector.spec.ts, packages/db-p2p/docs/storage.md, docs/arachnode-ring-handoff.md, docs/debugging.md
----

# A node names how full it is

## What landed

A node now has one reading of how full it is, named rather than measured again at each site, and the thresholds behind it belong to the operator.

### `StoragePressure` — the one reading (`packages/db-p2p/src/storage/storage-pressure.ts`, new)

`StorageAccount` measures the disk; this reads that measurement against the operator's thresholds and names an ordered stage: `unknown` < `slack` < `steady` < `shedding` < `refusing`. The module exports `pressureStageOf` (pure — the one place a threshold meets a measurement), `usedFractionOf`, `atLeastPressure` (the one comparison a consumer makes, so no site re-derives the order), `StoragePressureThresholds`, `DEFAULT_STORAGE_PRESSURE_THRESHOLDS` (0.40 / 0.85 / 0.95), `resolveStoragePressureThresholds`, and the class itself with `read()` (async, samples, never rejects), `stage()` (synchronous, no I/O, the last stage measured), `configuredThresholds()`, `start()` and `stop()`.

`unknown` is first in the stage order, so `atLeastPressure('unknown', 'shedding')` is `false` and a node that cannot measure its storage is never read as full. `read()` logs `pressure:stage` only when the stage changed, and `pressure:unmeasured` when a scan threw — keeping the last stage rather than demoting to `unknown`. Its own unref'd timer samples once a minute (first sample at 0 ms after `start()`, each later one an interval after the previous read ends), and `read()` single-flights so a consumer's call and a tick's sample share one scan.

### Thresholds are the operator's

`NodeOptions.storageAllotment.thresholds` (typed `Partial<StoragePressureThresholds>`), resolved once in `createLibp2pNodeBase` beside `assertStorageAllotmentBytes` before anything starts, throwing on a value outside `(0, 1)` or an order other than `reclaimBelow < shedAbove < refuseAbove`. `RingSelectorConfig.thresholds.moveOut` / `.moveIn` keep their names and are now fed from `shedAbove` / `reclaimBelow`, so there is one figure with two readers rather than two literals in the node factory.

### Low space advertises less work, not more

`RingSelector.determineRing` answers the new exported `MAX_RING_DEPTH` (16) instead of `-1` when `availableBytes < minCapacity`. The sentinel is gone, and with it `createArachnodeInfo`'s `Math.max(0, ringDepth)` clamp and its `ringDepth >= 0` partition guard — so such a node advertises the narrowest slice *with a real partition*, where before it advertised ring 0 (the whole keyspace) with none. The unknown-capacity answer is unchanged (ring 0).

### The cache shrinks as the node fills

A sample at `shedding` or above calls `BlobCacheBudget.request()`, which is the trigger the cache was missing: `cacheBudgetBytes` already fell to 0 as other use filled the allotment, but nothing asked for an enforcement unless a read happened to arrive. `cacheBudgetBytes` itself is untouched.

### Wiring and docs

`storagePressure` is built beside `storageAccount` on both roles outside the arachnode gate, started right after `blobCacheBudget.request()`, with its stop wrapper installed after the budget's so it runs before it. It is on the typed attachment surface (`OptimysticNodeAttachmentsBase.storagePressure`) and exported from both package entries. `packages/db-p2p/docs/storage.md` gained §10 *How full is too full*; `docs/arachnode-ring-handoff.md` §§1.2/1.4/1.5 and its key-code-sites list were updated; `docs/debugging.md` gained a `storage:pressure` row.

## Review findings

The implement-stage diff is `ticket(implement): a-node-names-how-full-it-is`. Read before the handoff summary, then re-read against it. Four findings, all fixed in this pass; two tripwires parked; three concerns checked and deliberately left.

### Major — fixed: the ring floor lived in one decision, so the tick walked a short-of-room node straight back to the whole keyspace

`determineRing`'s new below-`minCapacity` answer (ring 16) was immediately undone by `shouldTransition`, which knows nothing about `minCapacity`. A node short of room is **empty**, so its `usedPercent` is below `moveIn`, and its smoothed depth `d` is low whenever the network's observed capacity is small or no ring stats have been seen yet. The move-in arm therefore fired on the very first tick and moved the node from ring 16 to ring 15, then one ring per dwell down to ring 0 — restoring exactly the behaviour this ticket removed, after sixteen pointless responsibility handoffs on the node least able to afford them.

Verified, not inferred: a scratch spec over the existing mocks (512 KiB available against a 1 MiB floor, advertising ring 16, no observed ring stats) answered `{shouldMove: true, direction: 'in', newRingDepth: 15}` on the first call.

Why it was invisible before this diff: when `determineRing` answered `-1` below the floor, `createArachnodeInfo` clamped it to ring 0 — which is where `shouldTransition` would have parked the node anyway, so the two decisions agreed by accident. Giving `determineRing` a real answer made the gap observable.

Fixed at the root rather than at the instance: the floor is now one private predicate, `RingSelector.belowMinCapacity(capacity)`, read by both `determineRing` and the move-in arm. Two readers, one comparison, so neither can drift from the other again. An unmeasurable node is explicitly *not* below the floor, which is why `determineRing` still answers ring 0 for it. The test that pins it (`ring-selector.spec.ts` — "never moves in from below the minimum capacity, so the deepest-ring answer holds") asserts both halves: no move, and the one-shot answer unchanged. `docs/arachnode-ring-handoff.md` §1.2's move-in rule and §1.4's "two consequences" bullet now carry the floor.

### Major — fixed: the new module was missing from the React Native entry

`src/index.ts` gained `export * from "./storage/storage-pressure.js"`; `src/rn.ts` did not. `test/entry-parity.spec.ts` fails on exactly this ("exported from src/index.ts but missing from src/rn.ts — React Native and browser consumers cannot import these"), and the implement stage did not run the package suite, which is where that test lives. Added to `rn.ts` beside `storage-account.js`, matching `index.ts`'s order. `node.storagePressure` is on the attachment surface that ships to React Native, so the type and `atLeastPressure` have to be importable there — the sibling gates will need both. `yarn check:rn` (Metro bundle + Hermes compile) passes with it.

### Minor — fixed: a sampler that could die silently and freeze every gate

`readOnce` re-arms the next sample *after* calling `requestCacheEnforcement`. Today's injected callback cannot throw synchronously (`BlobCacheBudget.request()` is `void enforce().catch(...)` over an `async` body), so this was not reachable — but a throw there would have taken the timer down for the life of the node while `stage()` kept answering whatever it last measured, silently disarming every reaction the siblings are about to hang off it. One subsystem's fault must not disarm the node's reading of its own disk. The trigger is now wrapped, logging `pressure:enforcement-refused` and leaving the sample and the re-arm standing; `docs/debugging.md`'s `storage:pressure` row documents the message.

### Minor — fixed: `usedFractionOf`'s justification contradicted a documented invariant

The comment said a `totalBytes` of 0 "can only arise from a location that reports no free space while the node has stored nothing". It cannot: `StorageScan.locationBytes` is documented absent — "never 0" — when the backend reports no free space, and an allotment of 0 throws at construction, so `effectiveTotalBytes` answers a positive figure or nothing. The branch is unreachable today and is a guard against a future 0 dividing into `NaN`, which compares false against every threshold and would read as `steady` — silently disarming every gate. Corrected to say that, and the test case's `why` string with it. The `refusing` choice itself is right (it fails toward full), and the implementer's flagged divergence from `shouldTransition`'s `usedPercent = 0` for the same input turns out to be a divergence on an input neither can receive.

### Cleanup — fixed: the resolved thresholds were threaded twice into the serving role

`ServingRoleContext` carried both `storagePressure` and a separate `pressureThresholds` field holding the same resolved object the reading already owns — while `StoragePressure.configuredThresholds()` had no caller at all. The field is gone and the `RingSelector` construction reads `storagePressure.configuredThresholds()`, which removes the second copy and gives the accessor its real caller in one move.

### Tripwires parked

- **A client now pays a recurring scan it did not before** — `NOTE:` at the `new StoragePressure(...)` site in `libp2p-node-base.ts`. A client runs no arachnode tick and enforces its read cache only after a read that fetched, so it previously scanned its store on no timer at all; it now pays one memoized `capacity()` per sample interval, which on a file-backed store is a directory walk. Condition to act on: a per-minute walk showing up in a client's profile — give the client a longer `sampleIntervalMs` rather than removing the reading.
- The four tripwires the implement stage parked (`stage()` staleness, ring 16 as the floor of advertised responsibility, hold-release sites triggering no cache enforcement, and the undamped unmeasurable-node stage) were each read against the code and left where they are. The ring-16 one is now also partly *enforced* rather than only noted, by the floor on the move-in arm.

### Checked and deliberately left

- **§10's table describes arms no code reads yet** — "the released-block sweep runs" and "every refusal gate" are tickets 3.3–3.6, still in `implement/`. Left as written: `storage.md` is this series' specification, every honest phrasing of "not yet" goes stale the week the siblings land, and §10 already ends by naming the one lever the chain is still missing. A reader looking for the gates finds nothing and is not harmed by it.
- **An explicitly `undefined` threshold throws rather than defaulting.** `{ shedAbove: undefined }` typechecks (the repo does not set `exactOptionalPropertyTypes`) and spreads over the default, so it fails `Number.isFinite` and raises `RangeError: storageAllotment.thresholds.shedAbove must be a fraction above 0 and below 1, got undefined`. Left throwing, with a clause added to `resolveStoragePressureThresholds`' doc saying why: the operator named the field and the message names it back, which matches the module's "throw rather than clamp" rule.
- **A solo bootstrap node with a tiny allotment takes a different restore path.** With `myRingDepth` now 16 rather than 0, `RestorationCoordinator.restore` no longer takes its `restore:solo-node-skip` shortcut and instead walks rings 15→0. Read the loop: `findPeersAtRing` is a local lookup and `recordFailure` is a counter, so this is sixteen cheap local iterations and a different log line for the same `undefined` answer. Not worth a change.
- **The implementer's judgement call #1 — whether `shouldTransition` should take the stage rather than form its own `usedPercent`** — reviewed and the narrow reading upheld. The two readers share one figure and one memoized scan, and the ring arm's own EWMA, dead-band and dwell make a one-interval disagreement immaterial. What *was* wrong at that site was the missing floor, not the duplicated fraction, and that is now fixed.

### Tests

One test added, for the defect found: `ring-selector.spec.ts` — "never moves in from below the minimum capacity, so the deepest-ring answer holds". It pins the invariant (`determineRing`'s answer and the tick now agree below the floor), not the implementation.

Nothing was cut. The three `storage-pressure.spec.ts` cases each pin a named piece of the specification on branching logic — the `unknown`-is-never-full ordering, the strictness of each threshold boundary, and the stage order `atLeastPressure` rests on — and the two rewritten `ring-selector.spec.ts` cases carry the behaviour change rather than restating it. `StoragePressure`'s timer, single-flight and kept-stage-on-failure paths remain verified by inspection, as the implement ticket proposed; the `setTimer` seam is there if a later ticket finds a reason to test through it.

### Commands run

- `yarn build` (all workspaces) — clean
- `yarn lint` — clean; `yarn lint:docs` — 49 documents, 898 anchored citations resolve; `yarn lint:deps` — 1318 files, every import declared
- `yarn test` in `packages/db-p2p` — 3893 passing, 84 pending (the one `entry-parity` failure above, fixed, then re-run green)
- `yarn test:integration` in `packages/db-p2p` — 60 passing, 2 pending
- `yarn test` in `packages/quereus-plugin-optimystic` (depends on db-p2p) — 1458 passing, 16 pending, smoke ok
- `yarn check:rn` — Metro bundles the React Native entry and Hermes compiles it

No pre-existing failures surfaced, so no `.pre-existing-error.md` was written.

## What this does not do

Nothing consumes `refusing` yet — the gates are tickets 3.3–3.6 — so `refuseAbove` names a stage nobody acts on today. The behavioural changes observable now are: the ring decision's thresholds became configurable, the below-minimum ring answer changed from 0 (whole keyspace, no partition) to 16 (narrowest slice, with its partition) and now *holds* against the tick, and the read cache is enforced on a timer when the node is full.

`reference-peer`'s `logRingInfo` still prints `storageAccount.capacity()` without the stage; `feat-an-operator-can-see-what-fills-a-node` owns the operator-facing report. And §10 records the honest limit of the whole series: none of the four levers a full node has touches old revisions of blocks it is still responsible for, so a node whose bytes are mostly block history reaches `refusing` and stays there until an operator raises the allotment or its peers take its ranges. `feat-cold-range-transform-offload` is the missing lever.
