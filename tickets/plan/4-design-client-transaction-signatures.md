description: The design assumes clients cryptographically sign the transactions they submit, but transactions currently carry no client signature and nodes never verify one — so the "isolate a misbehaving client" and recovery stories don't actually hold. Add a client signature to each transaction and check it when the transaction is first accepted.
prereq:
files:
  - packages/db-core/src/transaction/transaction.ts (TransactionStamp — has peerId, no signature field ~line 11)
  - packages/db-core/src/transaction/coordinator.ts (pend/commit path)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (pend handling / verification point)
  - docs/right-is-right.md (§Client Signatures; recovery scenarios; Theorem 13)
difficulty: medium
----

`right-is-right.md` §Client Signatures and its recovery scenarios assume client-signed transactions. In the code, `TransactionStamp` (`transaction.ts:11`) carries a `peerId` but **no signature field**, and there is no client-signature verification anywhere on the pend/commit path. Until this lands:

- The "a bad client gets isolated" story is incomplete — nothing cryptographically binds a transaction to the client that authored it, so a peer cannot be held accountable for what it submitted.
- Theorem 13's recovery anchoring is incomplete — dispute-recovery paths that need to authenticate the *original* transaction have nothing to authenticate against.

The docs already flag client signatures as a target rather than a shipped feature.

## Expected behavior

Add a signature over the transaction stamp plus its statements to `TransactionStamp`, and verify that signature at pend (the first point a node accepts the transaction). A transaction whose signature is missing or invalid is rejected before it can PEND.

This also unblocks the dispute-recovery paths that must authenticate the original transaction, so it is a natural prerequisite for the reversal/recovery machinery even though it is filed independently here.

## Edge cases & interactions

- **What the signature covers** — it must bind the client identity to the exact statements and stamp so neither can be altered in flight; define the canonical bytes signed (coordinate with the canonical-serialization work in design-consensus-hygiene-notes so the signed form is stable and versioned).
- **Key distribution / identity** — define how a verifying node obtains the client's public key and how `peerId` relates to the signing key.
- **Backward compatibility** — existing unsigned transactions and any persisted history: decide whether verification is enforced immediately or phased in, and how already-committed unsigned transactions are treated.
- **Interaction with recovery/reversal** — Theorem 13 recovery must be able to re-verify the original transaction's client signature; ensure the signature is retained wherever recovery reads from.
- **Replay** — a captured signed transaction must not be re-submittable to double-apply; ensure the stamp's uniqueness (nonce/tail binding) is inside the signed bytes.
