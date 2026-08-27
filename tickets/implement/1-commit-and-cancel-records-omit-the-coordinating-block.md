description: Machines are supposed to check for themselves that a group of peers claiming to be responsible for a write really is the right group. On the first step of a write they do; on the two steps that follow, the message is missing the one field that check needs, so it silently falls back to a weaker rule — which can reject a write the same group was already allowed to start, leaving that write half-finished.
prereq:
files: packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-core/src/cluster/structs.ts, packages/db-core/src/network/repo-protocol.ts, packages/db-p2p/src/dispute/dispute-service.ts, packages/db-p2p/test/mesh-partition-admission.spec.ts, packages/db-p2p/test/cluster-membership-admission.spec.ts, packages/db-p2p/test/dispute.spec.ts
difficulty: medium
repro: verified
----

# The coordinating block id a member derives its cluster view from must be present on every path, and must be tied to the record's own operations

Fix-stage output for `fix/1-commit-and-cancel-records-omit-the-coordinating-block`. The mechanism in
that ticket is confirmed; this ticket adds the reproduction evidence, the empirically-checked fix
direction, and two more arms found at the same code sites during that verification.

## Reproduction (verified, not inferred)

`packages/db-p2p/test/mesh-partition-admission.spec.ts` already pins the defect as a passing test:
`a confident majority is allowed to proceed › commit path: the gate has no block to derive from, so
it falls back (KNOWN GAP)`. It asserts that a 3-peer majority whose **pend** was admitted has its
**commit** *refused* with `membership-not-admitted:low-confidence-downsize`.

```
cd packages/db-p2p && yarn test -- --grep "mesh partition — membership admission gate"
→ 7 passing
```

A throwaway one-line patch inside `ClusterCoordinator.executeClusterTransaction` — copying the
`blockId` argument onto the message when the message carries none — flips exactly that case and
nothing else:

```
7 passing → 6 passing, 1 failing
  commit path: … (KNOWN GAP):
  AssertionError: commit is refused by the fallback floor: expected undefined to be an instance of Error
```

The full `db-p2p` suite under the same throwaway patch: **1950 passing, 44 pending, 1 failing** — the
one above. So exactly one spec in the package encodes the broken behavior, and it does so knowingly
(its comment says it flips when this lands). The patch was reverted; the tree is unmodified.

## Why the field is missing

`ClusterMember.admitMembership` (`cluster-repo.ts:975`) needs the member's own derived view of the
cohort. `deriveExpectedClusterView` (`cluster-repo.ts:1099`) gives up when the record names no
coordinating block:

```ts
const blockId = record.coordinatingBlockIds?.[0];
if (blockId === undefined) return undefined;   // → `confident` is false, always
```

`makeRecord` (`cluster-coordinator.ts:222`) copies that field straight off the message, and of the
three `RepoMessage` builders in `coordinator-repo.ts` only `pend` (line 1225-1229) sets it — `cancel`
(1345-1348) and `commit` (1387-1390) do not. Commit and cancel each run their own cluster
transaction whose promise phase calls `evaluatePromise` → `admitMembership` (`cluster-repo.ts:938`),
so this is not a path where the gate was meant to be skipped; it is a path where it silently degrades
to the fallback branch no matter how well the member knows the topology.

**Correct numbers for a real node** (both prior corrections in the fix ticket are settled here; use
these, not the earlier ones): a node is assembled through `resolveClusterPolicy`
(`cluster-policy.ts:262-283`, called from `libp2p-node-base.ts:484`), which always sets
`minAbsoluteClusterSize = 2` (`cluster-policy.ts:53`) and `assumedClusterSize = declaredCohortSize ??
minAbsoluteClusterSize`. So on a real node `assumedClusterSize` is **never undefined**, the
"admit anything containing me" branch (`cluster-repo.ts:1007-1009`) is **unreachable** outside
direct-construction unit wiring, and an undeclared deployment's commit/cancel fallback floor is
`max(2, ceil(0.75 · 2)) = 2` — nominal gating rather than none. A deployment that declares its real
cohort size gets a proportional floor and is the case that actually strands writes: it admits the
cohort at pend via the derived view and can refuse the same cohort at commit against the larger
fallback floor. That is the user-visible half — a write left pended but never committed.

## Arm 1 — derive the coordinating block where it cannot be forgotten

`executeClusterTransaction(blockId, message, options)` (`cluster-coordinator.ts:246`) is *handed* the
coordinating block id: it is the same key it immediately passes to `getClusterForBlock`. Derive the
field there rather than patching two builders, so a future message builder cannot reintroduce the
gap by forgetting a field.

Put it on the **message**, before `createMessageHash`, not only on the record — see arm 2 for why.

```ts
const coordinated = message.coordinatingBlockIds
    ? message
    : { ...message, coordinatingBlockIds: [blockId] };
```

Two things that will bite if done carelessly:

- **Copy, never mutate.** `CoordinatorRepo.cancel` builds ONE message and hands the same object to N
  concurrent `executeClusterTransaction` calls (`coordinator-repo.ts:1356-1362`). Mutating it in
  place would let one block's id leak into another block's transaction. Build a new object.
- **The multi-block list on `pend` stays untouched.** `pend` deliberately declares the whole
  consolidated batch (`options?.coordinatingBlockIds ?? allBlockIds`); the `??` above preserves it.

Side effect worth having: multi-block `cancel` currently sends the *same* message for every block, so
two blocks with identical cohorts produce an identical `membershipDigest` and therefore an identical
`messageHash` — and `this.transactions.set(messageHash, …)` / `wasTransactionExecuted(messageHash)`
collide between two distinct in-flight transactions. Per-block coordinating ids make those hashes
distinct, which removes the collision. Don't "optimise" it back.

## Arm 2 — the gate must read the hash-covered copy

`validateRecord` (`cluster-repo.ts:647-679`) recomputes `computeClusterMessageHash(record.message,
digest)` and rejects a mismatch — and that hash is over `record.message` **only**
(`db-core/src/cluster/membership.ts:58-62`). The top-level `record.coordinatingBlockIds` is a bare
copy outside the hash, and it is the copy the gate reads today. Any relaying peer can rewrite it
without invalidating anything.

Preferred shape — one source of truth: **delete `coordinatingBlockIds` from `ClusterRecord`**
(`db-core/src/cluster/structs.ts:70`), drop the copy in `makeRecord`, and point every reader at
`record.message.coordinatingBlockIds`. Readers are `cluster-repo.ts:1103` and
`dispute-service.ts:168, 524, 536`, plus the record literals in
`test/cluster-membership-admission.spec.ts:50,58`, `test/dispute.spec.ts:52,112` and
`test/mesh-partition-admission.spec.ts:176,186`. If removing the field turns out to be wider than it
looks, the fallback is to keep the field but have the *gate* read `record.message.…`; say which you
chose and why.

Either way, check the three `dispute-service` lines: they resolve a collection id through
`record.coordinatingBlockIds?.[0] ?? …` fallbacks, and the field is now populated on two paths where
it used to be absent, so a different branch is taken. Confirm the id it lands on is still right.

## Arm 3 — bind the coordinating block to the record's own operations

Hashing the field makes it tamper-evident to *relays*, but the coordinator is the party the gate
exists to check, and the coordinator chooses the field and then computes the hash over it. Unbound,
a Byzantine coordinator declares a shrunken cohort `D` and names a coordinating block `X` whose real
cohort resembles `D`; each member derives `cohort(X)`, finds `kEst = |D|`, floor `max(2, ceil(0.75 ·
|D|))`, symmetric difference 0 — and admits. The gate is fully defeated, on the pend path, today.
Populating the field on two more paths widens that surface, so close it in the same change.

The invariant: **the coordinating block id must be one of the block ids the record's own operations
name.** `RepoMessage.operations` is a single-element tuple
(`db-core/src/network/repo-protocol.ts:3-13`), so the member can extract the ids directly —
`pend` → `blockIdsForTransforms(op.pend.transforms)` (already imported in `cluster-repo.ts:4`),
`commit` → `op.commit.blockIds`, `cancel` → `op.cancel.actionRef.blockIds`, `get` → `op.get.blockIds`,
`invalidate` → whatever that request names.

Every production caller satisfies it: the ids on `pend` are the batch's own consolidated blocks
(`network-transactor.ts:494-510` builds the payload *from* that list), `processBatches` re-batches on
retry without the field so `coordinator-repo.ts:1218` falls back to `allBlockIds`, and
`commit`/`cancel` derive from the request under arm 1.

On violation, treat the record as **not confident** (fall to the existing fallback branch) and log —
do not throw. A hard reject is defensible but changes `validateRecord`'s failure surface; failing
closed into the branch that already exists is the smaller, safer step. If arm 3 turns out to fight a
caller this ticket did not find, split it into its own ticket rather than weakening arms 1 and 2.

## Must not change

- **The `peerCount <= 1` short-circuits** in `pend` (1220), `cancel` (1357) and `commit` (1381) —
  these never build a record and must stay untouched.
- **`allowUnvalidatedSmallCluster`** returns at `cluster-repo.ts:986`, before the derived view is
  consulted. Single-node and local-dev behavior is unchanged.
- **Cost.** The derived view is one `findCluster` per inbound record; this adds that to the commit
  and cancel promise paths. The existing `NOTE:` at `deriveExpectedClusterView` already states the
  remedy (cache per `(blockId, short TTL)`) and the condition for reaching for it — read it rather
  than re-deriving the judgement, and do not add the cache here.

## Tests

The mesh tier's members are built from a resolved policy (`mesh-harness.ts` passes `consensusConfig:
policy`), so assertions written there exercise the floors a deployment actually sees. A member built
from bare `ClusterMember` constructor defaults exercises floors no node ever runs on — fine for
unit-level gate coverage, not for claims about the commit path.

- **The stranding case, both halves:** a confident cohort admitted at pend is admitted at **commit**
  too. This is the KNOWN-GAP case in `mesh-partition-admission.spec.ts` flipped from "refused" to
  "succeeds" — rewrite its comment as well; it currently explains the defect and names this ticket.
  The file header (lines 28-35) carries the same explanation and must go too.
- **Assert the call, not just the outcome:** on commit and on cancel the record names a coordinating
  block and `deriveExpectedCluster` is actually invoked. The outcome alone can coincide.
- **Partition cases driven through commit** as well as pend, so a minority side is refused at both.
- **Multi-block `cancel`:** each per-block transaction carries its own block id, and two blocks
  sharing a cohort no longer collide on one `messageHash`.
- **Arm 3:** a record whose coordinating block is not among its operations' block ids is judged
  not-confident (fallback floor), and the mismatch is logged.
- **Unchanged:** `allowUnvalidatedSmallCluster`, and the `peerCount <= 1` short-circuits on all three
  paths.

## TODO

- Derive the coordinating block id onto a **copy** of the message in
  `ClusterCoordinator.executeClusterTransaction`, before `createMessageHash`; preserve an
  already-present `coordinatingBlockIds`.
- Decide and apply arm 2's shape: remove `ClusterRecord.coordinatingBlockIds` and read
  `record.message.coordinatingBlockIds` everywhere (preferred), or read the message field from the
  gate only. Record the choice in the review handoff.
- Update `dispute-service.ts:168, 524, 536` for whichever shape landed, and confirm the collection id
  they resolve to is still correct now the field is populated on commit and cancel.
- Add the operations-to-coordinating-block binding check to `deriveExpectedClusterView`; fail closed
  to the existing not-confident branch and log the mismatch.
- Flip the KNOWN-GAP case in `mesh-partition-admission.spec.ts` to assert a successful commit; delete
  the "Known gap" section from the file header (lines 28-35) and the in-test explanation.
- Add the commit/cancel coverage listed above, including the `deriveExpectedCluster`-was-invoked
  assertion and the multi-block cancel case.
- Update record literals in `cluster-membership-admission.spec.ts`, `dispute.spec.ts` and
  `mesh-partition-admission.spec.ts` if the `ClusterRecord` field is removed.
- Update `docs/` where the admission gate's inputs are described, if the record shape changed.
- Run `yarn workspace @optimystic/db-p2p test` (baseline under the throwaway patch was 1950 passing /
  44 pending / 1 failing — that 1 is the case you flipped) and `yarn build && yarn typecheck` from
  the root.
