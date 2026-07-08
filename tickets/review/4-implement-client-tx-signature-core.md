description: Review the pure-core half of client-signed database transactions — each transaction now carries a client signature, a random nonce guards against replay, and nodes have injectable hooks to sign at commit and verify at accept. Real key wiring is a separate follow-up.
prereq:
files:
  - packages/db-core/src/transaction/transaction.ts (nonce, signature, clientSignaturePayload, CLIENT_SIG_VERSION, port types)
  - packages/db-core/src/transaction/session.ts (signer threading)
  - packages/db-core/src/transaction/validator.ts (verifier port + step 0.5)
  - packages/db-core/src/transaction/index.ts (exports)
  - packages/db-core/test/transaction.spec.ts (new "Client Transaction Signatures" block + rewritten clock-skew test)
difficulty: medium
----

## What this ticket built

The pure `db-core` half of client transaction signatures. Every database `Transaction` can now carry a cryptographic signature from the client that authored it, and a validating node can verify that signature the moment it first accepts (pends) the transaction. The actual Ed25519 key material is **not** wired here — this ticket provides the *shape* (types, canonical bytes, injectable sign/verify hooks) and exercises it with in-test fakes. The real libp2p key wiring is the follow-up `implement-client-tx-signature-p2p` (which has this ticket as a prereq).

### Concrete changes

**`transaction.ts`**
- `TransactionStamp` gained a required `nonce: string` — random 16 bytes (base64url), folded into the stamp-id hash. Generated inside `createTransactionStamp`; no new call-site parameter.
- `Transaction` gained optional `signature?: string` (base64url).
- New `CLIENT_SIG_VERSION = 'txsig:v1'` and `clientSignaturePayload(stampId, statements, reads): Uint8Array` — a deterministic, version-prefixed byte image of `{stampId, statements, reads}` where **reads are sorted** (blockId, then revision) and statements keep order.
- New port types `TransactionSigner` (async-or-sync, payload → base64url) and `ClientSignatureVerifier` (peerId, payload, signature → bool; total, never throws).

**`session.ts`** — `TransactionSession.create` takes an optional trailing `signer?: TransactionSigner`, threaded through the private constructor. `commit()` computes the payload from the final `{stamp.id, statements, reads}` and sets `transaction.signature` before `coordinator.commit`. No signer → `signature` stays undefined.

**`validator.ts`** — `TransactionValidator` constructor takes an optional 4th arg `verifyClientSignature?: ClientSignatureVerifier`. New **step 0.5** runs *after* expiration, *before* engine lookup: verifier absent → skip entirely; present + no signature → reject `Missing client signature`; present + bad signature → reject `Invalid client signature`.

**`index.ts`** — exports the two new values and two new types.

## Design decisions carried out (from the plan; do not re-litigate)

- Signature lives on **`Transaction`**, not `TransactionStamp` (it must cover commit-time `statements`/`reads`; the stamp is BEGIN-stable).
- Signature payload is **self-contained and versioned**; `createTransactionId`'s serialization was deliberately **not** touched.
- Verifier-absent posture = unsigned transactions still accepted (migration / single-node-dev). Enforcement flag is the p2p ticket's job.
- Expiration is checked **before** the signature so an attacker can't probe signature-validity on an expired transaction.

## Deviation from the ticket text (reviewer: confirm you accept)

The ticket said generate the nonce with `crypto.getRandomValues`. I used `randomBytes` from `@noble/hashes/utils.js` + `uint8arrays` base64url encoding instead, because **that is the established cross-platform CSPRNG convention throughout `db-core`** (`collection.ts:284`, `transactor-source.ts:35`, `cohort-topic/service.ts:409`, `matchmaking/*`). It satisfies the ticket's actual constraint ("available in Node and browsers — do not import a Node-only RNG": noble's `randomBytes` uses WebCrypto under the hood) and reads like the surrounding code. Behavior is identical; only the RNG import differs.

## Validation performed

- `yarn workspace @optimystic/db-core build` — clean (exit 0, emits `dist/.../transaction.js`).
- `yarn workspace @optimystic/db-core test` — **1198 passing, 0 failing**. The new `Client Transaction Signatures` describe block is **12 passing** (confirmed via `--grep`).
- No dependent package breaks: the only external consumers (`quereus-plugin-optimystic` tests) build stamps via the `createTransactionStamp` factory and use optional `signature`, so the added required `nonce` and optional `signature` typecheck without edits.

### Tests added (`test/transaction.spec.ts`, `Client Transaction Signatures`)
Fake signer/verifier are a deterministic MAC (`fakesig:<peerId>:<decoded-payload>`) that binds identity + exact bytes.
- correctly signed tx → **valid** (full pipeline: sig + engine re-exec + ops-hash match).
- verifier present, no signature → reject `Missing client signature`.
- statement tampered after signing → reject `Invalid client signature`.
- read-revision tampered after signing → reject `Invalid client signature`.
- peerId tampered after signing → reject `Invalid client signature`.
- reads-order-independence: identical payload bytes for reordered reads; a signature made over one ordering verifies against the other.
- nonce: two same-arg `createTransactionStamp` calls → different `nonce`, `id`, and downstream tx id.
- session with a signer stamps a verifying signature; two read-free sessions (same peer/statement) → different stamp & tx ids.
- session without a signer → `signature` undefined.
- verifier absent → unsigned tx still valid (migration compat).
- expired + bad signature → rejects on **expiration** (ordering precedence).
- `JSON.parse(JSON.stringify(tx))` retains `signature` and it still verifies (recovery re-verify hook).

### Rewritten test (behavior change is intended)
`Clock Skew and Ordering (TEST-10.8.1) › should produce identical stamp IDs …` **documented the old collision as a BUG** (`expect(txId1).to.equal(txId2)`). The nonce fixes exactly that hole, so it was renamed to `should produce distinct stamp IDs …` and now asserts `not.equal`. This failure surfaced under my change and is the intended correction — **not** a pre-existing failure.

## What a reviewer should scrutinize (my tests are a floor)

- **Fake-verifier realism.** My fake is a MAC, not a real signature scheme. It cannot catch a class of bug where the real Ed25519 verify has different failure semantics (e.g. throws on malformed base64url instead of returning false). The `ClientSignatureVerifier` contract says "total: returns false, never throws" — that guarantee is only *asserted by contract* here, never exercised, because no real verifier exists yet. The p2p ticket must test malformed-signature-doesn't-throw.
- **`clientSignaturePayload` determinism edge cases.** `JSON.stringify` of `statements` (a `string[]`) is order-preserving and safe, but the payload does **not** canonicalize anything inside a statement string (engine-opaque). Two engines that encode the same logical op differently would sign different bytes — acceptable (statements are the signed artifact) but worth a conscious nod.
- **Reads sort stability.** The sort key is `(blockId, revision)`. If two reads share the same `(blockId, revision)` they're duplicates and order among them is irrelevant to bytes; confirm the OCC layer never produces semantically-distinct reads colliding on that key.
- **`delete tx.signature` in the missing-sig test** relies on `signature` being an optional property; fine, but if the type ever becomes required this test breaks loudly (desired).

## Tripwire recorded (NOT a ticket)

`createTransactionId` in `transaction.ts` still serializes `reads` in **given order** (non-canonical), unlike `clientSignaturePayload` which sorts. This is intentional for this ticket (signature payload is self-contained; changing tx-id serialization would churn existing ids). I left a `NOTE`-style comment in the `createTransactionId` doc-comment pointing at `design-consensus-hygiene-notes`. It only becomes work if/when tx-ids need order-independence — do not file it now.

## Explicitly out of scope (follow-up `implement-client-tx-signature-p2p`)

- Real libp2p Ed25519 signer (`PrivateKey.sign`) and verifier (`verifyPeerSig` + `peerId ↔ publicKey` binding).
- The enforcement flag that decides whether a node injects the verifier port at all.
- Recovery-time re-verification logic (this ticket only guarantees the `signature` field survives serialization; it adds no re-verify path).
