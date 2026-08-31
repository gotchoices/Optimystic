description: The database engine offers a way for a plugin to say "these schema changes belong together", and our plugin does not implement it, so a cold schema application is executed as many independent statements. The read amplification this caused has since been fixed a different way, so what remains is the missing feature itself rather than the reported pain.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (the module object — neither hook is defined on it)
  - packages/db-p2p/test/cached-raw-storage.spec.ts:508 (the read-amplification measurement that now reports the cut)
  - packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts (plugin-side read-cache coverage)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:314 (`withReadCache` — the mitigation that landed)
difficulty: medium
severity: performance
likelihood: certain-on-cold-schema-apply
tradeoffs: The read cache already removed ~96% of the redundant reads the issue was filed about, so the remaining win is commit-count and round-trip batching rather than the amplification that made this urgent. A maintainer could reasonably leave this unimplemented until someone measures a cold apply that is still too slow.
----

# `beginSchemaBatch` / `endSchemaBatch` are still unimplemented — but the reported pain was fixed another way

## Reported

GitHub issue #8 (`risavian`), against `@optimystic/quereus-plugin-optimystic@0.17.0`. Open,
unanswered, filed a month ago. It is a careful report: it measured 13,025 raw-storage calls for one
cold `APPLY SCHEMA` over 54 tables + 13 indexes — **194 per created object, 89.3% provably
redundant** — and supplied a runnable reproduction using only published packages.

## Status at HEAD: half addressed, and it is worth being precise about which half

**The hooks are still absent.** `grep -rn "beginSchemaBatch\|endSchemaBatch"
packages/quereus-plugin-optimystic/src/` returns **zero hits**. Quereus lets a vtab module fold a
whole `APPLY SCHEMA` into one substrate commit through those optional hooks; our module implements
neither, so each DDL statement is executed with no batch context and the module is never told the
statements belong together. That is exactly as reported.

**The consequence the issue was filed about is largely gone.** The issue's own framing is that the
cost "turned out to be read amplification rather than commit count", and that is the part that has
since been fixed — by a different mechanism than the one requested. `withReadCache`
(`collection-factory.ts:314`) now fronts the raw store, and the cut is measured rather than asserted:
`cached-raw-storage.spec.ts:508` prints a before/after, most recently **809 reads → 33, a 95.9%
cut**.

So the reporter's diagnosis was right and their proposed fix is still unimplemented, while their
measured symptom has been addressed on a different axis. Both halves of that should be said plainly
when replying — crediting the report, and not implying we did what they asked.

## What remains

The batch hooks are still the better shape for the underlying problem, and they buy something the
read cache cannot: fewer *commits*, and one substrate round trip for a migration rather than one per
DDL. That matters on a distributed backend in a way it does not on a local one.

Before building it, **re-measure**. The issue's 13,025-call figure predates the read cache; the
current number is what should justify the work. If a cold apply is now acceptably fast, this is a
correctness-of-API item (we advertise a vtab module and silently decline an interface the engine
offers) rather than a performance one, and should be scoped accordingly.

## Reply owed

Issue #8 deserves an answer regardless of whether this is built: the reporter supplied measurements
and a reproduction, and the read-cache work that fixed their symptom shipped without anyone telling
them. Worth saying what landed, what did not, and what the current numbers are.
