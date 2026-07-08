description: The feature that makes nodes reject transactions carrying no client signature has only ever been tested in isolation — nothing yet turns it on across a real multi-node cluster, so we don't know it actually rejects a bad client over the wire.
prereq: implement-client-tx-signature-p2p
files:
  - packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts (requireClientSignature option — currently only set by unit tests)
  - packages/quereus-plugin-optimystic/test/ (mesh harness that builds validators for cluster nodes)
  - packages/db-p2p/test/client-tx-signature.spec.ts (existing single-process integration coverage)
difficulty: medium
----

## Why this exists

The client-transaction-signature feature (`implement-client-tx-signature-p2p`) has two halves:

1. **Signing** — a client with a libp2p node key signs each transaction at commit. This ships ON
   whenever a key exists, and is exercised through the live mesh (signed transactions flow).
2. **Enforcement** — a receiving node with `requireClientSignature: true` rejects an unsigned or
   badly-signed transaction at PEND. This ships OFF by default (phased rollout).

The enforcement half is proven only at the **validator seam** — `createQuereusValidator({
requireClientSignature: true })` called directly in unit/integration tests
(`quereus-engine.spec.ts`, `client-tx-signature.spec.ts`), plus real-Ed25519 round-trips through
db-core's `TransactionValidator` in a single process. It has **never run through a live cluster PEND
path**: the plugin mesh tests all run with enforcement OFF, and there is currently **no production
code anywhere that sets `requireClientSignature: true`** — the mesh harness does not thread the flag,
and `createQuereusValidator` is only invoked from tests.

So the wire-level guarantee ("an unsigned client is refused by the cluster") is asserted nowhere.

## What to build

A mesh/cluster test that:

- Stands up a multi-node mesh where the receiving nodes' validators are constructed with
  `requireClientSignature: true` (thread the flag through whatever builds the per-node validator in
  the mesh harness).
- Asserts a client that does **not** sign (e.g. a legacy/local transactor with no node key) is
  rejected at PEND across nodes, with the `Missing client signature` reason surfacing through the
  live path.
- Asserts a client that signs with a key that does not match its `stamp.peerId` is rejected with
  `Invalid client signature`.
- Asserts a correctly-signed client commits successfully under enforcement.

## Also decide (production wiring)

Nothing flips `requireClientSignature: true` in production today. This ticket should either surface
the flag as a configurable option on the plugin/validator construction path so a deployment can opt
in, or explicitly document why enforcement stays test-only for now. The rollout order the
implementation assumes: land signing → observe clients signing in the field → *then* flip enforcement
on. Flipping it on before clients sign rejects every legacy (unsigned) client at PEND — so the config
surface must exist before anyone can safely turn it on.
