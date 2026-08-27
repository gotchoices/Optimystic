description: Machines are supposed to check for themselves that a group of peers claiming to be responsible for a write really is the right group. On the first step of a write they do; on the two steps that follow, the message is missing the one field that check needs, so it silently falls back to a weaker rule — which can both wave through a group it should question and reject a write it already approved, leaving that write half-finished.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/mesh-partition-admission.spec.ts, packages/db-p2p/src/testing/mesh-harness.ts
difficulty: medium
repro: verified
----

# `commit` and `cancel` records carry no coordinating block id, so the admission gate's derived-view branch never runs on those paths

Found during `4-mesh-harness-admission-gate-partition-spec` (arming the mesh harness's real gates),
recorded as a verified defect in that run's handoff, and left unfiled when the run hit its token
budget. Filed here from an independent re-verification rather than from the handoff text — see the
correction at the bottom, which matters.

## The mechanism

`ClusterMember.admitMembership` (`cluster-repo.ts:975`) decides whether to admit a record's declared
membership. Its strong branch needs the member's **own** derived view of the cluster, produced by
`deriveExpectedClusterView` (`cluster-repo.ts:1099`):

```ts
const blockId = record.coordinatingBlockIds?.[0];
if (blockId === undefined) {
    return undefined;          // -> `confident` is false, always
}
```

`makeRecord` (`cluster-coordinator.ts:222`) fills that field straight off the message:

```ts
coordinatingBlockIds: message.coordinatingBlockIds,
```

And of the three message builders in `coordinator-repo.ts`, only one sets it:

| path | builder | sets `coordinatingBlockIds`? |
|---|---|---|
| `pend` | `coordinator-repo.ts:1225-1229` | **yes** (`options?.coordinatingBlockIds ?? allBlockIds`) |
| `commit` | `coordinator-repo.ts:1387-1390` | **no** |
| `cancel` | `coordinator-repo.ts:1345-1348` | **no** |

So on commit and cancel the field is `undefined`, the derived view is never obtained, `confident` is
never true, and admission always takes the low-confidence branch — regardless of how well the member
actually knows the topology. Each of those messages is its own cluster transaction whose promise
phase runs `evaluatePromise` → `admitMembership`, so this is not a path where the gate was meant to
be skipped; it is a path where the gate silently degrades.

## Why it matters, both directions

- **A write can strand pended-but-uncommitted.** A member with a confident view admits a legitimate
  downsized-but-sufficient cohort at pend (the derived-view branch), then at commit — same cohort,
  same record shape, no derived view — measures the declared set against the configuration-only floor
  instead and can reject it. `mesh-partition-admission.spec.ts` demonstrates the shape.
- **The gate is weaker exactly where it matters most.** Commit is the irreversible step, and it is the
  step that can never use the member's own topology knowledge. With `assumedClusterSize` unset,
  `admitMembership` explicitly preserves legacy approve (`cluster-repo.ts:1010-1012`), so on the commit
  path an unconfigured deployment admits any declared set that contains the member itself.

## Correction to the originating handoff — verify before repeating it

That handoff states the commit path "at the default `assumedClusterSize` (2) … admits essentially any
cohort". Reading the code, the admit-anything case is `assumedClusterSize === **undefined**`, not 2:
with the shipped defaults (`minAbsoluteClusterSize = 3`, `membershipAdmissionFraction = 0.75`,
`cluster-repo.ts:273-275`), an asserted size of 2 gives `admissionFloor(2) = max(3, 2) = 3`, which
*rejects* a two-member declared set rather than admitting it. Establish what `resolveClusterPolicy`
actually resolves before writing either claim into a commit message or a release note — the direction
of the bug is not in doubt, but the number in that sentence is.

## Preferred fix — make omission unrepresentable, don't patch two builders

`executeClusterTransaction(blockId, message, options)` (`cluster-coordinator.ts:246`) is *handed* the
coordinating block id — it is the same key it just used for `getClusterForBlock`, so the record's
field is derivable from an argument the caller cannot omit. Deriving it there
(`message.coordinatingBlockIds ?? [blockId]`, or equivalent) fixes commit and cancel together, leaves
`pend`'s multi-block list untouched, and means a future message builder cannot reintroduce the gap by
forgetting a field. Patching the two builders individually is the third instance of "a call site
forgot a field" in this package this week; prefer the rung that retires the class.

Whatever shape lands, the record's coordinating block must remain the block the coordinator actually
selected the cluster with — a fabricated or defaulted id would make the member derive a view for the
wrong key, which is worse than deriving none.

## Edge cases & interactions

- **Multi-block cancel/commit.** `cancel` runs one cluster transaction per block id and `commit` uses
  `blockIds[0]` for cluster selection; the record's coordinating id must match the transaction's own
  block, not the first of an unrelated list.
- **Solo short-circuit.** `pend`, `commit` and `cancel` all bypass the cluster path at `peerCount <= 1`
  (`cancel`'s was added in the same run that found this). Those never build a record and must stay
  unaffected.
- **`allowUnvalidatedSmallCluster`** returns before the derived view is consulted; single-node and
  local-dev behavior must not change.
- **Dispute evidence.** `dispute-service.ts:168,524,536` reads `record.coordinatingBlockIds` with
  fallbacks; populating it on two more paths changes which branch those take — check the collection id
  it resolves to is still right.
- **Confidence threshold and cost.** The derived view costs one `findCluster` per inbound record; this
  change adds that to commit and cancel. The existing NOTE at `deriveExpectedClusterView` already flags
  caching as the remedy if it shows up hot — re-read it rather than re-deriving the judgement.
- **Existing specs may encode the broken behavior.** Any test asserting that a commit is admitted where
  a pend was not (or vice versa) needs re-reading, not re-baselining.

## Tests

- A member with a confident derived view admits the same declared cohort at **pend and at commit** —
  the stranding case, which is the user-visible half.
- On commit and cancel, `record.coordinatingBlockIds` is populated and `deriveExpectedCluster` is
  actually invoked (assert the call, not just the outcome — the outcome can coincide).
- The partition cases in `mesh-partition-admission.spec.ts` extended to drive commit as well as pend,
  so a minority side is refused at both.
- Multi-block `cancel`: each per-block transaction carries its own block id.
- Unchanged behavior for `allowUnvalidatedSmallCluster` and for the `peerCount <= 1` short-circuits.
