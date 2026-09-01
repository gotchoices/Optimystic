description: A machine that has been given a checker for incoming writes can be talked out of using it — a sender that leaves out the fields being checked gets waved through, and a checker that crashes casts no vote at all instead of refusing.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts:1318-1324 (the guard and the unguarded validate call)
  - packages/db-p2p/src/cluster/cluster-repo.ts:2196-2201 (recordPriority — also reads pend.transaction)
  - packages/db-p2p/src/storage/storage-repo.ts:475-487 (the identical two-field guard, storage tier)
  - packages/db-core/src/network/struct.ts:30-52 (PendRequest — the two independent optional fields)
  - packages/db-core/src/transaction/coordinator.ts:1073-1081 (pendCollection — the only producer of both fields)
  - packages/db-core/src/transactor/transactor-source.ts:148 (the single-collection pend that legitimately carries neither)
  - packages/db-core/src/cluster/structs.ts:186-192 (ClusterConsensusConfig — where the new policy flag goes)
  - packages/db-p2p/src/testing/mesh-harness.ts:80 (MeshOptions.validatorFactory — arms a checker per node)
  - packages/db-p2p/test/mesh-client-signature-enforcement.spec.ts (the mesh tier both arms get pinned in)
  - packages/db-p2p/test/support/client-tx-signature.ts (makeValidator / verifier / emptyOpsHash / buildUnsignedTx)
repro: verified
difficulty: hard
----

# Pend validation must fail closed, not fall through

## Background in one paragraph

A cluster member that receives a proposed write (a "pend") is meant to independently re-check it
before signing an approve vote: re-run the transaction, confirm it produces the operations the
sender claimed, and — where enforcement is on — confirm the client really signed it. The object that
does that re-checking, `ITransactionValidator`, is optional; a member without one approves whatever
it is sent. That optionality is separately tracked (backlog
`feat-no-deployment-validates-transactions-at-pend`, about nothing in production ever supplying
one). **This ticket is about a member that DOES have one**, and the two ways the check gets skipped
rather than enforced. Both resolve at `ClusterMember.validatePendOperations`
(`packages/db-p2p/src/cluster/cluster-repo.ts:1235`), which is why they are one ticket.

## What was measured

Both arms were reproduced at the mesh tier on a throwaway spec (written, run, deleted — the exact
code is reproduced under *Tests to write* below so nothing is lost). Command:

```
cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/<spec>.spec.ts" --reporter spec
```

Observed against a 3-node mesh where **every** node has a signature-enforcing validator, sending an
**unsigned** transaction:

| case | result |
| --- | --- |
| `transaction` + `operationsHash` both sent | `ValidatorRejectionError: Transaction rejected by validators (3/3 rejected): … Missing client signature` — correct |
| `transaction` sent, `operationsHash` omitted | **PEND SUCCEEDED** — the unsigned write was approved by all three enforcing members |
| validator whose `validate()` throws | `Error: Failed to get super-majority: 0/3 approvals (needed 3, 0 rejections)` — not a `ValidatorRejectionError`, and **zero** rejections recorded |

## Arm one — an omitted field disables the sender's own check

```ts
// cluster-repo.ts:1319
if (this.validator && pendRequest.transaction && pendRequest.operationsHash) {
    const result = await this.validator.validate(pendRequest.transaction, pendRequest.operationsHash);
```

Both fields are sender-supplied and independently optional on the wire, so omitting either skips
validation entirely and the member votes approve. An untrusted party decides whether its own write
gets checked. `StorageRepo.pend` (`storage-repo.ts:477`) carries the byte-identical guard against
its `validatePend` hook — same hole, second site, same fix.

Absence is not always hostile: the single-collection write path
(`transactor-source.ts:148`, `Collection.sync`) legitimately sends a pend with neither field, and
tolerating that is why the guard exists. The fix is therefore **not** "always require them" — it is
that a member with a checker configured makes an explicit, named decision about a pend carrying no
checkable payload, instead of falling through the same branch as a well-formed one.

### Root cause: the two fields are one fact modelled as two

```ts
// db-core/src/network/struct.ts — today
transaction?: Transaction;
operationsHash?: string;
```

"transaction without its hash" is a state the type permits and no producer ever creates
(`TransactionCoordinator.pendCollection` is the only producer and always sets both). Collapse them
into one optional pair so the bad state is unrepresentable and the guard becomes a single presence
test:

```ts
/**
 * Present only on the multi-collection path (TransactionCoordinator.pendCollection): the
 * transaction to re-execute plus the hash of ALL operations across all blocks it must produce.
 * Absent on the single-collection Collection.sync path, which carries bare transforms and is
 * therefore not re-checkable — see ClusterConsensusConfig.unvalidatablePendPolicy.
 */
validation?: {
    transaction: Transaction;
    operationsHash: string;
};
```

`superclusterNominees` stays where it is; do not fold it in.

### The policy, named

Add to `ClusterConsensusConfig` (`db-core/src/cluster/structs.ts`):

```ts
/**
 * What a member WITH a validator does with a pend that carries no `validation` payload — the
 * single-collection (Collection.sync) shape, which has no transaction to re-execute.
 * 'accept' (default) preserves today's behaviour. 'reject' is the fail-closed posture for a
 * deployment that has decided every write must be re-checkable; it REFUSES Collection.sync
 * writes, which is the point, not a bug.
 */
unvalidatablePendPolicy?: 'accept' | 'reject';
```

Default `'accept'` — no deployment enforces today, so a `'reject'` default would break
`Collection.sync` everywhere for a guarantee nobody has yet asked for. The value of this arm is that
the choice becomes a written, logged, testable decision rather than an accident of two optional
fields. Emit a log line on **both** branches (`cluster-member:pend-unvalidatable`, carrying the
policy and the actionId) so an operator can see how much of their traffic is unchecked. When
rejecting, use a stable exported reason constant in the same style as `MEMBERSHIP_NOT_ADMITTED` /
`CONTENT_DIGEST_MISMATCH` — suggest `PEND_NOT_VALIDATABLE = 'pend-not-validatable'`. Reject reasons
are folded into the signed vote payload, so keep the string plain prose with no structured fields.

### Ripple: `recordPriority` also reads `pend.transaction`

`cluster-repo.ts:2199` reads `op.pend.transaction?.priority ?? op.pend.priority` for the race
tiebreak. It must become `op.pend.validation?.transaction.priority ?? op.pend.priority`. Miss this
and multi-collection writes silently lose their aged priority — a fairness regression with no test
failure attached to it, so change it in the same commit.

### Wire compatibility

This changes the shape of a field inside `RepoMessage.operations`, which is hashed into
`messageHash` and folded into every signed vote. A mixed-version cohort will therefore disagree —
an old member sees `validation` as an unknown field, finds no `transaction`, and takes the
unvalidatable branch. There is no protocol version negotiation to hang a migration off. Given
nothing in production supplies a validator at all, treat this as a clean break rather than building
a dual-read compatibility shim, and say so explicitly in the review handoff.

## Arm two — a checker that throws casts no vote

The `validate` call is not wrapped. `TransactionValidator.validate`
(`db-core/src/transaction/validator.ts`) re-executes the transaction through an engine; the
realistic production engine runs SQL against a live database, where a parse error, a missing table
or an engine fault throws rather than returning a verdict. Nothing between there and the cluster
stream catches it — `validatePendOperations` → `evaluatePromise` → `handlePromiseNeeded` →
`processUpdate` → `update` are all uncaught, so the throw escapes the member entirely and the
coordinator records **no vote**.

### Correcting the fix ticket's framing

The fix ticket claimed a cohort of failing checkers "degrades toward not checking". Measurement says
otherwise, and the implementer should not go looking for the stronger effect: an abstaining member
contributes no *approval* either, so a throw can never turn a refusal into an acceptance. Worked
through the shipped arithmetic (`superMajority = ceil(n·0.75)`,
`maxAllowedRejections = n − superMajority`), every cohort mix yields the same accept/refuse outcome
whether the enforcing member throws or rejects. What is actually lost is:

- **Classification.** A reject surfaces as `ValidatorRejectionError`, which
  `CoordinatorRepo.classifyStaleRejection` / `classifyPendingConflictRejection` inspect and the
  writer reads as a hard rejection. A throw surfaces as the generic
  `Failed to get super-majority: 0/3 approvals` — indistinguishable from an unreachable cohort, so a
  writer retries a permanently invalid transaction until its budget runs out.
- **Evidence.** No signed `rejectReason` means nothing lands in
  `ClusterRecord.disputeEvidence.rejectReasons`, so the dispute path has nothing to work with and an
  operator has no record of *why*.
- **Legibility.** A broken checker is invisible; it looks exactly like a down node.

That is still a real defect, and it is the same class already fixed once in this very function: the
block-state read a few lines above used to throw out of the promise handler, and its comment now
explains that the member votes reject instead, "keeping the fail-closed posture with a signed
reason". The checker call never got that treatment.

### The posture, chosen

**Fail closed: catch, and vote reject with a reason naming the fault.** Mirrors the
block-unavailable branch directly above it, and — per the arithmetic above — costs nothing in
acceptance outcomes relative to today's abstain. Use a stable prefix so the reason is greppable and
distinguishable from a genuine content verdict, e.g. `validator-fault: <message>`. Log
`cluster-member:validator-fault` with the messageHash and the error message.

The one genuine cost, which belongs in the review handoff rather than in a redesign: a **transient**
engine fault (database busy, momentary connection loss) now produces a terminal reject instead of an
abstain that a redelivery could have turned into an approve, and `validator-fault:` matches neither
classifier, so it reaches the writer as a non-retryable throw. Record that as a `NOTE:` tripwire at
the catch site — *if* transient validator faults ever show up in practice, make `validator-fault:`
retryable via a third classifier arm rather than reverting to abstain.

## Tests to write

Both belong in `packages/db-p2p/test/mesh-client-signature-enforcement.spec.ts`, which already has
the mesh builder, the enforcing-validator factory and the `ValidatorRejectionError` assertions. The
verified repro, minus the scaffolding already present in that file:

```ts
// ARM ONE — after the change this must be refused under 'reject', never silently unchecked
const mesh = await createEnforcingMesh(3);          // every node enforcing, unvalidatablePendPolicy: 'reject'
const error = await captureFailure(async () => mesh.nodes[0]!.coordinatorRepo.pend({
    actionId: 'a-no-validation',
    transforms: makeTransforms('block-no-validation-payload'),
    policy: 'c',
    // no `validation` payload at all
}));
expect(error).to.be.instanceOf(ValidatorRejectionError);
expect(error!.message).to.include('pend-not-validatable');

// ARM TWO — a throwing validator must produce a signed reject, not an escaping error
class ThrowingValidator implements ITransactionValidator {
    async validate(): Promise<ValidationResult> { throw new Error('engine exploded: no such table t'); }
    async getSchemaHash(): Promise<string | undefined> { return SCHEMA_HASH; }
}
const mesh = await createMesh(3, {
    responsibilityK: 3, clusterSize: 3, clusterPolicy: { assumedClusterSize: 3 },
    validatorFactory: () => new ThrowingValidator()
});
const error = await captureFailure(async () => mesh.nodes[0]!.coordinatorRepo.pend({
    actionId: 'a-throws',
    transforms: makeTransforms('block-throwing-validator'),
    policy: 'c',
    validation: { transaction: await buildUnsignedTx(clientPeerId), operationsHash: await emptyOpsHash() }
}));
expect(error).to.be.instanceOf(ValidatorRejectionError);      // today: plain Error, 0 rejections
expect(reasonsOf(error).every(r => r.startsWith('validator-fault:'))).to.equal(true);
```

Also pin the accept side of arm one (`unvalidatablePendPolicy` left at its default → the same pend
succeeds), so the default is asserted rather than assumed, and add a `StorageRepo`-tier case for the
second site: a `validatePend` hook configured, a pend with no `validation` payload, policy honoured.

Note on isolation, carried from that spec's own header: every transaction there is statement-free,
so the validator computes `hashOperations([])` and `emptyOpsHash()` makes every step except the
signature check pass trivially. Adding statements moves the failure to step 9 (operations-hash
mismatch) and the case stops proving what it says.

## TODO

- Replace `PendRequest.transaction` / `PendRequest.operationsHash` with one optional
  `validation: { transaction, operationsHash }` pair in `db-core/src/network/struct.ts`, with the
  doc comment above.
- Update the sole producer, `TransactionCoordinator.pendCollection`
  (`db-core/src/transaction/coordinator.ts:1073`), to build the nested shape.
- Update `ClusterMember.recordPriority` (`cluster-repo.ts:2199`) to read
  `op.pend.validation?.transaction.priority ?? op.pend.priority`.
- Add `unvalidatablePendPolicy?: 'accept' | 'reject'` (default `'accept'`) to
  `ClusterConsensusConfig` in `db-core/src/cluster/structs.ts`, and thread it into `ClusterMember`
  alongside the other `consensusConfig` reads.
- Export a stable `PEND_NOT_VALIDATABLE` reject-reason constant next to `MEMBERSHIP_NOT_ADMITTED`
  and `CONTENT_DIGEST_MISMATCH` in `cluster-repo.ts`.
- Rewrite the `validatePendOperations` guard: single presence test on `validation`; on absence take
  the policy branch and log `cluster-member:pend-unvalidatable` either way.
- Wrap the `this.validator.validate(...)` call in try/catch; on throw return
  `{ valid: false, reason: 'validator-fault: <message>' }` and log `cluster-member:validator-fault`.
  Add the `NOTE:` tripwire about transient faults at the catch site.
- Apply the same two changes at the storage tier, `StorageRepo.pend` (`storage-repo.ts:475-487`):
  single presence test on `validation`, policy branch, and a try/catch around the `validatePend`
  hook returning a hard `{ success: false, reason }` (that path already returns a non-conflict
  failure for an invalid transaction — match it).
- Add the mesh cases above to `mesh-client-signature-enforcement.spec.ts` plus the `StorageRepo`
  case, and update that spec's file header, which currently states that `transaction` and
  `operationsHash` "are the only two fields `validatePendOperations` hands to a configured
  validator".
- Sweep the doc comments naming the old fields: `struct.ts:44` and `cluster-repo.ts:2183`
  (`PendRequest.transaction` / `pend.transaction.priority`), `cluster-coordinator.ts:197`,
  `mesh-harness.ts:67-80`, and `PendValidationHook`'s doc block at `struct.ts:296-307`.
- Run `yarn workspace @optimystic/db-core test`, `yarn workspace @optimystic/db-p2p test`, and
  `yarn typecheck` at the repo root — the field rename will surface consumers this list missed,
  including in `packages/quereus-plugin-optimystic`.
