description: The database engine offers a way for a plugin to say "these schema changes belong together", and our plugin does not implement it, so a cold schema application is executed as many independent statements. The read amplification this caused is fixed on Node, but a downstream report has the same operation failing to finish on a phone, and we have not yet explained why.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (the module object — neither hook is defined on it)
  - packages/db-p2p/test/cached-raw-storage.spec.ts:508 (the read-amplification measurement that now reports the cut)
  - packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts (plugin-side read-cache coverage)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:314 (`withReadCache` — the mitigation that landed)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (the coordinated-path gates; measured baselines live here)
  - packages/quereus-plugin-optimystic/test/repro-issue8.mjs (the diagnostic harness the figures below came from)
difficulty: medium
tradeoffs: On Node the read cache already removed ~96% of the redundant reads, so the remaining win there is commit-count and round-trip batching rather than the amplification that made this urgent. What stops this being a clean "leave it unimplemented" call is the on-device report: a 22-object schema that took ~3 s on the old local-transactor path did not finish in 47 minutes on the coordinated path at 0.27. That gap is unexplained, and until it is, nobody can say whether these hooks would fix it.
----

# `beginSchemaBatch` / `endSchemaBatch` are still unimplemented — fixed on Node, unexplained on device

## Reported

GitHub issue #8 (`risavian`), against `@optimystic/quereus-plugin-optimystic@0.17.0`. It is a
careful report: it measured 13,025 raw-storage calls for one cold `APPLY SCHEMA` over 54 tables +
13 indexes — **194 per created object, 89.3% provably redundant** — and supplied a runnable
reproduction using only published packages.

**Second report, 2026-09-03 (`kjeib`), on device.** The same operation on an Android emulator via
`rn-leveldb`, on a 22-object schema (9 tables + 13 indexes):

| stack | `apply schema` path | cold apply |
|---|---|---|
| cadre-core 0.10 / optimystic 0.22 (`StrandConfig.mode: 'bootstrap'`) | local transactor | ~2.9 s |
| cadre-core 0.12 / optimystic 0.27 (`mode` removed) | coordinated commit, cohort of 1 | **did not finish in 47 min** |

Reproduced across debug, release, and a websockets-only transport. Their logs show a steady stream
of `commit:solo-cohort` at 3–4/sec throughout.

## Status at HEAD: half addressed, and it is worth being precise about which half

**The hooks are still absent.** `grep -rn "beginSchemaBatch\|endSchemaBatch"
packages/quereus-plugin-optimystic/src/` returns **zero hits**. Quereus lets a vtab module fold a
whole `APPLY SCHEMA` into one substrate commit through those optional hooks; our module implements
neither, so each DDL statement is executed with no batch context and the module is never told the
statements belong together. That is exactly as reported.

**The consequence the issue was filed about is gone ON NODE.** The issue's own framing is that the
cost "turned out to be read amplification rather than commit count", and that is the part that has
since been fixed — by a different mechanism than the one requested. `withReadCache`
(`collection-factory.ts:314`) now fronts the raw store, and the cut is measured rather than asserted:
`cached-raw-storage.spec.ts:508` prints a before/after, most recently **809 reads → 33, a 95.9%
cut**.

Re-measured at HEAD against the issue's own 54+13 schema, through the coordinated path, counting
below the cache: **1,575 driver calls, 23.5 per object** against the reported 194 — an 88% cut. The
harness is measuring the same thing the reporter was; it produces **178** `promote`/`putRevision`,
exactly the 178 they reported for that schema.

So the reporter's diagnosis was right and their proposed fix is still unimplemented, while their
measured symptom has been addressed on a different axis.

## What the on-device report changes

**The device failure is NOT reproducible on Node and is NOT yet explained.** The same coordinated,
cohort-of-1 path that failed on the phone completes here in 0.21 s for their 22-object schema and
0.61 s for 67 objects. Two candidate mechanisms were tested and ruled out:

- **Timeout-induced retry storm** — squeezing `NetworkTransactor.timeoutMs` to 50 ms produced an
  identical 35 commits.
- **Read-cache thrash** — the working set is 688 KB for 67 objects, well inside React Native's
  8 MB budget (`shared-cache-pool.ts`, `platformDefaultBytes`). Forced to a 256 KB budget, driver
  calls only go 1,575 → 2,524.

One thing the report DOES pin down: 3–4 solo commits/sec is the normal rate of this workload on
slow storage, not a loop signature — injecting 5 ms per storage call reproduces that rate exactly.
But 22 objects budgets ~35 commits total, and 3–4/sec sustained for 47 minutes is ~9,000. **The rate
is explained; the volume is not.** Either cadre-core's founding path does far more work than the 22
declared objects, or something loops. Those are different bugs.

The decisive datum was requested on the issue (comment 5535112952): distinct `blockId` count versus
line count in a 60 s window of `commit:solo-cohort` deep into the run. Do not scope this ticket's
work until that answer lands — it decides whether these hooks are even the right lever.

## What remains

The batch hooks are still the better shape for the underlying problem, and they buy something the
read cache cannot: fewer *commits*, and one substrate round trip for a migration rather than one per
DDL. That matters on a distributed backend in a way it does not on a local one.

The re-measurement this section used to ask for is **done** (figures above, 2026-09-03). On Node a
cold apply is fast, so as far as this repo can currently observe, the hooks are a
correctness-of-API item — we advertise a vtab module and silently decline an interface the engine
offers — rather than a performance one. Scope it that way *unless* the device answer comes back
saying otherwise.

`ITransactor.get` per object is the one number that argues for building this anyway: 41 / 55 / 81
at 22 / 67 / 250 objects, i.e. each created object re-reads a growing catalog. The read cache
absorbs that at the storage seam today. A batch-scoped context is what would stop it being
re-derived at all. `cold-apply-cost.spec.ts` gate 3 watches the shape.

## Coverage added (2026-09-03)

`packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts` now gates the coordinated cold
apply on four axes — driver calls/object, commits/object, cost-per-object across two scales, and
`findCluster` calls/commit. Before it, only the `local` transactor was guarded
(`local-transactor-read-cache.spec.ts`), which is why the coordinated path drifted unnoticed until
a downstream host hit it.

The gates are cheap (~850 ms) but *only* meaningful because the spec wraps the mesh's storage in
`withReadCache` — `createMesh` does not do that, only `libp2p-node-base.resolveStorage` does.
Unwrapped, the same workload measures 312→396 calls/object instead of 32.7→23.5. If a future edit
drops that wrap, gates 1 and 3 silently start measuring a configuration nothing ships.

## Reply sent

Answered on the issue 2026-09-03 (comment 5535112952): what landed, what did not, the current
numbers, and the five diagnostics needed from the device. No longer owed — but the requested logs
have not come back yet, and the "What the on-device report changes" section above is waiting on
them.

## Triage note (backlog gardening, 2026-09-01)

This ticket carried `severity: performance` / `likelihood: certain-on-cold-schema-apply`. Both were
removed: `severity` / `likelihood` describe the user-visible effect and reachability of a *defect*,
and this is a feature ticket — the plugin declines an interface the engine offers; nothing computes a
wrong answer. The performance framing those fields were reaching for is already stated more precisely
in the body (the measured 809 → 33 read cut) and in `tradeoffs:`.
