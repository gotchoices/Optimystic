description: A stress test in a separate sister project times out when one peer only writes and another only counts, and we still don't know why; before we can even retry it, that project needs a small compatibility fix to start up again.
prereq:
files: (cross-repo: sereus — cadre-core/src/schema-verification.ts, convergence-stress harness)
difficulty: hard

## Why this exists

This is the residual, genuinely-open question split out from the review of
`optimystic-vtab-count-read-no-network-pull`. That ticket's investigation
**exonerated the optimystic side**: every read shape — including `count(*)` and
other aggregates — reaches `OptimysticVirtualTable.query()` and issues a network
pull (`collection.update()`), proven both by reading the source and by a regression
spec covering bare/aliased/`db.get`/PK-predicate/secondary-index/empty-table/
`distinct`/`sum`/`group by` shapes (`packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts`).

So the optimystic read path is **not** the cause of the symptom that started the
chain: in the sereus `convergence-stress` harness, a **blind** two-peer workload
(no reads inside the work loop — one peer writes, the other only polls `count(*)`
at the end) has its final poll loop time out at 30 s. With pull-on-read confirmed,
that timeout's true cause is unknown.

## The blocker (must clear first)

The symptom is currently **unreproducible at optimystic HEAD**: the sereus harness
fails to load because `cadre-core/src/schema-verification.ts` still calls the
pre-`8cea904` 4-arg `digest()` signature, so `signSchema` throws
`Unsupported output encoding: utf8` at module load. This is a **cross-repo
migration in sereus/cadre**, outside this (optimystic) repo — nothing in this repo
can unblock it.

## Scope (in order)

- **(a) Unblock the harness:** migrate the sereus `cadre-core` digest call sites
  (notably `schema-verification.ts` `signSchema`) to the post-`8cea904` `digest()`
  signature so the `convergence-stress` harness loads at current optimystic.
- **(b) Reproduce, then diagnose:** re-run the `convergence-stress` *"Interleaved
  Inserts"* scenario in its **blind** form (writer peer never reads; reader peer
  only polls `count(*)`). If the 30 s timeout reproduces, find the real cause —
  candidates to rule in/out: commit/append visibility latency in the shared
  transactor, the poll interval/budget vs. commit cadence, or a cadre-level sync
  gap distinct from the per-read pull. The optimystic read path is already ruled
  out; do **not** re-scope this onto that path.

## Notes

- Parked in `backlog/` (not `fix/`) because step (a) is blocked on a cross-repo
  change this repo can't make; promote to `fix/` once the sereus side is unblocked
  or the repro is reproducible here.
- Do not reopen `optimystic-vtab-count-read-no-network-pull` for this — that slug is
  complete and its conclusion (count pulls like every read) is independently
  verified.
