description: The database engine offers a way for a plugin to say "these schema changes belong together", and our plugin does not implement it, so a cold schema application is executed as many independent statements. On a desktop a cache hides the cost; on a phone it does not, and three separate app teams have now measured the same result — applying even a four-table schema takes minutes, because the number of round trips, not the cost of each one, is what grows.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (the module object — neither hook is defined on it)
  - packages/db-p2p/test/cached-raw-storage.spec.ts:508 (the read-amplification measurement that now reports the cut)
  - packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts (plugin-side read-cache coverage)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:314 (`withReadCache` — the mitigation that landed)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (the coordinated-path gates; measured baselines live here)
  - packages/quereus-plugin-optimystic/test/repro-issue8.mjs (the diagnostic harness the figures below came from)
difficulty: medium
tradeoffs: On Node the read cache already removed ~96% of the redundant reads, so the remaining win there is commit-count and round-trip batching rather than the amplification that made this urgent — and a reader looking only at Node figures would reasonably close this as an API-completeness item. The device evidence is what stops that: with the read-repair defect fixed and the reporters' own per-read cost cut by half, a cold apply still takes about five minutes per network create on real mid-range hardware, and one app's four-table schema does not finish at all. Building this means committing to a batch-scoped context through the plugin and the transactor, which is real surface area for a win nothing in this repo's own test environment can currently demonstrate.
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

## The device answer landed (2026-09-10), and it flips this ticket's scoping

The section above says the decisive datum is distinct `blockId` count versus line count deep into a run, and instructs the next reader not to scope the work until it arrives. **It arrived.** Three independent consumers now report device captures on `@optimystic/*` 0.29.0 and 1.0.0-beta.2, on both x86_64 emulators and real arm64 hardware. The dichotomy this ticket posed — "either cadre-core's founding path does far more work than the 22 declared objects, or something loops" — is settled in favour of the first, and the second is affirmatively ruled out.

### The loop hypothesis is dead, and one reporter retracted his own evidence for it

`kjeib` had reported that `default/Revocation` re-entered the armed read-repair exit in sub-second loops on 0.29.0 (179/229 "sub-window" repeats, minimum gap 8 ms). He withdrew that claim on real arm64 after testing it directly: of 254 `cluster-fetch:solo-self-skip` events on that block, **zero** were preceded by a `read-repair-triggered` line, and the totals rule it out independently — 290 triggers against 626 skips. Those were separate reads of a hot block, not re-entries of an unarmed window.

The retraction matters here because the measurement that produced the false claim was *gap timing between skips*, which cannot distinguish "one read re-entering because the window never armed" from "many distinct reads of the same block". `risavian` supplied the statistic that can, and both reporters now measure **zero** inside-window re-entries on 0.29.0. So nothing in the read-repair path explains the volume; the reads are real, distinct reads.

### Read *count* is the lever, and read *cost* provably is not

This is the strongest evidence the ticket has, and it came from an experiment nobody here would have run. `risavian` profiled their own React Native app and found Hermes ships no native `TextDecoder`, so every `KvRawStorage` read pays a JS-implemented UTF-8 decode inside `raw-store-codec.decodeJson` on top of the `JSON.parse`. Their polyfill was the single largest JS frame on device at ~25% of CPU. They rewrote it and cut that frame by **54%**.

End-to-end, one network create moved **6–16%** (~404–412 s to ~349–378 s).

A 54% cut in the largest identifiable per-read cost buying under a fifth of the operation says the cold-apply cost on this runtime is not dominated by how expensive each read is. It is dominated by **how many reads there are** — which is precisely what these hooks address and what a read cache structurally cannot, because a cache miss still pays a native bridge crossing and the round-trip count is what scales with schema size. Their words: "We had assumed our polyfill work would be the bigger win of the two; measured, it was not close."

### The volume, at last, in numbers

On 1.0.0-beta.2, applying a **four-table, zero-index** schema on real arm64: **626 cluster consults, 290 read-repair triggers, 56 commits** — with the read-repair path provably healthy on that same run. Four tables is about as small as a real schema gets.

A third consumer (`risavian`, VoteTorrent) does converge on real hardware, which is the useful control: it takes **~279–309 s per network create** with both the 0.29.0 fix and their decoder fix in place. Not a hang — just five minutes of coordinated cost for one create, on a foreground user-initiated action with a spinner in front of it.

### What this changes about scope

The "What remains" section below concludes that on Node the hooks are a correctness-of-API item rather than a performance one, and says to scope them that way **"unless the device answer comes back saying otherwise."** It came back saying otherwise. Scope this as a performance item whose target is the coordinated path on a high-latency substrate, and treat the Node figures as the floor they are: `withReadCache` removes the amplification above the storage seam, and the per-object `ITransactor.get` growth it absorbs (41 / 55 / 81 at 22 / 67 / 250 objects) is exactly the cost that survives on a backend where every miss crosses a bridge.

Two consequences for the design pass:

- **A gate that measures only driver calls below a read cache will not see this.** `cold-apply-cost.spec.ts` gate 1 counts calls that reach the driver; the device cost is round trips, including cache misses that still cross into native storage. Whatever gate this work lands with needs to count substrate round trips per migration, not post-cache driver calls.
- **The reporters asked what to plan around, and that question outlives this ticket.** Both want to know whether the coordinated path is *intended* to be cheap for a cohort that is provably just this node, or whether multi-minute cold founding is the expected cost for now. That is a roadmap answer a human owes them on the issue; it is not a blocker for designing the hooks, and the hooks are worth building whichever way it is answered.

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
