description: Make each database transaction carry a cryptographic signature from the client that authored it, and give nodes a hook to check that signature before accepting the transaction — so a misbehaving client can be held accountable for what it submitted. This ticket adds the signature format, the signing/verifying hooks, and the checks in the shared (pure) core; a follow-up wires the real keys.
prereq:
files:
  - packages/db-core/src/transaction/transaction.ts (TransactionStamp/Transaction types; createTransactionStamp/createTransactionId; add nonce + signature + canonical signing bytes)
  - packages/db-core/src/transaction/session.ts (TransactionSession.create/commit — signer seam)
  - packages/db-core/src/transaction/validator.ts (TransactionValidator.validate — verify step + verifier port)
  - packages/db-core/src/transaction/index.ts (exports)
  - packages/db-core/test/transaction.spec.ts (existing validator/session tests; add sig tests)
difficulty: medium
----

Add a client signature to each `Transaction` and a verification hook that a node runs when it first accepts the transaction (pend). This ticket is the **pure `db-core` half** — types, canonical signing bytes, the sign/verify *ports* (function-shaped injection points), session threading, and the validator check — all exercised with in-test fake signer/verifier functions. The real libp2p Ed25519 key wiring is the follow-up `implement-client-tx-signature-p2p` (prereq: this ticket).

Background: `right-is-right.md` §Client Transaction Signatures assumes client-signed transactions for two stories — (1) a cluster member can authenticate a transaction when the client contacts it directly during recovery, and (2) a client can prove authorship so a peer is accountable for what it submitted. Today `TransactionStamp` (`transaction.ts:11`) carries a `peerId` string but no signature, and nothing on the pend path checks one.

## Design decisions (settled — do not re-open)

**Where the signature lives — on `Transaction`, not `TransactionStamp`.** The ticket's original wording said "add to TransactionStamp", but the signature must cover the `statements` and `reads`, which are only final at *commit*, whereas the stamp is created at BEGIN and is stable for the whole lifecycle (its `id` is a hash of the stamp fields alone). Putting a commit-time value on a BEGIN-stable stamp is incoherent. So:
- `TransactionStamp.peerId` stays — it is the **signer identity**.
- Add optional `signature?: string` (base64url) to the **`Transaction`** type — the signature over the transaction inputs.

**What the signature covers — a versioned canonical byte image of `{ stampId, statements, reads }`.** These are exactly the inputs to `createTransactionId`. Define a single deterministic serializer in `transaction.ts`:

```ts
// Version prefix so the signed form can evolve without ambiguity.
export const CLIENT_SIG_VERSION = 'txsig:v1';

/** Canonical bytes a client signs / a node verifies. Deterministic: reads are
 *  sorted (blockId, then revision); statements keep their sequential order. */
export function clientSignaturePayload(
  stampId: string,
  statements: readonly string[],
  reads: readonly ReadDependency[]
): Uint8Array {
  const canonicalReads = [...reads].sort(
    (a, b) => a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1
           : a.revision - b.revision
  );
  const body = JSON.stringify({ stampId, statements, reads: canonicalReads });
  return new TextEncoder().encode(`${CLIENT_SIG_VERSION}:${body}`);
}
```

The signer and verifier both derive the bytes from `transaction.stamp.id` + `transaction.statements` + `transaction.reads` via this function, so they reproduce identical bytes regardless of how `createTransactionId` orders things. **Do not change `createTransactionId`'s existing serialization** in this ticket — the signature payload is self-contained. (Its non-canonical `reads` ordering is a separate hygiene concern; note it, do not fix it here.)

This binds three things at once: the **client identity** (via `stampId`, which hashes `peerId`), the **exact statements**, and the **OCC read set** (block-id + revision = "tail binding" for anti-replay).

**Replay uniqueness — add a `nonce` to the stamp.** A transaction with no reads has nothing binding it to a point in history beyond `expiration` (default 30s), so a captured signed read-free transaction could be re-submitted within the window. Add a random `nonce: string` to `TransactionStamp`, folded into the stamp-id hash (so it flows into the signed bytes via `stampId`). Generate it inside `createTransactionStamp` with `crypto.getRandomValues` (available in Node and browsers — do not import a Node-only RNG). Two otherwise-identical transactions from the same peer at the same millisecond now differ.

**Verification port — injected, verifier stays pure.** `db-core` cannot verify Ed25519 (no libp2p). Add an optional constructor port to `TransactionValidator`:

```ts
/** Returns true iff `signature` (base64url) is a valid client signature over
 *  `payload` for signer identity `peerId`. Total: returns false, never throws,
 *  on any malformed input. The p2p wiring backs this with verifyPeerSig +
 *  peerIdBindsPublicKey; tests pass a fake. */
export type ClientSignatureVerifier =
  (peerId: string, payload: Uint8Array, signature: string) => boolean;
```

In `validate()`, add a step **right after the expiration check** (step 0.5, before the engine lookup):
- If `this.verifyClientSignature` is set:
  - if `transaction.signature` is absent → `{ valid: false, reason: 'Missing client signature' }`;
  - compute `payload = clientSignaturePayload(stamp.id, transaction.statements, transaction.reads)`;
  - if `!this.verifyClientSignature(stamp.peerId, payload, transaction.signature)` → `{ valid: false, reason: 'Invalid client signature' }`.
- If the port is **not** set → skip the check entirely (unsigned transactions still accepted). This is the migration / single-node-dev posture; the p2p ticket adds the enforcement flag that decides whether to inject the port.

**Signer port — injected into the session.** Add an optional signer to `TransactionSession.create`:

```ts
/** Signs the canonical client-signature payload, returning base64url. Async to
 *  allow libp2p PrivateKey.sign; tests pass a synchronous fake. */
export type TransactionSigner = (payload: Uint8Array) => Promise<string> | string;
```

Thread it through the private constructor. In `session.commit()`, after `reads` are collected and the `Transaction` object is built (with `id`), compute `clientSignaturePayload(stamp.id, statements, reads)`, `await` the signer, and set `transaction.signature` before calling `coordinator.commit(transaction)`. If no signer was supplied, leave `signature` undefined (unsigned — accepted only where verification is off).

## Types (target shape)

```ts
export type TransactionStamp = {
  peerId: string;
  timestamp: number;
  schemaHash: string;
  engineId: string;
  expiration: number;
  nonce: string;   // NEW — random, folded into id; anti-replay for read-free txns
  id: string;      // now hashes nonce too
};

export type Transaction = {
  stamp: TransactionStamp;
  statements: string[];
  reads: ReadDependency[];
  id: string;
  signature?: string;   // NEW — base64url, over clientSignaturePayload(...)
};
```

## Edge cases & interactions

- **Missing vs. invalid signature** — with the verifier port present, both reject at pend, with distinct reasons (`Missing` vs `Invalid`). Test both.
- **Verifier port absent** — unsigned and signed transactions BOTH pass the sig step (no enforcement). Existing tests that build unsigned transactions and validate them must keep passing unchanged. Confirm the whole existing `transaction.spec.ts` suite is green.
- **Read-free transaction replay** — two sessions from the same `peerId` with identical statements and no reads must produce different `stamp.id` (hence different signed bytes and different `transaction.id`), because of the nonce. Add a test asserting non-equal ids.
- **Reads-ordering determinism** — the same transaction with its `reads` array in two different orders must produce the **same** `clientSignaturePayload` bytes (the sort makes it canonical), so a signature made in one order verifies in the other. Test it.
- **Tamper detection** — mutating any of {a statement, a read's revision, the peerId} after signing must make verification fail (the fake verifier in the test should recompute the payload and compare). Cover statement-tamper and read-revision-tamper.
- **Expiration precedence** — an expired transaction still rejects on expiration first (the sig step is after it); an unexpired one with a bad signature rejects on the signature. Keep the ordering so an attacker can't learn signature-validity for expired transactions.
- **Recovery retention (Theorem 13 hook)** — `signature` is a plain field on `Transaction`; wherever a `Transaction` is serialized/persisted (cluster record, log entry), the field rides along for free as long as nothing strips unknown fields. Add a note/assertion that a round-tripped `Transaction` keeps `signature`, so the later recovery path can re-verify the original. No recovery re-verification logic in this ticket — just don't drop the field.
- **Backward-compat of stamp id** — adding `nonce` to the id hash changes stamp/transaction ids relative to old builds. That is acceptable (ids are content hashes, not persisted consensus keys like `messageHash`), but call it out; do not attempt to preserve old id bytes.
- **Coordinate with canonical-serialization (`design-consensus-hygiene-notes`)** — that plan pins a versioned canonical form for the operations hash. This client-signature payload is a *separate* canonical form (transaction inputs, not operations) and is self-contained/versioned here (`txsig:v1`). Keep the two consistent in spirit (versioned, deterministic); do not block on it.

## TODO

- Add `nonce` to `TransactionStamp`; generate it in `createTransactionStamp` via `crypto.getRandomValues`; fold into the stamp-id hash. Keep `createTransactionStamp`'s external call sites compiling (nonce is generated internally, not a new required param).
- Add `signature?: string` to `Transaction`.
- Add `CLIENT_SIG_VERSION`, `clientSignaturePayload(...)`, and the `TransactionSigner` / `ClientSignatureVerifier` port types to `transaction.ts`; export from `transaction/index.ts`.
- Thread an optional `signer?: TransactionSigner` through `TransactionSession.create` and the private constructor; in `commit()` set `transaction.signature` from it (skip when absent).
- Add an optional `verifyClientSignature?: ClientSignatureVerifier` constructor arg to `TransactionValidator`; add the step-0.5 check in `validate()` (missing → reject, invalid → reject, port absent → skip).
- Tests (in `transaction.spec.ts`, using fake synchronous signer/verifier closures):
  - signed transaction verifies and validates (valid);
  - missing signature with verifier present → reject (`Missing client signature`);
  - tampered statement / tampered read revision → reject (`Invalid client signature`);
  - reads-order-independence: same bytes for reordered reads;
  - nonce: two read-free sessions from same peer/statements → different ids;
  - verifier absent → unsigned transaction still valid (compat);
  - `Transaction` round-trips through `JSON.parse(JSON.stringify(tx))` retaining `signature`.
- Run `yarn workspace @optimystic/db-core build` and `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/dbcore-test.log` (stream, don't silent-redirect). Fix any regressions caused by the type/id changes.
