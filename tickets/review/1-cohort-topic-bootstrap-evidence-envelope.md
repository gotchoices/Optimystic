description: Review the new on-the-wire format and shared byte-level rules a participant uses to attach cold-start "proof" to a topic-bootstrap request, so the network can later check that proof.
prereq:
files:
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts (NEW — envelope type, parse/serialize, bound image, PoW preimage/difficulty; all crypto-free)
  - packages/db-core/src/cohort-topic/antidos/index.ts (re-export)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts (doc comment: "in appPayload" → dedicated field)
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1.bootstrapEvidence?: string)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (registerSigningPayload — fixed normalized slot)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateRegisterV1 — accept/normalize)
  - packages/db-core/src/cohort-topic/walk.ts (RegisterMessageFactory doc — seam note, signature unchanged)
  - packages/db-core/src/cohort-topic/service.ts (CohortTopicServiceDeps.buildBootstrapEvidence + messageFactory bootstrap branch)
  - packages/db-core/test/cohort-topic/bootstrap-evidence-envelope.spec.ts (NEW — 36 tests)
  - docs/cohort-topic.md (§Anti-DoS bullet 4 + §Wire formats Register note)
difficulty: hard
----

# Review: Cohort-topic bootstrap-evidence envelope (db-core, crypto-free foundation)

## What was built

The **structure + canonicalization** layer for cold-start anti-DoS evidence. A participant's
`bootstrap: true` root register can now carry a versioned, fully-parsed `BootstrapEvidenceEnvelopeV1`
in a **dedicated, signature-covered** `RegisterV1.bootstrapEvidence` field, and both sides share the
exact byte images they bind to. **No cryptography** is implemented here — only the wire field, the
envelope codec, the canonical anti-replay bound image, and the PoW puzzle's preimage/difficulty bit
math. The actual hashing and signature checks (and the participant-side minting) are the two db-p2p
follow-ons (`cohort-topic-bootstrap-evidence-verifiers`, `cohort-topic-bootstrap-parent-reference`).

### Public surface (new, in `antidos/bootstrap-evidence-envelope.ts`)

```ts
interface BootstrapEvidenceEnvelopeV1 {
  v: 1;
  pow?:        { nonce: string };                          // base64url
  parentRef?:  { parentTopicId: string; sig: string };     // base64url
  reputation?: { referee: string; sig: string };           // base64url
}
type BootstrapBoundFields = Pick<RegisterV1, "topicId"|"tier"|"participantCoord"|"timestamp">;

parseBootstrapEvidenceEnvelope(reg): EnvelopeV1 | undefined   // TOTAL — never throws
serializeBootstrapEvidenceEnvelope(env): string              // base64url JSON field-value
bootstrapBoundImage(reg): Uint8Array                         // utf8(JSON ["BootstrapEvidenceV1", topicId, tier, participantCoord, timestamp])
powPreimage(reg, nonce): Uint8Array                          // boundImage ‖ nonce
meetsDifficulty(hash, bits): boolean                         // ≥ bits leading zero bits, MSB-first
const DEFAULT_POW_DIFFICULTY_BITS = 20
```

### Wire / signing changes

- `RegisterV1.bootstrapEvidence?: string` — additive optional base64url field; absent on all
  non-bootstrap traffic, so that traffic is byte-identical to before.
- `registerSigningPayload` gained a **fixed normalized slot at array index 9** (between `appPayload`
  at 8 and `timestamp` at 10): `(undefined | "") → null`, else the string. This follows the existing
  in-file convention (`bootstrap ?? false`, `appPayload ?? null` already sit at fixed positions).
- `validateRegisterV1` accepts an optional base64url `bootstrapEvidence`; `""` is normalized to absent;
  a non-string is rejected as `CohortWireError`.

### Participant attach seam

- `CohortTopicServiceDeps.buildBootstrapEvidence?` — optional async builder, invoked **only** on the
  walk's bootstrap re-issue, bound to the register's own `(topicId, tier, participantCoord, timestamp)`.
  Its returned bytes are set on `body.bootstrapEvidence` (base64url-encoded) **before** signing, so the
  participant signature covers them. Default `undefined` → no evidence attached (today's behavior).
- `RegisterMessageFactory.build` signature **unchanged** (per ticket); only a doc note was added.

## How to validate

Build + tests already pass locally:
- `yarn workspace @optimystic/db-core build` — clean typecheck.
- `yarn workspace @optimystic/db-core test` — **942 passing** (36 new in `bootstrap-evidence-envelope.spec.ts`).
- `yarn workspace @optimystic/db-p2p build` — clean (db-p2p recomputes the same `registerSigningPayload`).
- db-p2p cross-package specs run green: `peer-key-signing.spec.ts` (signing round-trip),
  `host-antidos-coldstart.spec.ts`, `service.spec.ts`, the two `cohort-topic-scale-*` specs.

### Use cases the tests cover (the floor, not the ceiling)

- **Round-trip** each kind + a multi-kind envelope through `serialize → field → parse`; canonical
  serialize is independent of source key order.
- **Total parse / fail-closed**: absent, `""`, non-base64url, non-JSON, `v: 2`, missing/empty/non-string
  sub-fields, non-object/array bodies all → `undefined` (never throw). Unknown future *keys* within a
  v1 envelope are ignored (known kinds still read).
- **Anti-replay bound image** stable for a tuple, differs across topicId / tier / participantCoord /
  timestamp; emits the documented canonical array.
- **`powPreimage`** = boundImage ‖ nonce, and changes with the nonce.
- **`meetsDifficulty`** vectors at bits ∈ {0,1,8,9,20}, MSB-first byte order, oversize bits
  (unsatisfiable past the hash width even for an all-zero hash), and defensive non-finite/negative guards.
- **Signing image**: non-bootstrap snapshot (the fixed `null` slot at index 9); absent ≡ `""`; a present
  value occupies the slot and changes nothing else.
- **Validator** accept/reject paths for the new field.
- **Service factory**: a bootstrap re-issue mints + signs evidence (field on the wire == `serialize(env)`,
  round-trips to the envelope, present in the signed body); a non-bootstrap register never calls the builder.

## Reviewer attention — decisions, footguns, and honest gaps

1. **Signing-image format bump (please sanction).** The source ticket said in places the image stays
   "byte-identical / unchanged vs pre-field baseline", but its explicit requirement — "MUST include
   `bootstrapEvidence` (normalized `?? null`) at a fixed array position" — and the established in-file
   convention (`bootstrap`/`appPayload` already at fixed normalized positions) are mutually exclusive
   with literal byte-identity once a slot is added. I implemented the **fixed-slot** design: the
   canonical register signing image now always carries a trailing-region `bootstrapEvidence` slot, so it
   is **NOT** byte-identical to the literal pre-ticket image. This is safe in-repo (signer and verifier
   both call the same updated function; no register signature is persisted across the change; the
   "absent ≡ "" ≡ null" and "non-bootstrap unchanged-from-this-baseline" properties hold and are tested).
   If a reviewer disagrees, the only alternative (conditional append only when present) contradicts the
   "fixed position / `?? null`" requirement — flag it as a design call rather than an inline fix.

2. **Double-encoding contract on the builder seam (footgun).** `buildBootstrapEvidence` returns **raw
   envelope JSON bytes** (`utf8(JSON.stringify(env))`); `service.ts` then base64url-encodes them into the
   field. `serializeBootstrapEvidenceEnvelope` returns the **already-base64url field-value string**.
   Both produce the identical field value (the service test asserts
   `field === serializeBootstrapEvidenceEnvelope(env)`). The db-p2p follow-on builder must return raw
   bytes, **not** the `serialize()` string (doing the latter would double-encode). Worth confirming the
   doc comments make this unambiguous for the follow-on author.

3. **`meetsDifficulty` negative/non-finite policy.** `bits = 0` → true; negative clamps to 0 → true
   (documented as "even weaker than 0"); NaN/±Infinity → false. The ticket assigns "reject bits < 0 /
   non-integer as unsatisfiable" to the **verifier (db-p2p)**, which is expected to pre-check before
   relying on this function. Confirm that division of responsibility is acceptable — `meetsDifficulty`
   alone is not a security gate for malformed difficulty.

4. **Not in scope (honest gaps — by design, deferred to db-p2p follow-ons):**
   - **No verifier reads the envelope yet.** `member-engine.ts` still consumes the existing
     `BootstrapEvidence` *policy* dep over host-injected permissive-but-logged verifiers; those verifiers
     receive the full `RegisterV1` and *can now* call `parseBootstrapEvidenceEnvelope(reg)`, but none do
     yet. `bootstrap-evidence.ts` (the tier policy) was not changed beyond a doc-comment correction.
   - **No participant-side minting.** `buildBootstrapEvidence` defaults to `undefined`; behavior is
     identical to today until db-p2p injects a real builder.
   - **Structural-only sub-field validation.** Parse checks each byte sub-field decodes as base64url and
     is non-empty; semantic validity (lengths, real signatures, that `parentTopicId` exists, that
     `referee` is reputable) is entirely the verifier's job.
   - **`parentTopicId` / `referee` semantics** (what they reference, how a verifier resolves a key or a
     parent's existence) are defined by the follow-on tickets, not here.

5. **Test ergonomics.** The service-factory test casts `gossipBus`/`verifier` to `{}` — the `register()`
   path never touches them (they back only `cohortGossip()`/`verifier()`). Note rather than a concern.

## Suggested adversarial checks for the reviewer

- Confirm `parseBootstrapEvidenceEnvelope` truly never throws on hostile input beyond the cases tested
  (e.g. deeply nested JSON, a sub-field that is an object/array rather than a string, duplicate keys).
- Confirm the index-9 placement of `bootstrapEvidence` in `registerSigningPayload` matches the field's
  declaration order in `types.ts` and that no other payload helper drifted.
- Confirm `meetsDifficulty` bit math against an independent reference for a non-byte-aligned `bits` value
  not in the tested set (e.g. 3, 12, 23).
- Confirm the doc edits (§Anti-DoS bullet 4, §Wire formats Register note) and the `bootstrap-evidence.ts`
  comment no longer claim the evidence "travels in appPayload" anywhere.
