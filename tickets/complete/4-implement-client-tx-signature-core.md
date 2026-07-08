description: Reviewed the pure-core half of client-signed database transactions — signature field, random anti-replay nonce, and injectable sign/verify hooks. Build and full test suite pass; one major gap found (stamp metadata isn't covered by the signature) and filed as a follow-up that now gates the p2p wiring.
prereq:
files:
  - packages/db-core/src/transaction/transaction.ts
  - packages/db-core/src/transaction/session.ts
  - packages/db-core/src/transaction/validator.ts
  - packages/db-core/src/transaction/index.ts
  - packages/db-core/test/transaction.spec.ts
----

## What shipped

The pure `db-core` half of client transaction signatures. Every `Transaction` can carry a
client `signature`; a validating node can verify it at pend (step 0.5) when a
`ClientSignatureVerifier` port is wired. A random `nonce` is folded into `stamp.id`.
Real Ed25519 key wiring and the enforcement flag are the follow-up
`implement-client-tx-signature-p2p`. See the implement commit `3bad001` for the diff.

## Review findings

Adversarial pass over the implement diff (`git show 3bad001`), read before the handoff.

### Verified — build & tests
- `yarn workspace @optimystic/db-core build` → exit 0, clean.
- `yarn workspace @optimystic/db-core test` → **1198 passing, 0 failing** (reproduced locally,
  not just trusted from the handoff). The rewritten clock-skew test (`should produce distinct
  stamp IDs…`, asserting `not.equal`) is the intended correction of a former deterministic-id
  collision, not a regression.
- No lint step exists in `db-core` (`package.json` has `build`/`test` only) — nothing to run.

### Checked — clean, no action
- **Convention match.** `randomBytes` from `@noble/hashes/utils.js` + `uint8arrays/to-string`
  base64url match existing db-core usage (`collection.ts`, `transactor-source.ts`, etc.).
  Accepted the implementer's documented deviation from the ticket's `crypto.getRandomValues`.
- **No external breakage from required `nonce`.** Every construction site outside the factory
  is either `createTransactionStamp(...)` (quereus tests) or `stamp: {} as any` (db-p2p tests);
  none is a typed literal that would now miss `nonce`. Build confirms.
- **`clientSignaturePayload` determinism.** Reads sorted via a **copy** (`[...reads].sort`),
  no input mutation; statements order preserved; version-prefixed. Sort key `(blockId string,
  revision number)` compares correctly. Reads-order-independence test present and passing.
- **Ordering precedence.** Expiration (step 0) before signature (step 0.5) is exercised and
  correct, so signature-validity can't be probed on an expired transaction.
- **Verifier-absent posture.** Unsigned + signed both accepted with no verifier; missing-sig
  and bad-sig both rejected with a verifier. All covered.
- **peerId-tamper test** passes for the fake for a different reason than a real Ed25519 verifier
  would (the implementer flagged this) — acceptable; the p2p ticket exercises the real path.

### MAJOR — filed as a ticket (not fixed in this pass)
- **Stamp metadata is not bound by the signature.** `clientSignaturePayload` signs
  `stamp.id` (a hash) + statements + reads, and the validator **never re-verifies that
  `stamp.id` equals the hash of the stamp fields**. It trusts `stamp.expiration`,
  `stamp.engineId`, `stamp.peerId` straight off the wire. Result: an attacker can mutate
  `stamp.expiration` (extend TTL — defeating the nonce's replay-window intent), `engineId`,
  `schemaHash`, or `timestamp` while keeping `stamp.id` + `signature` valid, and it is
  accepted. Dormant today (no verifier wired) but goes live the instant the p2p verifier
  lands. Filed **`fix/bind-stamp-fields-to-tx-signature`** (validator must reject a stamp
  whose id ≠ hash-of-fields, before the expiration check) and added it as a **prereq of
  `implement-client-tx-signature-p2p`**, plus a stamp-field-tamper edge case in that ticket.

### Tripwire — recorded, not a ticket (as designed)
- `createTransactionId` still serializes `reads` in given (non-canonical) order, unlike the
  signed payload. The implementer left a `NOTE`-style doc-comment at the site pointing at
  `design-consensus-hygiene-notes`. Confirmed present and correct; only matters if/when
  tx-ids need order-independence. Left as-is.

### Not filed — intentionally out of scope
- Real signer/verifier semantics (malformed-base64url-doesn't-throw, wrong-key impersonation,
  base64url round-trip): the `ClientSignatureVerifier` "total, never throws" contract is
  asserted only by doc-comment here because no real verifier exists yet. `implement-client-
  tx-signature-p2p` already lists these as required tests.
