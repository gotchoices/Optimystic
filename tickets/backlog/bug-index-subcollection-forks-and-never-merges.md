----
description: Two machines writing one secondary-index key each end up with their own private version of the index, permanently. The attribution added yesterday proves it: the two copies hold different actions from a shared starting point and never reconcile, while the main table of that same table converges to a byte-identical action in the same instant.
prereq:
files:
  - packages/db-core/src/collection/collection.ts (updateInternal ~246 — the refresh that reports success without closing the gap)
  - packages/db-core/src/log/log.ts (getFrom ~173 — the walk whose result is adopted)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (logIndexSeek; the live arm ~845)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (logCommitCollections)
difficulty: hard
severity: silent-wrong-answer
likelihood: deterministic-in-the-reporting-repo
repro: measured downstream, not yet reproduced here
----

# The index sub-collection forks and never merges — the main collection of the same table does not

**This answers the question `index-trace-cannot-tell-a-forked-collection-from-a-lagging-one` was
built to answer. It is a FORK.** Measured in `sereus` on 2026-08-27 with the `node=` attribution and
per-revision action ids that ticket added — the first run of that instrument anywhere, since this is
still the only place the defect reproduces.

Scenario: two machines concurrently insert into one table under one shared secondary-index key, then
each reads back through that index. Each machine's read returns only the row it wrote itself,
forever, with no error.

## The measurement

Both machines resolve the same collection id (`index:tree-open`, one id, both nodes).

**Both writes in case 1 depart from the same base — same revision AND same action id:**

```
commit:collections … revs=default/FormationUsage:none@none,…/index/FormationUsageByToken:1@-UzaWOQiXI12s6PU5PE5lA node=cREUdA
commit:collections … revs=default/FormationUsage:none@none,…/index/FormationUsageByToken:1@-UzaWOQiXI12s6PU5PE5lA node=s7s6dQ
```

**At the failing read, the main collection has converged and the index has not:**

| | node `s7s6dQ` | node `cREUdA` |
| --- | --- | --- |
| `main_rev=` | `2@fR1TfGRxHLN_Icl0ZK-XIw` | `2@fR1TfGRxHLN_Icl0ZK-XIw` |
| `rev=` (index) | `3@qpIlrfyFciQszMpLcVLSGA` | `2@vR5WcYtFvwoW2nYPa8BqCg` |
| `matched=` | 1 | 1 |
| `arm=` | live | live |

Case 2 repeats it on the same pair: `main_rev=4@RcFaAT8zpfk2WP9CrpASwg` on **both**, index
`4@8K0ee3vf3i7d4NoCtniNoQ` versus `3@Hwfkd1W9GYYk9npZ7mch-w`.

## Why this is a fork and not a lag

A lagging follower sits at a lower revision holding the **same** action the leader held at that
revision. These hold **different** actions, from a common ancestor both of them named
(`1@-UzaWOQiXI12s6PU5PE5lA`), and the divergence persists across a second case rather than closing.

The control is in the same line of output and is what makes this airtight: **the main table
collection of that same table converges to a byte-identical action id on both machines, at the same
instant, under the same writes.** Whatever reconciles the main collection is not reconciling the
index sub-collection. That also retires the last "maybe it is just slow" reading — nothing here is
waiting on the network, because the sibling collection got there.

`arm=live` on every line above means `update()` ran on both trees immediately before the descent,
and node `s7s6dQ` emitted 111 of these over a 30 s poll without its index revision moving once.

## Where to look

`a-refresh-that-fails-to-close-a-known-gap-says-nothing` (complete) already named the site, and this
measurement says that silence is hiding a real event rather than a benign no-op:
`Collection.update()` reads the tail's `latest` onto a throwaway `TransactorSource`, advances only
as far as `Log.getFrom` reports, and returns normally when that walk comes up short. For a forked
collection the walk **cannot** report the other branch — so the interesting question is what the log
tail says on each machine and why the two branches never become one. The diagnostic that ticket adds
(say something when the gap fails to close) should fire on every one of these reads; if it does not,
that is itself a finding.

## Reproducing it

Still only reproducible downstream. `sereus` removed the index that exposed it (its seat cap counted
through the index and over-admitted without bound across machines), so the reproducer there is
switched off and restored by re-adding one schema line — the recipe is on
`tickets/blocked/secondary-index-seek-blind-to-sibling-rows.md` in that repo. The run above was
taken with it temporarily restored.

**Every `unique` constraint in a Quereus schema is enforced through such an index**, so this is not
confined to explicitly declared secondary indexes; a forked uniqueness index would let two machines
each admit a row the other considers a duplicate.
