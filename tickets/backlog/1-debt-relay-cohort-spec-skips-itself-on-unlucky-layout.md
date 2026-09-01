description: The only test that exercises a write whose inter-coordinator promise crosses a relay decides at runtime whether to run at all, based on a random peer-id layout. When the layout is unlucky the test skips itself and the suite still reports green, so the capability the release notes lead with can go unverified without anyone noticing.
prereq:
files:
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts:148 (the `this.skip()` that fires when the keyspace probe never places B in A's cohort)
  - packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts:105-121 (the comment explaining why the *previous* bimodal skip was removed — same failure mode, different precondition)
difficulty: medium
severity: edge-case
likelihood: normal-use
tradeoffs: Making cohort membership deterministic means constructing peer ids or coordinates for the test rather than taking whatever libp2p generates, which couples the spec to the keyspace layout it is meant to be agnostic about. The alternative — keep probing but fail instead of skip — trades a silent gap for a flaky red. Either is better than the current silent green, but which one is a judgement call.
----

# The relay-crossing write spec skips itself, and a skipped run looks identical to a passing one

## What was observed

Two consecutive full-gate runs on an unchanged working tree:

```
night-check-1:  30 passing   2 pending
night-check-2:  29 passing   3 pending
```

`git log <base>..HEAD -- packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts`
is **empty** for that range — the spec file did not change. The test moved from passing to pending
on its own.

## Why

The spec needs a block id whose cohort spans both coordinators, where B is reachable only through
the relay. It searches the keyspace for such a candidate, and if the search comes up empty:

```ts
// No probed keyspace placed the relay-only coordinator B in A's cohort — the
// relayed inter-coordinator promise wouldn't be exercised, so there is nothing
// for this spec to assert. Skip rather than assert a vacuous all-direct write.
if (!blockId) {
    this.skip();
    return;
}
```

Peer ids are generated fresh per run, so whether the search succeeds is a property of that run's
random layout. The relay is itself a FRET participant in the keyspace and competes for cohort
slots, which is what makes the search fail often enough to see twice in two runs.

The reasoning behind the skip is sound as far as it goes — asserting a vacuous all-direct write
would be worse than asserting nothing. The problem is what the skip is indistinguishable from.

## Why this one matters more than a normal flaky skip

This is the only test that exercises a write whose second promise crosses a relay. That path is
the headline claim of the current release notes ("relay-only peers now work in both directions").
A silent skip here means the suite can go green on a build where that capability is broken.

Note also that the comment at :105-121 records removing an *earlier* bimodal `this.skip()` from
this same spec, for this same reason. The precondition moved; the failure mode did not.

## Acceptance

Whether the relayed promise is exercised must not depend on the run's random layout. Either:

- construct the peer ids / coordinates so B is guaranteed to land in A's cohort, and delete the
  search loop; or
- keep the search and make exhausting it a **failure**, not a skip — a run that could not
  exercise the relayed promise has not verified the thing this spec exists to verify.

A fix that merely widens the search (more candidates, more retries) is not a fix: it lowers the
skip rate without removing the silent-green outcome, and the previous precondition already
demonstrates that lowering the rate is not the same as closing the hole.

Whichever route, the spec must be observed to actually run — a `pending` count for this suite that
varies between two runs of an unchanged tree is the symptom to watch.

## Triage note (backlog gardening, 2026-09-01)

`severity:` / `likelihood:` previously read `coverage-integrity` / `observed-twice-in-two-consecutive-gate-runs`,
which are not values the triage vocabulary defines. Normalized to `edge-case` / `normal-use`:

- **`edge-case`, not `wrong-result`** — deliberately the lower of the two readings. A skipped test
  causes no user-visible effect by itself; the wrong result it could hide (a broken relay-crossing
  write) is hypothetical until someone breaks that path. Rank this ticket on the *frequency* of the
  silent green, not on the severity of what it might one day conceal.
- **`normal-use`** — the skip fires on an ordinary run of the suite with no special setup, and was
  observed on two consecutive runs of an unchanged tree.

The observed-frequency detail is not lost: it is recorded verbatim under "What was observed" above.
