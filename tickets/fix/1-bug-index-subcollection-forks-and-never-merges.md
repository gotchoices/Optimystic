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

## Steer for this fix pass (added on promotion)

**Do not spend this run on a seventh two-node reproduction attempt.** Six have already been made and
all reproduced nothing; that dead end is recorded on
`tickets/blocked/secondary-index-repro-exhausted-upstream.md`, which asks a human whether black-box
repro attempts should continue here at all. That question is still open and this ticket does not
depend on its answer.

What changed since those attempts is that the mechanism is now named rather than guessed: two
machines commit from one shared base (`1@-UzaWOQiXI12s6PU5PE5lA`) into the index sub-collection and
never converge, while the **main** collection of the same table converges byte-identically in the
same instant under the same writes. That control is the whole value of the measurement — it turns
"two machines disagree" into "one reconciliation path works and its sibling does not", which is a
question about this repo's code and answerable here without a distributed harness.

So work it white-box, in this order:

1. **Find what differs between the two paths.** The main collection and the index sub-collection
   both go through `Collection.update()` / `Log.getFrom`. Establish what is different about the
   index sub-collection's tail, header, or commit path such that the same walk closes the gap for
   one and not the other. A single-process test that drives two `Collection` handles over one
   transactor against one collection id may well be enough to exhibit it — that is not the
   two-machine harness that failed, and is worth trying before anything heavier.
2. **Check the diagnostic fires.** `a-refresh-that-fails-to-close-a-known-gap-says-nothing`
   (complete) added a signal for a refresh that returns without closing a known gap. It should fire
   on every one of the 111 reads described above. If that code path cannot fire for a forked
   collection, say so — that is a finding about the diagnostic, and it is the reason this went
   unseen.
3. **Only then consider a reproduction.** If steps 1-2 land a hypothesis, write the narrowest test
   that pins *it*, not the end-to-end scenario.

If the mechanism turns out not to be reachable from this repo's own code — i.e. the divergence
requires the downstream wiring — that is a real outcome: say it explicitly and route the ticket to
`blocked/` referencing `secondary-index-repro-exhausted-upstream`, rather than filing an implement
ticket on a hypothesis nothing here can test.
