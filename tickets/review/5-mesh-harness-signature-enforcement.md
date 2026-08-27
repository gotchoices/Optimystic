----
description: Nodes can be told to reject transactions that are not signed by the client that sent them. That rejection is now wired into the fake test network and proven to happen between machines — but it is still switched off in every real deployment.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (new `MeshOptions.validatorFactory`, passed into `clusterMember({ … validator })`)
  - packages/db-p2p/test/mesh-client-signature-enforcement.spec.ts (NEW — 8 cases over a live cluster PEND)
  - packages/db-p2p/test/support/client-tx-signature.ts (NEW — the shared signer/verifier/validator/transaction builders)
  - packages/db-p2p/test/client-tx-signature.spec.ts (refactored onto the shared helper; one ordering case added)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts (accepted-tradeoff NOTE at `requireClientSignature`)
  - docs/transactions.md (§7 Transaction Validator — deployment-status callout)
difficulty: medium
----

# Review: signature enforcement across a live cluster PEND

## What changed

**One harness option.** `MeshOptions.validatorFactory?: (index, peerId) => ITransactionValidator` is
invoked once per node during `createMesh` assembly and its result passed straight into
`clusterMember({ … validator })`. Before this, `createMesh` never populated that field at all, so
`ClusterMember.validatePendOperations` returned success unconditionally and the mesh's entire
validation step — signatures, schema hash, operations hash — was a no-op. The option is absent by
default, so no existing mesh moves.

It is a factory, not a shared instance, because enforcement is a per-node decision; a mixed mesh
(some members enforcing, some not) is one of the cases under test and a shared instance cannot
express it.

Incidental: the per-node loop now takes `const index = nodeIndex++` at the top instead of
incrementing mid-body. Same values reach `rawStorageFactory` as before.

**A new mesh-tier spec**, `packages/db-p2p/test/mesh-client-signature-enforcement.spec.ts`, drives
real Ed25519 identities through `node.coordinatorRepo.pend({ … transaction, operationsHash })` — the
same `PendRequest` shape `TransactionCoordinator.pendCollection` builds — and asserts on the
`ValidatorRejectionError` the coordinator throws (`.rejectReasons` is the per-peer map).

**A shared helper**, `test/support/client-tx-signature.ts`, holds the recipe both tiers need:
`SCHEMA_HASH`, `makeSigner`, the `verifier` closure, `makeValidator`, `buildSignedTx`,
`buildUnsignedTx`, `emptyOpsHash`, `generateClientIdentity`. `client-tx-signature.spec.ts` was
refactored onto it (it previously defined all of these inline) — the cautionary precedent named in
the source ticket was `debt-three-copies-of-the-log-capture-test-helper`.

**A `NOTE:` at `QuereusValidatorOptions.requireClientSignature`** recording the declined finding: the
flag is deliberately NOT surfaced as a deployment-configurable option, because no production path
builds a validator at all, so the knob would switch a code path no deployment reaches. Names the
backlog slug and the revisit condition (a composition root starts supplying `NodeOptions.validator`).
The backlog ticket `feat-no-deployment-validates-transactions-at-pend` already existed; nothing new
was filed.

**One doc callout** in `docs/transactions.md` §7, stating plainly that every deployed cluster member
currently re-validates nothing at pend. Architectural, no single code site beyond the one annotated
above.

## The honest headline

Enforcement is now proven across a live cluster PEND **in the harness**. It remains **unreachable in
production**: `grep -rn "validator:" packages/*/src` finds only the two `validator: options.validator`
lines inside `libp2p-node-base.ts`, and no composition root (`reference-peer/src/cli.ts`, the plugin's
`collection-factory.ts`) supplies one. This ticket did not change that and deliberately did not try
to — see the backlog ticket.

## How to validate

```
yarn workspace @optimystic/db-p2p test
```

Result at handoff: **1951 passing, 44 pending, 0 failing** (~48s). No pre-existing failures surfaced,
so no `.pre-existing-error.md` was written.

Targeted run of the two signature tiers:

```
cd packages/db-p2p
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/mesh-client-signature-enforcement.spec.ts" "test/client-tx-signature.spec.ts" --colors
```

Also run and clean: `yarn workspace @optimystic/db-p2p build`,
`yarn workspace @optimystic/quereus-plugin-optimystic build`, and `eslint` over all five touched
files.

## The cases, and the arithmetic they turn on

`superMajorityThreshold` defaults to 0.75, so `superMajority = ceil(peerCount * 0.75)` and
`maxAllowedRejections = peerCount - superMajority`. Every mesh in the spec declares
`clusterPolicy.assumedClusterSize` equal to its node count and is unpartitioned, so the membership
admission gate admits — `evaluatePromise` runs `admitMembership` **before** `validatePendOperations`,
and a rejecting gate would surface the membership reason and never reach the signature check.

| Case | Mesh | Expected |
|---|---|---|
| Unsigned client refused | 3 nodes, all enforcing (maxAllowedRejections 0) | `ValidatorRejectionError`, every reason `Missing client signature`, nothing committed anywhere |
| Signature by a key that does not match `stamp.peerId` | 3 nodes, all enforcing | `Invalid client signature` |
| Malformed base64url signature, and a non-Ed25519 `stamp.peerId` | 3 nodes, all enforcing | Both are a signed reject verdict, not an exception escaping the cluster stream |
| Correctly-signed client (stranger identity) | 3 nodes, all enforcing | pend `success: true`, commit succeeds, block reads back |
| Correctly-signed client that IS a mesh node, signing with its node key | 3 nodes, all enforcing | pend + commit succeed (the plugin's real-world shape) |
| One enforcer out of four | 4 nodes, index 0 enforcing (maxAllowedRejections 1) | Unsigned write **PENDS** — one rejection is absorbed |
| Two enforcers out of four | 4 nodes, indices 0,1 enforcing | Refused; exactly two peers in `.rejectReasons` |
| No `validatorFactory` at all | 3 nodes | The same unsigned transaction pends and commits |

The "one enforcer out of four" row is the uncomfortable one and is stated deliberately: **partial
enforcement does not enforce.** Until enough of the cohort verifies, an unsigned client still writes.
That is a property of the super-majority arithmetic, not a defect in the wiring.

The last row is the negative control — it is what makes every refusal above attributable to the
validator rather than to something else in the pend path.

## Things a reviewer should probe

- **The empty-statements trick.** Every transaction in the mesh spec carries no statements, so
  re-execution yields no actions and the validator computes `hashOperations([])` at step 8 whatever
  transforms the pend request carries. That is what isolates the signature step. It is stated in the
  spec's file header, but it is fragile in the ordinary way: a future case that adds statements will
  start failing at step 9 (`Operations hash mismatch`) and the failure will look unrelated.
- **`rev` is omitted from the pend request.** Two reasons, both in the header comment: it skips the
  member's stale-revision precheck, and it keeps `CoordinatorRepo.classifyStaleRejection` (which runs
  only when `rev` is present) from reinterpreting a signature rejection as an optimistic-concurrency
  loss. A reviewer may reasonably think a production-shaped pend should carry `rev`; the tradeoff is
  that doing so routes a genuine rejection through a re-read that could reclassify it.
- **The "one enforcer out of four" case asserts the pend only, not the commit.** The enforcing member
  never pended locally, so committing would exercise cohort-drift reconciliation — a different
  subject, and one that would make the case's verdict ambiguous. Called out in a comment.
- **`makeValidator(undefined)` vs no validator at all.** In `createEnforcingMesh`, non-enforcing nodes
  still get a validator, just one with no verifier port (the phased-rollout posture). Only the last
  case builds a mesh with no `validatorFactory` — genuinely no validator. Two different things; worth
  confirming the spec never conflates them.
- **`ITransactionValidator` is a type-only import in `mesh-harness.ts`,** so `src/testing`'s runtime
  dependency surface is unchanged (`testing-entry-runtime-deps.spec.ts` still passes).
- **One test was added to `client-tx-signature.spec.ts`** beyond the refactor: "a stamp forged onto a
  different peer id is caught before the signature step". It pins the check ordering the mesh spec
  depends on (`computeStampId` tamper detection runs first, so a mutated stamp yields
  `Tampered transaction stamp`, not a signature verdict). Judge whether that belongs here or was scope
  creep.

## Known gaps

- **Nothing here makes production enforce.** No composition root wires a validator; that is
  `feat-no-deployment-validates-transactions-at-pend` and was explicitly out of scope.
- **`quereus-plugin-optimystic`'s own suite was not run.** Its only change is a JSDoc comment inside
  an interface; the package builds clean (tsup + DTS). If the reviewer wants belt-and-braces, its
  suite is ~2m46s.
- **Integration tier untouched.** These are in-process meshes, not real sockets. Enforcement over a
  real libp2p transport is not covered by anything.
- **The mixed-mesh case is threshold-arithmetic-specific.** It hardcodes the 0.75 default. A change to
  `DEFAULT_SUPER_MAJORITY_THRESHOLD` would silently invert both per-node cases rather than fail
  loudly; the arithmetic is spelled out in comments but not asserted from the constant.
