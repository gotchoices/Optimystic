description: When a machine asks a group of peers to co-sign a write, it points at the piece of data the write is about, but nothing checks that the pointer actually matches the write before it is sent — so a future coding slip there would make every write on that path fail outright at the receiving end, with no error at the source that says why.
files: packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-core/src/network/i-repo.ts, packages/db-core/src/transactor/network-transactor.ts
difficulty: medium
repro: static
severity: edge-case
likelihood: contrived
tradeoffs: Every sender is correct today (verified by reading all three call sites), so this buys nothing until someone changes one — and the natural fix moves a helper across a package boundary, which is more churn than a plain assertion would be.

# One side asserts a rule the other side is trusted to follow

## The rule

A record sent for cluster co-signing carries `coordinatingBlockIds` — the block whose peer cohort the
sender selected the co-signers from. Since the review ticket
`debt-absent-coordinating-block-downgrades-the-admission-gate` landed, a receiving member that can
derive its own cohort view **refuses the record outright** unless `coordinatingBlockIds[0]` names a
block the record's own operations touch. The refusal is right: it is what removes the sender's free
choice of which check every member runs.

The rule is therefore enforced entirely on the **receiving** side. The sending side — the single
choke point that stamps the field — does not check it.

## Where the two sides live

- **Receiver:** `ClusterMember.deriveExpectedClusterView` (`cluster/cluster-repo.ts`) compares
  `coordinatingBlockIds[0]` against `ClusterMember.getAffectedBlockIds(message.operations)`, a
  `private` method of that class.
- **Sender:** `ClusterCoordinator.executeClusterTransaction` (`repo/cluster-coordinator.ts` ~line 293)
  either stamps `[blockId]` from the cohort key it was handed, or preserves an already-present list
  verbatim. Neither branch consults the message's operations.

So the two sides use one definition of "blocks this record touches" only because one side never looks.

## Why it is worth closing

`coordinatingBlockIds` is not an internal detail of the coordinator: it is a public field of
`MessageOptions` (`db-core/src/network/i-repo.ts`), which any `IRepo.pend` caller may set.
`CoordinatorRepo.pend` passes it through verbatim to the choke point, and today the only caller that
sets it is `NetworkTransactor.consolidateCoordinators`, whose list is by construction a subset of the
batch's own transforms. A caller that sets a list drawn from anywhere else — a wider batch, a stale
list carried across a retry, a hand-built option in a new integration — produces records that every
capable member hard-rejects.

The blast radius changed with the review ticket. Before it, an unbound id degraded the member's check
to a weaker fallback: wrong, but writes still landed. Now the same slip fails the write outright, and
the only symptom at the sender is a transaction that could not assemble a super-majority — the reason
lives in N peers' reject strings, not in an exception where the mistake was made.

## Shape of the fix

The point of the ticket is the shared definition, not an assertion bolted onto one site. Concretely:

- Promote the affected-block extraction to one exported helper both packages can call, so "the blocks
  this message touches" has exactly one implementation (it already claims to, in its own doc comment).
  Today it is `private` on `ClusterMember`, so the sender physically cannot reuse it.
- At the choke point, check the id it is about to stamp or preserve against that helper, and fail the
  transaction there with a message naming the offending id and the blocks the operations actually
  name.

Whether the check should throw or repair (drop an unbound list and stamp the cohort key instead) is
an open question for whoever picks this up: throwing surfaces the mistake, repairing keeps a
mis-built caller working. Throwing is the better default for a defect no correct caller can hit.

## What would confirm the gap

There is no test that a coordinator cannot emit a record its own members refuse. A generalized test
at the choke point — drive `pend`, `commit` and `cancel` and assert the stamped/preserved
`coordinatingBlockIds[0]` is always in the extracted affected set — is the regression guard this
ticket is really about, and it would have made the review's "no honest sender loses its block" claim
mechanical instead of argued.

## Triage note (backlog gardening, 2026-09-01)

`severity: edge-case` / `likelihood: contrived` / `repro: static`, derived from the body:

- **`edge-case`** — deliberately the lower reading. The consequence of a mis-stamped id is that
  capable members hard-reject the record, so the write *fails* rather than landing wrongly. Nothing
  is corrupted and no wrong answer is returned; the cost is an opaque failure whose reason lives in
  N peers' reject strings.
- **`contrived`** — all three current senders are correct (verified by reading every call site), and
  the field is only reachable by a caller that sets `MessageOptions.coordinatingBlockIds` from
  somewhere other than the batch's own transforms.
- **`repro: static`** — read from the code. What would confirm it: the generalized choke-point test
  this ticket asks for, driving `pend` / `commit` / `cancel` with a deliberately unbound id.
