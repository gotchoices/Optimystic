description: Finish the fail-closed pend-validation change — the production code is already rewritten; what remains is updating the test suites to the new request shape, adding the new coverage, and running the builds.
files:
  - packages/db-core/src/network/struct.ts (DONE — PendRequest.validation pair replaces transaction/operationsHash)
  - packages/db-core/src/transaction/coordinator.ts (DONE — pendCollection builds validation pair)
  - packages/db-core/src/cluster/structs.ts (DONE — ClusterConsensusConfig.unvalidatablePendPolicy)
  - packages/db-p2p/src/storage/storage-repo.ts (DONE — PEND_NOT_VALIDATABLE const, policy option, pend rewrite with try/catch + NOTE tripwire)
  - packages/db-p2p/src/cluster/cluster-repo.ts (DONE — guard rewrite, validator-fault catch + NOTE tripwire, recordPriority, const re-export)
  - packages/db-p2p/src/cluster/cluster-policy.ts (DONE — knob + pass-through)
  - packages/db-p2p/test/cluster-repo.spec.ts (TODO — reshape stubs, comments; optional new unit cases)
  - packages/db-p2p/test/storage-repo.spec.ts (TODO — reshape + policy/fault cases)
  - packages/db-p2p/test/signature-validation-integration.spec.ts (TODO — reshape one stub)
  - packages/db-p2p/test/mesh-client-signature-enforcement.spec.ts (TODO — pendTx helper, header doc, new mesh cases)
  - packages/db-core/test/transaction.spec.ts (TODO — two capture sites)
  - packages/db-p2p/src/testing/mesh-harness.ts (TODO — doc touch-up only)
  - packages/db-core/docs/transactor.md (TODO — PendRequest shape at ~line 349)
difficulty: hard
----

# Continuation: pend validation fail-closed — tests + validation remain

Continuation of `debt-pend-validation-is-skipped-instead-of-failing-closed` (implement stage),
split on a budget stop. **All production-source edits are already in the working tree and are
believed complete.** Read the original ticket's analysis in `tickets/complete/` if archived, but
everything needed to finish is restated here.

## What the change is (one paragraph)

A cluster member (or storage repo) given a transaction checker used to skip the check whenever the
sender omitted `PendRequest.transaction` or `PendRequest.operationsHash` (two independently optional
fields), and a checker that threw escaped the vote path entirely (no vote instead of a reject). The
two fields are now ONE optional pair `PendRequest.validation: { transaction, operationsHash }` — the
sole producer is `TransactionCoordinator.pendCollection`; the single-collection `Collection.sync`
path legitimately sends no pair. A member/repo WITH a checker meeting a pair-less pend now takes an
explicit policy branch — `unvalidatablePendPolicy: 'accept' (default) | 'reject'` — logged on both
branches (`cluster-member:pend-unvalidatable` / storage `pend-unvalidatable`); `'reject'` refuses
with the stable prefix `PEND_NOT_VALIDATABLE = 'pend-not-validatable'`. A checker that throws is now
caught and votes reject with reason `validator-fault: <message>` (log
`cluster-member:validator-fault` / storage `pend validator-fault`), never a lost vote. NOTE
tripwires about transient engine faults sit at both catch sites already.

## State of the tree (verified done — do not redo)

- `db-core/src/network/struct.ts`: `validation` pair with doc; `priority` doc and
  `PendValidationHook` doc updated.
- `db-core/src/transaction/coordinator.ts` (~line 1073): producer builds
  `validation: { transaction, operationsHash }`.
- `db-core/src/cluster/structs.ts`: `unvalidatablePendPolicy?: 'accept' | 'reject'` appended to
  `ClusterConsensusConfig` with doc.
- `db-core/src/transaction/operations-hash.ts` + `transaction.ts`: doc sweeps done.
- `db-p2p/src/storage/storage-repo.ts`: `PEND_NOT_VALIDATABLE` exported next to
  `MISSING_BASE_REVISION_REASON` (defined HERE, not in cluster-repo, because cluster-repo imports
  from storage-repo and the reverse import would be a cycle); `StorageRepoOptions.unvalidatablePendPolicy`;
  `pend()` rewritten: presence test on `validation`, policy branch with log, try/catch around the
  hook returning `{ success: false, reason: 'validator-fault: …' }`.
- `db-p2p/src/cluster/cluster-repo.ts`: re-exports `PEND_NOT_VALIDATABLE` next to
  `MEMBERSHIP_NOT_ADMITTED`/`CONTENT_DIGEST_MISMATCH`; member field + constructor default
  `'accept'`; `validatePendOperations` guard rewritten (policy branch + logged both ways +
  try/catch voting `validator-fault:` reject); `recordPriority` reads
  `op.pend.validation?.transaction.priority ?? op.pend.priority`; doc at ~2183 updated.
- `db-p2p/src/cluster/cluster-policy.ts`: `ClusterPolicyOptions.clusterPolicy.unvalidatablePendPolicy`
  added and passed through in `resolveClusterPolicy`'s return.
- `db-p2p/src/repo/cluster-coordinator.ts` ~197: doc updated.

**The tree does NOT typecheck yet**: db-p2p sees stale `@optimystic/db-core` dist typings until
db-core rebuilds, and the test files below still use the old two-field shape. Build db-core first
(`yarn workspace @optimystic/db-core build`), then fix tests, then the full runs.

## TODO

### Reshape existing tests (old two fields → `validation` pair)

- `db-p2p/test/cluster-repo.spec.ts`:
  - `makePendOperationP` (~line 197): `txPriority` arm becomes
    `pend.validation = { transaction: { priority: opts.txPriority } }` (stub cast is fine — only
    `.priority` is read); update the helper's doc comment (~191-196) and the test name at ~1091
    ("pend.transaction.priority" → "pend.validation.transaction.priority").
  - Three validator tests (~1400, ~1440, ~1480): pend op gains
    `validation: { transaction: { statements: [], stamp: {} } as any, operationsHash: 'hash' }`
    replacing the two loose fields; update the comment at ~1477.
- `db-p2p/test/signature-validation-integration.spec.ts` (~line 320-328): same reshape.
- `db-p2p/test/storage-repo.spec.ts` (~line 280-286): same reshape.
- `db-core/test/transaction.spec.ts`: capture sites at ~505-513 (read
  `request.validation?.operationsHash` / `request.validation?.transaction`; assertions at ~585-589
  stay) and ~1146-1147 (`hasTransaction: !!request.validation?.transaction`,
  `hasOperationsHash: !!request.validation?.operationsHash`).

### New coverage (the point of the ticket — do not skip)

Mesh tier, in `db-p2p/test/mesh-client-signature-enforcement.spec.ts` (it has the builders:
`createEnforcingMesh`, `captureFailure`, `reasonsOf`, `makeTransforms`, and
`test/support/client-tx-signature.ts` exports `makeValidator`, `verifier`, `emptyOpsHash`,
`buildUnsignedTx`, `SCHEMA_HASH`). Update its `pendTx` helper (~90-97) to the `validation` pair and
its header + helper doc (~85-89), which claims `transaction`/`operationsHash` "are the only two
fields validatePendOperations hands to a configured validator". `createEnforcingMesh` needs a way to
pass `unvalidatablePendPolicy` into `clusterPolicy` (add an optional arg). The cases, from the
original ticket's verified repro:

```ts
// ARM ONE — under 'reject', a pend with NO validation payload is refused, never silently unchecked
const mesh = await createEnforcingMesh(3 /* + unvalidatablePendPolicy: 'reject' */);
const error = await captureFailure(async () => mesh.nodes[0]!.coordinatorRepo.pend({
    actionId: 'a-no-validation',
    transforms: makeTransforms('block-no-validation-payload'),
    policy: 'c',
}));
expect(error).to.be.instanceOf(ValidatorRejectionError);
expect(error!.message).to.include('pend-not-validatable');

// ARM ONE accept side — default policy: the same pend SUCCEEDS (assert, don't assume, the default)
// (all-enforcing mesh, no policy override, same request → expect success:true)

// ARM TWO — a throwing validator produces a signed reject, not an escaping error
class ThrowingValidator implements ITransactionValidator {
    async validate(): Promise<ValidationResult> { throw new Error('engine exploded: no such table t'); }
    async getSchemaHash(): Promise<string | undefined> { return SCHEMA_HASH; }
}
const mesh2 = await createMesh(3, {
    responsibilityK: 3, clusterSize: 3, clusterPolicy: { assumedClusterSize: 3 },
    validatorFactory: () => new ThrowingValidator()
});
const error2 = await captureFailure(async () => mesh2.nodes[0]!.coordinatorRepo.pend({
    actionId: 'a-throws',
    transforms: makeTransforms('block-throwing-validator'),
    policy: 'c',
    validation: { transaction: await buildUnsignedTx(clientPeerId), operationsHash: await emptyOpsHash() }
}));
expect(error2).to.be.instanceOf(ValidatorRejectionError);   // before the fix: plain Error, 0 rejections
expect(reasonsOf(error2).every(r => r.startsWith('validator-fault:'))).to.equal(true);
```

Isolation caveat carried from that spec's header: keep every transaction statement-free so
`emptyOpsHash()` makes all validator steps except the one under test pass trivially; adding
statements moves the failure to the operations-hash step and the case stops proving what it says.
The no-`rev` shape also keeps `classifyStaleRejection` out of the way.

Storage tier, in `db-p2p/test/storage-repo.spec.ts` (next to the existing "validates transaction
when validator is configured" case):
- hook + NO `validation` payload + default policy → pend succeeds (accept is the asserted default);
- hook + NO payload + `unvalidatablePendPolicy: 'reject'` → `{ success: false }` with reason
  including `pend-not-validatable`;
- hook that THROWS + a `validation` payload → `{ success: false }` with reason starting
  `validator-fault:`.

Optional but cheap: two `ClusterMember` unit cases in `cluster-repo.spec.ts`'s `validation`
describe mirroring the policy-reject and validator-throw arms via reject-vote inspection
(`result.promises[ourId]`), following the existing "rejects promise when validation fails" pattern.

### Doc sweep remainder

- `db-p2p/src/testing/mesh-harness.ts` `validatorFactory` doc (~67-80): still accurate about "no
  validator ⇒ step skipped", but add a sentence that a mesh arming validators can set
  `clusterPolicy.unvalidatablePendPolicy: 'reject'` to also refuse unvalidatable pends.
- `db-core/docs/transactor.md` (~349): the `PendRequest` shape shown still lists the two old
  fields — update to the `validation` pair.

### Validation

- `yarn workspace @optimystic/db-core build` FIRST (db-p2p typechecks against dist typings —
  current in-tree "Property 'validation' does not exist on type 'PendRequest'" diagnostics are that
  staleness, not real errors).
- `yarn workspace @optimystic/db-core test`
- `yarn workspace @optimystic/db-p2p test`
- `yarn typecheck` at the repo root — surfaces any consumer this list missed, including
  `packages/quereus-plugin-optimystic` (a repo-wide grep found no code use of the old fields there,
  only a comment; verify via typecheck).
- Run tests in the foreground (no output redirection), or `2>&1 | tee tickets/.logs/<slug>.test.log`.

### Handoff notes for the eventual review ticket (carry these forward)

- **Wire compatibility is a clean break, deliberately**: `validation` changes the shape of a field
  inside `RepoMessage.operations`, which is hashed into `messageHash` and folded into every signed
  vote, and there is no protocol version negotiation. A mixed-version cohort disagrees. Accepted
  because nothing in production supplies a validator at all today (backlog
  `feat-no-deployment-validates-transactions-at-pend`).
- Default `unvalidatablePendPolicy` is `'accept'` — `'reject'` would break `Collection.sync`
  everywhere for a guarantee nobody has asked for; the win is that the choice is now named, logged,
  and testable.
- A throwing checker never changed accept/reject OUTCOMES (an abstain contributes no approval
  either, under `superMajority = ceil(n·0.75)`); what the catch buys is classification
  (`ValidatorRejectionError` instead of a generic super-majority failure), signed reject evidence
  for the dispute path, and operator legibility. Do not claim more.
- The transient-fault cost is recorded as `NOTE:` tripwires at both catch sites
  (cluster-repo.ts `validatePendOperations` catch, storage-repo.ts `pend` catch) — the review
  findings should index them.
