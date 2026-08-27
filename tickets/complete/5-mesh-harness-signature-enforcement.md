----
description: Machines in the cluster can be told to refuse writes that are not signed by the client that sent them. That refusal is now wired into the fake test network, proven across a live multi-machine write, and the copy-pasted verification code that made the test only look like production has been replaced by the real thing.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (MeshOptions.validatorFactory)
  - packages/db-p2p/src/cluster/client-signature-verifier.ts (NEW, review — the one shared verifier factory)
  - packages/db-p2p/src/index.ts (exports it)
  - packages/db-p2p/test/mesh-client-signature-enforcement.spec.ts (8 cases over a live cluster PEND)
  - packages/db-p2p/test/support/client-tx-signature.ts (shared signer/verifier/validator/transaction builders)
  - packages/db-p2p/test/client-tx-signature.spec.ts (single-process tier, on the shared helper)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts (accepted-tradeoff NOTE; now imports the shared verifier)
  - docs/transactions.md (§7 — deployment-status callout)
----

# Signature enforcement across a live cluster PEND — complete

## What landed

**A harness option.** `MeshOptions.validatorFactory?: (index, peerId) => ITransactionValidator` is
invoked once per node during `createMesh` and passed into `clusterMember({ … validator })`. Before
this, `createMesh` never populated that field, so `ClusterMember.validatePendOperations` returned
success unconditionally and the mesh's whole validation step — signatures, schema hash, operations
hash — was a no-op. Absent by default, so no existing mesh moves. A factory rather than a shared
instance because enforcement is a per-node decision and a mixed mesh is one of the cases under test.

**A mesh-tier spec** (`mesh-client-signature-enforcement.spec.ts`) driving real Ed25519 identities
through `coordinatorRepo.pend({ … transaction, operationsHash })` — the shape
`TransactionCoordinator.pendCollection` builds — asserting on the `ValidatorRejectionError` the
coordinator throws. Eight cases: unsigned refused; impersonation refused; malformed signature and
non-Ed25519 peer id both refused as verdicts rather than crashes; correctly-signed stranger admitted;
correctly-signed mesh node admitted; one enforcer of four absorbed; two enforcers of four fatal; and
a no-validator negative control that makes every refusal above attributable to the validator.

**A shared test helper** (`test/support/client-tx-signature.ts`) holding the recipe both tiers need,
with `client-tx-signature.spec.ts` refactored onto it.

**An accepted-tradeoff `NOTE:`** at `QuereusValidatorOptions.requireClientSignature` recording why the
flag is deliberately not surfaced as a deployment option, and **a doc callout** in
`docs/transactions.md` §7 stating that every deployed cluster member currently re-validates nothing at
pend.

## The honest headline, unchanged by review

Enforcement is proven across a live cluster PEND **in the harness**. It remains **unreachable in
production**: no composition root supplies `NodeOptions.validator`. That is
`feat-no-deployment-validates-transactions-at-pend` and was explicitly out of scope.

## Review findings

Reviewed the implement diff (`536a3b7`) first, then the surrounding source: `cluster-repo.ts`'s
promise/validation path, `db-core`'s `TransactionValidator`, `PendRequest`, `peer-sig.ts`, both
composition roots, and every doc that mentions the mesh harness or the validator.

### Fixed in this pass

- **The verifier closure was duplicated verbatim between production and tests.** The test helper
  re-typed the five-line closure that `quereus-validator.ts` binds, and its docstring *asserted* the
  two were identical — with nothing enforcing it. Drift would have left both tiers green while the
  mesh spec quietly stopped testing production's verifier. Extracted to
  `createPeerClientSignatureVerifier()` in `packages/db-p2p/src/cluster/client-signature-verifier.ts`,
  exported from the `db-p2p` root; `quereus-validator.ts` and the test helper now both call it, so the
  claim holds by compilation rather than by comment. The implementer had cited
  `debt-three-copies-of-the-log-capture-test-helper` as precedent while collapsing test-to-test
  duplication but leaving the test-to-production copy in place.
- **The threshold arithmetic was asserted only in prose.** The per-node cases depend on a 3-node
  cohort tolerating zero rejections and a 4-node cohort tolerating exactly one; both were spelled out
  in comments derived from a hardcoded 0.75. A change to `DEFAULT_SUPER_MAJORITY_THRESHOLD` would have
  silently swapped "absorbed" and "fatal" rather than failing. The suite now recomputes both budgets
  from the exported constant and asserts them in a `before`, so that change fails loudly and names the
  reason.

### Filed as a ticket

- **`backlog/debt-pend-validation-is-skipped-instead-of-failing-closed`** — two ways a member that
  *does* have a validator skips the check instead of enforcing it, both at
  `ClusterMember.validatePendOperations`, so one ticket with two arms:
  - the check is guarded on `pendRequest.transaction && pendRequest.operationsHash`, two independent
    optional sender-supplied fields — so a sender that omits either disables its own validation. Filed
    at the types rung: making them one optional pair on `PendRequest` makes the bad state
    unrepresentable, which is the more valuable half.
  - `this.validator.validate(...)` is not wrapped, so a validator that throws (the production Quereus
    validator re-executes SQL against a live database) escapes to the cluster stream as an error rather
    than a signed reject vote — indistinguishable from an unreachable peer, so a cohort of failing
    validators degrades toward *not* enforcing. Filed at the boundary-invariant rung. The same class
    was already fixed once at this exact function for the block-state read a few lines above; that
    comment explicitly names the fail-closed posture the validator call never got.

  Dormant (`debt-`, not `bug-`) because no deployment supplies a validator, so neither hole is
  reachable today — but both go live the moment the wiring ticket lands, which is why they are worth
  closing first. Cross-referenced from `feat-no-deployment-validates-transactions-at-pend` so whoever
  does that wiring meets them.

### Recorded as a tripwire, not a ticket

- **The empty-statements isolation trick.** Every mesh case sends a statement-free transaction so the
  validator's operations hash is `hashOperations([])` regardless of the transforms — which is what
  isolates the signature step. Fine now; a future case that adds statements gets
  `Operations hash mismatch` at step 9, a verdict about operations whose message gives no hint that
  the ops hash is the stale part. Parked as a `NOTE:` at `emptyOpsHash` in
  `test/support/client-tx-signature.ts`, naming the fix (compute the hash from the transforms the pend
  actually carries).

### Checked and found sound — no action

- **The harness change itself.** `validatorFactory` is a type-only import, so `src/testing`'s runtime
  dependency surface is unchanged and `testing-entry-runtime-deps.spec.ts` still passes. The
  `nodeIndex` refactor to `const index = nodeIndex++` preserves the values `rawStorageFactory` sees,
  and `index` matches the node's position in `Mesh.nodes` because both are assigned in the same loop.
  `validator: undefined` is identical to omitting the field.
- **Every factual claim in the doc callout and the `NOTE:`.** `grep -rn "validator:" packages/*/src`
  returns exactly the two `libp2p-node-base.ts` pass-throughs plus the new harness line;
  `createQuereusValidator` has callers only in `quereus-engine.spec.ts`. Both composition roots
  confirmed to pass no validator. No other doc describes `MeshOptions` — the mesh-harness mentions in
  `docs/architecture.md` are the cohort-topic/matchmaking/reactivity harnesses, unrelated.
- **The verifier's totality claim.** `verifyPeerSig` already catches internally and returns `false` on
  a non-Ed25519 id, missing key, short key, or decode failure; the wrapping try/catch is genuinely
  only needed for the base64url decode, exactly as documented.
- **An empty-string signature.** `TransactionValidator` tests `signature === undefined`, so an empty
  string falls through to the verifier and yields `Invalid client signature` rather than slipping past
  the missing-signature branch. No hole.
- **`makeValidator(undefined)` vs no validator.** The spec does not conflate them: non-enforcing nodes
  in `createEnforcingMesh` get a validator with no verifier port (the migration posture); only the
  last case builds a mesh with no `validatorFactory` at all.
- **The added ordering test** in `client-tx-signature.spec.ts` ("a stamp forged onto a different peer
  id is caught before the signature step") is not scope creep — it pins the `computeStampId` check
  ordering the mesh spec's isolation argument depends on, at the tier where that ordering is
  observable.
- **Resource cleanup.** `Mesh` has no teardown surface and the change adds no disposable state;
  `TransactionValidator` disposes its validation coordinator in a `finally`.

### Empty categories, with reasons

- **No pre-existing test failures.** Both suites were green before and after; nothing was written to
  `tickets/.pre-existing-error.md`.
- **No accepted-tradeoff `NOTE:` was overridden.** The one at `requireClientSignature` is this
  ticket's own, its revisit condition (a composition root supplying `NodeOptions.validator`) has not
  tripped, and none of the findings above sit at that site.
- **No source-hygiene findings.** `mesh-harness.ts` is 507 lines with the option adding 20; the mesh
  spec is 307 lines of eight cases; the shared helper is 132. Every function is short and named, and
  the comment density is high but load-bearing — each block explains a non-obvious ordering or
  arithmetic dependency rather than restating code.

## Validation

```
yarn workspace @optimystic/db-p2p test                       # 1951 passing, 44 pending, 0 failing
yarn workspace @optimystic/quereus-plugin-optimystic test    # 656 passing, 13 pending, 0 failing
yarn workspace @optimystic/db-p2p build                      # clean
yarn workspace @optimystic/quereus-plugin-optimystic build   # clean
npx eslint <all touched files>                               # clean
```

The plugin suite (~4m) was a gap in the implement handoff and was run here, because the review moved
production code in that package rather than only a comment.

## Gaps carried forward, unchanged

- Production still enforces nothing — `feat-no-deployment-validates-transactions-at-pend`.
- Integration tier untouched: these are in-process meshes, not real sockets. Enforcement over a real
  libp2p transport has no coverage.
- The "one enforcer out of four" case asserts the pend only, not the commit — the enforcing member
  never pended locally, so committing would exercise cohort-drift reconciliation and make the case's
  verdict ambiguous. Deliberate, and stated at the site.
