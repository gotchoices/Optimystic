----
description: A node that misses one commit to a shared table can keep reading that table forever at the version it last saw, answering confidently with data everyone else has moved past. It never asks anyone whether it is behind, so nothing catches it up and nothing reports a problem.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-p2p/src/repo/coordinator-repo.ts
difficulty: hard
repro: verified
severity: wrong-result
likelihood: likely
----

# A reader cannot tell that its view stopped advancing

## Filed by

Sereus, from `sereus/tickets/blocked/control-peer-row-refresh-invisible-to-third-node.md`.
This supersedes `1-stale-read-returned-as-authoritative-when-repair-cannot-converge` as the
description of that failure: the corroboration deadlock that ticket leads with **no longer
reproduces**, and what remains is a different mechanism at a different layer. Three Sereus
integration suites fail on it; one is deterministic.

## What happens

Three nodes A, B, C share a table. C writes a row, then writes a second revision of that row.
B misses the second write. From then on **every** read B makes of that table returns the first
revision, indefinitely — 156 identical reads over a 45-second window in the measurement below,
while A and C both hold and serve the newer one. B raises nothing, logs nothing, and goes on
committing its own writes to that table successfully, on a lineage that does not contain C's
revision.

The reason is in `TransactorSource.tryGet`, which passes `context: this.actionContext` on every
read. A collection sitting at revision *n* asks its peers for *revision n's view* and is
correctly given it. Nothing in that loop ever asks the question "is *n* still the latest?", so a
view that stops advancing has no way to notice, and the read-repair machinery — which only runs
when a fetch comes back short — is never invoked at all.

## Measurement, 2026-09-05, `@optimystic/db-p2p` 0.28.0

One instrumented boot of `control-cohort-edge-carries-data`, with
`DEBUG='optimystic:db-p2p:*,optimystic:db-core:collection*,sereus:cadre:node'`:

| | |
| --- | --- |
| B's reads of C's row | 156, all `updatedAt=1788660197517, addrs=[], sig=(empty)` — the first revision |
| C's later commits of that row | `updatedAt=…198257` and `…198548`, each with an address, valid signature |
| `cluster-fetch:no-quorum` on that block | **0** |
| `read-repair-triggered` on that block | **0** |

So this is emphatically **not** the earlier "repair cannot reach quorum" story. That shape is
gone: the certified-claims chain (`4`, `4.1`, `4.2`, `2-single-signer-proof-outweighs-corroboration`)
is visibly working in the same run — `certified-claims accept-unanchored block=default/CadrePeer
rev=1 … signers=1`. The repair path simply never gets a chance, because the reader believes it is
current.

For contrast, the same run shows 466 `no-quorum` declines on **other** blocks
(`default/Revocation`, `default/Strand`), every one of them `cohortPeers=2 holders=0 required=2`
— tables the scenario never writes. Those are a separate question and possibly benign; they are
not this bug, and anyone re-measuring should not count them as evidence for it.

## Expected behaviour

A reader must be able to find out that its view is stale, and the discovery must not depend on a
fetch happening to come back short. Two shapes, either acceptable:

- **Notice and advance.** A read consults the block's cohort for the current revision (or a
  cheap "is *n* current?" probe) and re-reads at the newer one when it exists.
- **Refuse.** A view that cannot establish it is current stops answering, so the caller gets an
  error instead of confidently wrong data.

Whichever is chosen, the cost has to be bounded — a probe on every read of a hot collection is
not obviously affordable, and that trade-off is the substance of this ticket rather than an
afterthought. A lease or a piggybacked revision hint on traffic the node already exchanges are
both worth considering.

## Interaction with existing work

- `debt-repair-cannot-tell-a-fork-from-a-lagging-cohort` (backlog) is the *other* side of this:
  once a stalled reader does go looking, telling "I am behind" from "I forked" is exactly the
  distinction that ticket says the evidence cannot currently express.
- Sereus's `forked-control-collection-sync-livelocks` is very likely the same defect seen from
  its loud side (`SyncRetryExhaustedError` instead of silence); both should clear together.
- The writer side is unaffected by this ticket and is deliberately permissive in the reporting
  deployment: control writes there commit on a downsized cohort, so a stalled reader is also a
  successful writer, which is what turns a stale view into a durable fork.

## Reproduce

From the Sereus checkout, `packages/integration-tests` — deterministic, 5 of 5 runs:

```
npx vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts
```

The gate that fails is `bootControlTrio` step 6, "B resolves C's signed CadrePeer address
record", after 45 s. `packages/cadre-core/src/cadre-node.ts` already logs the revision, address
count and signature prefix on every failed resolution, which is what makes the stall legible
without new instrumentation.
