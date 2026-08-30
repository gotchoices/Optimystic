----
description: When a machine in the cluster is given a checker for incoming writes, two situations make it quietly skip the check instead of refusing the write — a sender that leaves out the fields being checked, and a checker that crashes while checking.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts:1133-1200 (validatePendOperations — the guard and the unguarded call)
  - packages/db-core/src/network/struct.ts:30-52 (PendRequest — `transaction` and `operationsHash` are two independent optional fields)
  - packages/db-core/src/transaction/validator.ts (TransactionValidator.validate — the code that can throw)
  - packages/db-p2p/test/mesh-client-signature-enforcement.spec.ts (the mesh tier where both arms would be pinned)
  - packages/db-p2p/src/testing/mesh-harness.ts (MeshOptions.validatorFactory — how a test mesh arms a checker)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: Nothing in production hands a cluster member a checker today, so neither hole can currently be reached; a maintainer could reasonably fold both into whatever ticket finally turns checking on, rather than hardening a seam that nobody runs.
----

# Pend validation is skipped, not failed, in two situations

## Background in one paragraph

A machine that receives a proposed write (a "pend") is supposed to independently re-check it before
voting to approve: re-run the transaction, confirm it produces the operations the sender claimed,
and — where enforcement is switched on — confirm the client really signed it. The object that does
that re-checking is optional; a machine without one approves whatever it is sent. That optionality
is itself already tracked (`feat-no-deployment-validates-transactions-at-pend`, which is about
nothing in production ever supplying one).

This ticket is about something different: what happens on a machine that **does** have a checker.
There are two ways the check gets skipped rather than enforced. Both live at the same place —
`ClusterMember.validatePendOperations` in `packages/db-p2p/src/cluster/cluster-repo.ts` — which is
why they are one ticket.

## Arm one — a sender that omits the fields disables its own check

The check runs only when both of the sender-supplied fields are present:

```ts
if (this.validator && pendRequest.transaction && pendRequest.operationsHash) {
    // re-validate
}
```

Both fields come from the sender and both are optional on the wire. So a sender that simply leaves
`operationsHash` out (or leaves `transaction` out and sends bare block transforms) is not rejected —
it skips validation entirely and the machine votes approve. An untrusted party controls whether its
own write is checked.

Absence is not always suspicious: the single-collection write path
(`db-core/src/transactor/transactor-source.ts`) legitimately sends a pend with neither field, and
that is what the current guard exists to tolerate. So the fix is not "always require them"; it is
that a machine with a checker configured has to make an explicit, deliberate decision about a pend
that carries no checkable payload — accept it under a named policy, or refuse it — rather than
falling through the same branch as a well-formed one.

**Where this wants to be fixed (highest rung first):** the two fields are meaningful only together,
yet the type lets either exist without the other. Making them one optional pair on `PendRequest`
(e.g. a single optional `validation: { transaction, operationsHash }`) makes "transaction without
its hash" unrepresentable and collapses the guard to a single presence test with an explicit policy
attached. That is a `db-core` wire-shape change and the more valuable half of this ticket.

## Arm two — a checker that throws is silence, not a refusal

The call is not wrapped:

```ts
const result = await this.validator.validate(pendRequest.transaction, pendRequest.operationsHash);
```

`TransactionValidator.validate` re-executes the transaction through an engine. The realistic
production engine runs SQL against a live database; a parse error, a missing table, or an engine
fault throws rather than returning a verdict. Nothing between there and the cluster stream catches
it — `validatePendOperations` -> `evaluatePromise` -> `handlePromiseNeeded` -> `update` are all
uncaught.

The consequence is a posture inversion. A machine that *rejects* casts a signed reject vote, which
counts toward making the write fail. A machine that *throws* casts no vote at all, and to the
coordinator that is indistinguishable from a machine that is simply unreachable. So a cohort whose
checkers are failing degrades toward **not checking**, quietly, rather than toward refusing. The
same class of bug has already been fixed once at this exact function for a different cause: the
block-state read a few lines above used to throw out of the promise handler, and the comment there
now explains that the machine votes reject instead, "keeping the fail-closed posture with a signed
reason". The checker call never got the same treatment.

**Where this wants to be fixed:** a boundary invariant at the seam — `validatePendOperations`
catches, and turns a throw into a reject verdict with a reason naming the fault, exactly as the
block-unavailable branch already does. That retires the whole class rather than relying on every
future checker implementation being total.

There is a real decision inside this arm that a maintainer should make deliberately: is a broken
checker a reason to refuse the write (fail closed, safe but a bad checker can stall all writes) or a
reason to abstain (fail open, available but unenforced)? The current behaviour is the second one *by
accident*, which is the actual complaint — whichever posture is chosen should be chosen and written
down.

## Why this is filed as debt rather than a bug

Neither hole is reachable in any deployment today, because no deployment supplies a checker at all.
Both become live the moment one does. They are worth closing **before** that wiring lands, not
after, because the wiring ticket's whole premise is that turning checking on makes writes checked —
and with these two holes open, it partly does not.

## What would confirm it

Both arms are read-from-code, not observed. The mesh harness can now arm a checker per node
(`MeshOptions.validatorFactory`), so both are cheap to pin at the mesh tier:

- a pend that carries a `transaction` but no `operationsHash`, against a cohort of enforcing
  machines, currently succeeds;
- a checker whose `validate` throws currently produces an error escaping the cluster stream rather
  than a `ValidatorRejectionError` naming a refusal.

## How this surfaced

Found while reviewing `mesh-harness-signature-enforcement`, which wired the harness so a test mesh
can arm a checker for the first time and proved that an unsigned client is refused across a live
cluster. Both holes are ways that same guarantee can be sidestepped.
