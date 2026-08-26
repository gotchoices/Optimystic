----
description: Nodes can be told to reject transactions that are not signed by the client that sent them, but that rejection has never been tested across a running network — only against the checking function in isolation. Wire the switch into the fake test network and prove the rejection actually happens between machines.
prereq: mesh-harness-real-reconcile
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (createMesh node assembly — clusterMember({ … validator }) is never populated)
  - packages/db-p2p/src/cluster/cluster-repo.ts:1129-1200 (validatePendOperations — returns success when no validator is configured)
  - packages/db-p2p/src/repo/cluster-coordinator.ts:365-395 (where a member's reject reason surfaces: "Transaction rejected by validators (n/m rejected): …")
  - packages/db-core/src/transaction/validator.ts:55-85 (the signature step: Missing / Invalid client signature)
  - packages/db-core/src/transaction/transaction.ts (createTransactionStamp, createTransactionId, clientSignaturePayload, hashOperations)
  - packages/db-p2p/src/cohort-topic/peer-sig.ts (signPeer / verifyPeerSig — the p2p backing)
  - packages/db-p2p/test/client-tx-signature.spec.ts (the single-process recipe to reuse: makeValidator, makeSigner, buildSignedTx, emptyOpsHash)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts (requireClientSignature — has no production caller)
difficulty: medium
----

# Mesh harness: prove signature enforcement across a live cluster PEND

## What is wrong

Client transaction signatures have two halves. **Signing** ships on whenever a node key exists and is
exercised through the live mesh. **Enforcement** — a receiving node rejecting an unsigned or
badly-signed transaction at PEND — is proven only at the validator seam: `TransactionValidator`
constructed directly with a verifier port, in a single process
(`test/client-tx-signature.spec.ts`, and the plugin's `quereus-engine.spec.ts`).

It has never run through a live cluster PEND path, and the reason is structural: **`createMesh` never
populates `clusterMember({ … validator })` at all.** `ClusterMember.validatePendOperations` returns
success when no validator is configured, so on the mesh the entire validation step — signatures,
schema hash, operations hash — is a no-op. The wire-level guarantee "an unsigned client is refused by
the cluster" is asserted nowhere.

## Design

### Harness: a per-node validator

```ts
export interface MeshOptions {
  // ...existing
  /**
   * Per-node transaction validator, the harness analogue of NodeOptions.validator. Invoked once per
   * node (indexed from 0) during assembly. Omitted → no validator, and ClusterMember's pend
   * validation is a no-op — today's behaviour, preserved so existing meshes do not move.
   */
  validatorFactory?: (index: number, peerId: PeerId) => ITransactionValidator;
}
```

Pass the result straight into `clusterMember({ … validator })`. That is the whole harness change:
one option, one field. Deliberately a factory rather than a single shared instance — enforcement
being a *per-node* decision is the thing under test (a mixed mesh, some nodes enforcing and some not,
is a case a shared instance cannot express).

Keep the default absent. Arming a validator on every existing mesh would make every mesh spec
suddenly re-validate transactions it never built for validation, which is unrelated fallout.

### The spec builds its validators from db-core, not from Quereus

Reuse the recipe already proven in `test/client-tx-signature.spec.ts`: an `ActionsEngine` registered
under `ACTIONS_ENGINE_ID` with a fixed schema hash, a `ValidationCoordinatorFactory` returning empty
transforms, and the p2p verifier closure
`(peerId, payload, sig) => { try { return verifyPeerSig(peerId, payload, b64urlToBytes(sig)); } catch { return false; } }`.

A transaction with **no statements** re-executes to no actions, so the validator computes
`hashOperations([])` at step 8 regardless of what transforms the pend request carries. Send
`operationsHash: await hashOperations([])` and every validator step except the signature check passes
trivially — which is exactly the isolation the test wants. This keeps Arm C inside `db-p2p` with no
Quereus dependency and no chicken-and-egg between building a `Database` and building the mesh.

Drive the live path by calling `node.coordinatorRepo.pend({ actionId, rev, transforms, policy: 'c',
transaction, operationsHash })` — the same `PendRequest` shape `TransactionCoordinator.pendCollection`
builds (`db-core/src/transaction/coordinator.ts:932`). The member's reject reason surfaces through
`ClusterCoordinator` as a thrown error reading
`Transaction rejected by validators (n/m rejected): …` (`src/repo/cluster-coordinator.ts:392`), with
the per-peer map on `disputeEvidence.rejectReasons`.

### The production-wiring question — decided: document the gap, do not add a flag

The source ticket asked whether to surface `requireClientSignature` as a deployment-configurable
option. **No — and the reason is larger than the flag.**

`createQuereusValidator` is exported from the plugin root and is called by **tests only**. Nothing
constructs a validator anywhere in production: `grep -rn "validator:" packages/*/src` finds exactly
two hits, both `validator: options.validator` inside `libp2p-node-base.ts`, and no composition root
(`reference-peer/src/cli.ts`, the plugin's `collection-factory.ts`) ever supplies it. So every
deployed cluster member runs `validatePendOperations` with `this.validator === undefined` and
re-validates nothing at all.

Adding a `requireClientSignature` knob to the plugin config would therefore be a switch on a code
path no deployment reaches — worse than useless, because it would read as a working rollout path. The
rollout order the feature assumes (land signing → observe clients signing → flip enforcement) cannot
begin until a validator is wired in the first place.

Actions:

- File the real prerequisite as a backlog feature ticket:
  `feat-no-deployment-validates-transactions-at-pend` (created alongside this ticket).
- Add a `NOTE:` at `QuereusValidatorOptions.requireClientSignature` in
  `packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts` recording that the flag
  has no production caller because no production path builds a validator at all, naming that backlog
  slug, and stating the revisit condition (a composition root starts supplying
  `NodeOptions.validator`). One line at the site, per the accepted-tradeoff convention — so the next
  reviewer does not re-discover and re-file it.

## Tests

New spec, `packages/db-p2p/test/mesh-client-signature-enforcement.spec.ts`, over a mesh whose every
node gets an enforcing validator (`validatorFactory` returning one built with the verifier port):

- **Unsigned client is refused at PEND across nodes.** A transaction with no `signature`. Expected:
  the pend fails, and the surfaced reason contains `Missing client signature`. Assert on the failure
  **and** the reason — a bare "it failed" would pass for any unrelated rejection.
- **Signature by a key that does not match `stamp.peerId` is refused.** Sign with key B, stamp with
  peer id A. Expected: `Invalid client signature`.
- **A correctly-signed client commits.** Stamp with A's peer id, sign with A's key, using the same
  `signPeer`/`bytesToB64url` closure the collection factory binds. Expected: pend succeeds and the
  block commits. This is the control that stops a validator which rejects everything from reading as
  a passing suite.
- **Enforcement is per node.** A mesh where only some nodes enforce. Assert the outcome the
  configured super-majority threshold implies, and state the arithmetic in a comment — whether the
  unsigned write commits depends on whether the non-enforcing members alone clear the threshold, and
  that is the honest thing to pin.
- **No validator ⇒ no signature step.** The same unsigned transaction on a mesh built without
  `validatorFactory` still commits. This is what makes the other cases meaningful: it proves the
  rejection came from the validator and not from something else in the pend path.

## Edge cases & interactions

- **Check ordering inside the validator.** `computeStampId` tamper detection and expiry both run
  *before* the signature step. A spec whose stamp is malformed or expired fails with a different
  reason and proves nothing about signatures — build stamps with `createTransactionStamp` and keep
  them fresh.
- **`stamp.peerId` must be a real peer-id string.** `verifyPeerSig` derives the public key from it;
  a synthetic id makes the verifier return `false` and turns the "correctly signed" control into a
  false negative. Use `peerIdFromPrivateKey(...).toString()` from a generated Ed25519 key.
- **The verifier must never throw.** Feed it a malformed base64url signature and a non-Ed25519 peer
  id; both must produce `Invalid client signature`, not an exception escaping into the cluster stream.
- **Empty-statement transactions and the operations hash.** The trick above holds only while the
  transaction has no statements. If a case adds statements, the computed hash changes and the test
  starts failing on step 9 instead of the signature step. Note this in the spec.
- **Reject reasons are per peer.** `disputeEvidence.rejectReasons` is a map; two members with
  different local config emit different strings for the same record. Assert on the substring
  (`Missing client signature`), not on an exact whole-message match.
- **Interaction with the admission gate (`4-mesh-harness-admission-gate`).** `evaluatePromise` runs
  `admitMembership` **before** `validatePendOperations`, so a mesh where admission also rejects will
  surface the membership reason and never reach the signature check. Keep the signature specs on a
  mesh whose admission gate admits (declare `assumedClusterSize`, full confidence), and say so in a
  comment.
- **Threshold arithmetic.** Whether a rejection actually blocks the write depends on how many members
  reject versus the super-majority threshold. Configure both explicitly in every case rather than
  relying on the harness default.
- **Signing key vs node key.** The harness already generates an Ed25519 key per node; a spec may sign
  as one of those nodes or as an unrelated client identity. Both are valid — be explicit about which,
  since "the client is also a node" is the plugin's real-world case and "the client is a stranger" is
  the attack case.

## TODO

- Add `validatorFactory` to `MeshOptions`; pass its result into `clusterMember({ … validator })`.
  Default absent.
- Add `test/mesh-client-signature-enforcement.spec.ts` with the five cases above, reusing the
  `makeValidator` / `makeSigner` / `buildSignedTx` recipe from `test/client-tx-signature.spec.ts`
  (extract into a shared helper under `test/support/` if the duplication is more than trivial —
  `debt-three-copies-of-the-log-capture-test-helper` is the cautionary precedent).
- Add the `NOTE:` at `QuereusValidatorOptions.requireClientSignature` naming
  `feat-no-deployment-validates-transactions-at-pend` and its revisit condition.
- Run `yarn workspace @optimystic/db-p2p test` in the foreground; existing meshes should not move
  (the default is absent) — if any does, that is a finding, not a nuisance.
- Handoff: state plainly that enforcement is now proven across a live cluster PEND *in the harness*,
  and that it remains unreachable in production until a validator is wired at all.
