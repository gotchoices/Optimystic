description: A mesh test fixture sometimes fails before the test starts, because it looks for block ids that one particular node is responsible for, and with randomly generated peer ids that node's share of the ring is occasionally too small to find three among ten thousand tries.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (`blockIdsInCohortOf`)
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts (five callers, all passing `mesh.nodes[0]`)
  - packages/db-p2p/test/mesh-sanity.spec.ts (one caller)
  - packages/db-p2p/test/util/seeded-ring.ts (an existing way to give a mesh a deterministic ring)
difficulty: easy
repro: verified
severity: edge-case
likelihood: occasional
----
# `blockIdsInCohortOf` can find too few ids on a random ring

## What happens

`yarn check` on 2026-09-25 failed once in db-p2p (3113 passing, 1 failing):

```
CoordinatorRepo Integration (TEST-5.3.1)
  sequential transactions (revision tracking)
    should track revision state across multiple commits:
Error: blockIdsInCohortOf: only 1 of 3 ids with prefix block-rev place 12D3KooWQ5z4jrKYLSsxxdUoHyjCArNKfhmGt7uLhWGVuSHqELp7 in their cohort
```

Rerunning `test/coordinator-repo-integration.spec.ts` alone ten times failed once. The change under test that day
(the plugin's Quereus 4.20 catalog work) touched nothing in db-p2p; the same suite had passed in full an hour earlier.

`blockIdsInCohortOf` tries `${prefix}-0` … `${prefix}-9999` and keeps the ids whose cohort includes the given node.
Peer ids are random per run, so the arc of the ring that maps to `mesh.nodes[0]` varies, and on some runs it is small
enough that fewer than `count` of the 10,000 candidates land in it. The test then fails in its setup, which says
nothing about the code under test.

## Expected

The fixture never fails for ring-placement luck. Pick whichever fix fits the callers best:

- Make the ring deterministic for these specs (`test/util/seeded-ring.ts` exists for this), so the node's arc is known
  and wide enough.
- Or choose the node from the ring rather than hard-coding `mesh.nodes[0]`: use the node that the most candidate ids
  place in their cohort. None of the callers needs a specific node, only "a node responsible for these blocks".

Whichever is chosen, the throw stays: a fixture that cannot produce what the test needs must still say so, never
return fewer ids. Confirm by running the spec repeatedly (for example 30 times) with no failure. Do not weaken or skip
any assertion in the callers.
