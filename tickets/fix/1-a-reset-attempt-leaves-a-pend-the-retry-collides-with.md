----
description: When a write is interrupted by a brief network fault, it leaves a "write in progress" marker behind. The caller's retry then collides with that marker — its own — and every further attempt is rejected, so a fault that should have been ridden out fails the write permanently.
files: packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-p2p/src/cluster/cluster-member.ts
difficulty: medium
repro: verified
severity: wrong-result
likelihood: likely
----

# A reset attempt leaves a pend that the caller's retry collides with

## Filed by

Sereus, from `sereus/tickets/blocked/control-write-retry-does-not-absorb-a-transient-stream-reset.md`.
Related to `torn-commit-must-cancel-the-blocks-it-abandoned` (complete): same pending-record
lifetime problem, different arm. That ticket fixed the *tolerated sweep* path and recorded, as a
deliberate exclusion, that "the tail's own failure path still leaves the cancel to its caller".
This is that exclusion, measured — the caller cannot discharge the obligation.

## The chain, measured

Sereus injects exactly two transient stream resets on one cohort member's repo protocol, then has
a node update its own row. The caller retries up to three times and classifies correctly
(`sereus:cadre:control-db` retry log, one run):

| attempt | cause reported |
| --- | --- |
| 1 | `The stream has been reset` — injected reset #1 |
| 2 | `Transaction rejected by validators (1/3 rejected): 12D3KooWKtSZ…: pending conflict: block … held by unresolved action(s)` |
| 3 | same pending conflict → `failed after 3/3 attempt(s)` |

Only two resets are injected and the injector passes everything through afterwards, so attempt 3
meets a clean handler. It fails anyway. **Attempt 1's abort left a pending record on the
validator, and attempts 2 and 3 are rejected by it — the write is colliding with itself.**

A pend is removed by a client cancel, a divergence-shaped commit refusal, or a forward write of
the same action id. A caller that simply retries produces none of those, so no number of retries
can clear it; the write fails permanently on a fault that was, by construction, transient and
self-healing.

## Why the caller cannot fix it

The obligation named in `torn-commit-must-cancel-the-blocks-it-abandoned` — "the tail's failure
path leaves the cancel to its caller" — is not dischargeable from outside. The caller here is an
application-level retry loop reached through the Quereus plugin; it holds no handle on the action
whose pend needs cancelling, and `NetworkTransactor.cancel` is not on any surface it can reach.
Retrying under a fresh action id does not help either: the collision is on the *block*, not the
action.

## Expected behaviour

A commit attempt that fails in a transport-shaped way should leave no pend that its own retry will
collide with. Concretely, one of:

- the failing attempt cancels the pends it created before returning the retryable error — the same
  repair `cancelAbandonedSweepBlocks` already performs for the sweep arm, applied to the tail
  path; or
- the retry is recognised as the same writer and permitted to supersede its own pending record;
  or, weakest,
- the error names the pend and exposes the cancel, so a caller that *can* reach it is able to
  discharge the obligation the docs assign to it.

The first is the shape most consistent with the invariant that ticket established: *when a commit
returns, every block in the request is either committed or has had its pending record cancelled.*
Today that invariant holds for the tolerated sweep and not for a reset on the tail.

## Reproduce

From the Sereus checkout, `packages/integration-tests` — 4 runs in 5:

```
npx vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts
```

The case is "absorbs an injected transient stream reset: the write commits on a retry attempt".
Its retry decisions are printed by the scenario itself (`printRetryDecisions`), which is where the
table above comes from — no extra instrumentation needed. A run that reports "7 skipped" died at
the boot gate instead and says nothing about this (that is
`1-a-reader-cannot-tell-its-view-stopped-advancing`).

Note this file passed 7/7 twice on 2026-08-21 against 0.27.x and fails this way on 0.28.0, so a
bisect across the torn-commit chain is likely to land on the change that moved it.
