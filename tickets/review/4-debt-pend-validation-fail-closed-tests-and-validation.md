description: Review the fail-closed pend-validation change — a receiving node that can validate transactions now takes an explicit, logged policy decision when handed a write it cannot check, and a crashing validator now casts a signed reject vote instead of losing its vote entirely.
files:
  - packages/db-core/src/network/struct.ts (PendRequest.validation pair replaces two independent optional fields)
  - packages/db-core/src/transaction/coordinator.ts (~1073 — the sole producer of the pair)
  - packages/db-core/src/cluster/structs.ts (ClusterConsensusConfig.unvalidatablePendPolicy)
  - packages/db-p2p/src/storage/storage-repo.ts (PEND_NOT_VALIDATABLE const; StorageRepoOptions.unvalidatablePendPolicy; pend() policy branch + try/catch)
  - packages/db-p2p/src/cluster/cluster-repo.ts (validatePendOperations guard rewrite; validator-fault catch; recordPriority reads new carrier; const re-export)
  - packages/db-p2p/src/cluster/cluster-policy.ts (knob pass-through)
  - packages/db-p2p/src/testing/mesh-harness.ts (validatorFactory doc)
  - packages/db-p2p/test/mesh-client-signature-enforcement.spec.ts (pendTx reshape; createEnforcingMesh policy arg; 3 new mesh cases)
  - packages/db-p2p/test/storage-repo.spec.ts (reshape; 3 new storage cases)
  - packages/db-p2p/test/cluster-repo.spec.ts (reshape; 2 new ClusterMember unit cases)
  - packages/db-p2p/test/signature-validation-integration.spec.ts (reshape)
  - packages/db-core/test/transaction.spec.ts (two capture sites reshaped)
  - packages/db-core/docs/transactor.md (PendRequest shape updated)
----

# Review: pend validation fail-closed — production change + tests

Implementation of `debt-pend-validation-is-skipped-instead-of-failing-closed`, finished across two
implement tickets (production code in the first, tests/docs/validation in this one). All work is in
the tree; builds and tests pass.

## What changed (behavioral summary)

Before: `PendRequest` carried two INDEPENDENTLY optional fields, `transaction` and
`operationsHash`. A cluster member (or storage repo) configured with a transaction checker silently
skipped the check when a sender omitted either field — a sender could talk a receiver out of
validating. And a checker that THREW escaped the vote path entirely: the coordinator recorded no
vote from that member, indistinguishable from an unreachable peer.

After:

- The two fields are ONE optional pair `PendRequest.validation: { transaction, operationsHash }`.
  Sole producer is `TransactionCoordinator.pendCollection` (multi-collection path). The
  single-collection `Collection.sync` path legitimately sends no pair — it has nothing to
  re-execute.
- A member/repo WITH a checker meeting a pair-less pend takes an explicit policy branch:
  `unvalidatablePendPolicy: 'accept' (default) | 'reject'`, logged on BOTH branches
  (`cluster-member:pend-unvalidatable` / storage `pend-unvalidatable`). `'reject'` refuses with the
  stable prefix `PEND_NOT_VALIDATABLE = 'pend-not-validatable'` (defined in storage-repo.ts,
  re-exported by cluster-repo.ts — that direction avoids an import cycle).
- A checker that throws is caught and votes a signed reject with reason
  `validator-fault: <message>` (logs `cluster-member:validator-fault` / storage
  `pend validator-fault`), never a lost vote.
- Knob plumbing: `ClusterConsensusConfig.unvalidatablePendPolicy` →
  `ClusterPolicyOptions.clusterPolicy.unvalidatablePendPolicy` → `resolveClusterPolicy` passes it
  through undefined (member defaults 'accept'); `StorageRepoOptions.unvalidatablePendPolicy`
  mirrors it at the storage tier.

## Test coverage added (the floor, not the ceiling)

Mesh tier (`mesh-client-signature-enforcement.spec.ts`, real coordinator + 3-node member stack):
- `unvalidatablePendPolicy: 'reject'` + pend with no `validation` pair → `ValidatorRejectionError`
  whose message and every per-peer reason carry `pend-not-validatable`; nothing committed anywhere.
- Same pend under the DEFAULT policy → succeeds (the 'accept' default is asserted, not assumed).
- Throwing validator + well-formed `validation` pair → `ValidatorRejectionError` with every reason
  starting `validator-fault:` (before the fix this surfaced as a plain Error with zero recorded
  rejections). Uses the statement-free-transaction isolation trick documented in that spec's header.

Storage tier (`storage-repo.spec.ts`): hook + no payload + default → success; hook + no payload +
'reject' → `{ success: false }` with `pend-not-validatable`; throwing hook + payload →
`{ success: false }` with `validator-fault:` prefix.

Unit tier (`cluster-repo.spec.ts`): two `ClusterMember` cases inspecting the member's own signed
vote (`result.promises[ourId]`) for the policy-reject and validator-throw arms.

Reshapes only (no behavior asserted beyond what already was): `signature-validation-integration.spec.ts`,
`transaction.spec.ts` capture sites, `makePendOperationP` priority carrier, existing validator stubs.

## Validation run

- `yarn workspace @optimystic/db-core build` — clean.
- `yarn workspace @optimystic/db-core test` — 1459 passing.
- `yarn workspace @optimystic/db-p2p test` — 2399 passing, 49 pending (pre-existing pendings), 0 failing.
- `yarn typecheck` at repo root (`workspaces foreach -At`, includes `quereus-plugin-optimystic`) — clean.

## Accepted tradeoffs / claims to hold the review to

- **Wire compatibility is a clean break, deliberately.** `validation` changes the shape of a field
  inside `RepoMessage.operations`, which is hashed into `messageHash` and folded into every signed
  vote, and there is no protocol version negotiation — a mixed-version cohort disagrees. Accepted
  because nothing in production supplies a validator at all today (backlog
  `feat-no-deployment-validates-transactions-at-pend`).
- **Default is 'accept'.** `'reject'` as default would break `Collection.sync` writes everywhere
  for a guarantee nobody has asked for; the win is that the choice is now named, logged, and
  testable. Both the mesh and storage suites assert the default explicitly.
- **The throwing-checker catch does NOT change accept/reject outcomes** — an abstain contributes no
  approval either, under `superMajority = ceil(n·0.75)`. What it buys: classification
  (`ValidatorRejectionError` instead of a generic super-majority failure), signed reject evidence
  for the dispute path, and operator legibility. Do not credit it with more.
- **Transient validator faults now produce terminal rejects** — recorded as `NOTE:` tripwires at
  both catch sites (cluster-repo.ts `validatePendOperations` catch, storage-repo.ts `pend` catch):
  if transient engine faults ever show up in practice, make `validator-fault:` retryable via a
  classifier arm rather than reverting to abstain. The review's findings section should index these.

## Known gaps for the reviewer

- No mesh case exercises a MIXED cohort (some members 'reject', some 'accept') for the
  unvalidatable-pend policy — the per-node absorption arithmetic is proven for signature
  enforcement in the same spec, and the policy rides the identical vote path, so this was judged
  duplicative. Disagree if you see a distinct failure mode.
- The mesh throwing-validator case asserts the write is refused but not the reservation-cleanup
  behavior afterward (`does not retain a transaction it rejected itself` covers that at the unit
  tier for a validation reject, not a validator-fault reject).
- `recordPriority` reading `op.pend.validation?.transaction.priority ?? op.pend.priority` is
  covered by the reshaped priority-race tests, but only via stub transactions carrying `.priority`
  alone.
