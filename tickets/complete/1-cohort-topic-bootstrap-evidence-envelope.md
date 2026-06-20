description: Adds the on-the-wire format and shared byte-level rules a participant uses to attach cold-start "proof" to a topic-bootstrap request, so the network can later verify that proof. Crypto-free foundation; the actual proof-checking lands in two follow-on tickets.
prereq:
files:
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts (NEW — envelope type, parse/serialize, bound image, PoW preimage/difficulty; crypto-free)
  - packages/db-core/src/cohort-topic/antidos/index.ts (re-export)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts (doc: appPayload → dedicated field)
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1.bootstrapEvidence?: string)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (registerSigningPayload — fixed normalized slot at index 9)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateRegisterV1 — accept/normalize)
  - packages/db-core/src/cohort-topic/walk.ts (RegisterMessageFactory doc — seam note)
  - packages/db-core/src/cohort-topic/service.ts (CohortTopicServiceDeps.buildBootstrapEvidence + bootstrap attach branch; doc tightened in review)
  - packages/db-core/test/cohort-topic/bootstrap-evidence-envelope.spec.ts (NEW — 36 tests)
  - docs/cohort-topic.md (§Anti-DoS bullet 4 + §Wire formats Register note)
----

# Complete: Cohort-topic bootstrap-evidence envelope (db-core, crypto-free foundation)

## What was built

The **structure + canonicalization** layer for cold-start anti-DoS evidence. A participant's
`bootstrap: true` root register can now carry a versioned, fully-parsed `BootstrapEvidenceEnvelopeV1`
in a **dedicated, signature-covered** `RegisterV1.bootstrapEvidence` field, and both sides share the
exact byte images they bind to. **No cryptography** is implemented here — only the wire field, the
envelope codec, the canonical anti-replay bound image, and the PoW puzzle's preimage/difficulty bit
math. The actual hashing, signature checks, and participant-side minting are the two db-p2p follow-ons
in `tickets/implement/` (`2-cohort-topic-bootstrap-evidence-verifiers`,
`3-cohort-topic-bootstrap-parent-reference`).

Public surface (`antidos/bootstrap-evidence-envelope.ts`): `BootstrapEvidenceEnvelopeV1`
(`{ v: 1, pow?, parentRef?, reputation? }`), `BootstrapBoundFields`,
`parseBootstrapEvidenceEnvelope` (total, never throws), `serializeBootstrapEvidenceEnvelope`,
`bootstrapBoundImage`, `powPreimage`, `meetsDifficulty`, `DEFAULT_POW_DIFFICULTY_BITS = 20`. Wire:
additive optional `RegisterV1.bootstrapEvidence?: string`, a fixed normalized signing-payload slot at
array index 9, validator accept/normalize. Participant seam: optional async
`CohortTopicServiceDeps.buildBootstrapEvidence` invoked only on the walk's bootstrap re-issue, bound to
the register's own `(topicId, tier, participantCoord, timestamp)`, set before signing.

## Review findings

Reviewed the full implement diff (commit `ae362ad`) with fresh eyes, the surrounding wire/service/policy
files, the docs, and the two downstream follow-on tickets. **Disposition: one minor doc fix applied
inline; no major findings; no new tickets filed.**

### Checked — and what was found

- **Parse totality (fail-closed, never throws).** Fuzzed `parseBootstrapEvidenceEnvelope` over 28 hostile
  inputs beyond the test set — non-base64url, non-UTF8, non-JSON, `v:2`, `v:"1"`, null/array/string
  bodies, object/array-valued sub-fields, empty/non-string sub-fields, duplicate JSON keys, 5000-deep
  nesting, oversized arrays. **Zero throws**; all malformed inputs → `undefined`; valid round-trips clean.
  `b64urlToBytes`/`utf8Decoder(fatal)`/`JSON.parse` are each guarded by try/catch. ✔ No issue.
- **`meetsDifficulty` bit math.** Verified against an independent leading-zero-bits reference across
  **51,000 vectors** including non-byte-aligned bits (3, 12, 23), oversize-vs-hash-width, empty hash,
  negative, NaN, ±Infinity. **Zero mismatches.** MSB-first masking is correct. ✔ No issue.
- **Signing-image fixed slot.** `bootstrapEvidence` sits at array index 9 in `registerSigningPayload`,
  matching its declaration order in `types.ts` (v, topicId, tier, treeTier, participantCoord, ttl,
  bootstrap, appPayload, **bootstrapEvidence**, timestamp, correlationId) and the test snapshot. Absent ≡
  `""` ≡ `null` placeholder, normalized identically on both signer and verifier. ✔ Consistent.
- **No duplicate signing logic.** db-p2p `host.ts` imports `registerSigningPayload` from db-core and uses
  it for both signing (`:742`) and `verifyPeerSig` (`:497`) — the new slot is covered by the participant
  signature end-to-end, so a MITM cannot strip/swap the evidence. ✔ Verified.
- **Doc accuracy.** Confirmed no remaining "evidence travels in appPayload" claim anywhere
  (`docs/cohort-topic.md` §Anti-DoS + §Wire formats, `bootstrap-evidence.ts` comment all corrected). The
  docs' claim that `appPayload` is copied verbatim into `appState` is confirmed by `member-engine.ts:251`.
  ✔ Docs reflect the new reality.
- **Follow-on seam.** `BootstrapEvidence.verify` and all three injected verifiers receive the full
  `RegisterV1` (`bootstrap-evidence.ts`, `member-engine.ts:308`), so the db-p2p follow-on can call
  `parseBootstrapEvidenceEnvelope(reg)` without a further db-core change. ✔ In place.
- **Build + tests.** `yarn workspace @optimystic/db-core build` clean; `test` → **942 passing** (36 new).
  No lint script in the package; build is the typecheck gate. ✔ Green (before and after the doc edit).

### Fixed inline (minor)

- **Double-encoding footgun on the builder seam.** `CohortTopicServiceDeps.buildBootstrapEvidence`'s doc
  comment said it "returns the serialized envelope bytes ... set on `bootstrapEvidence`", obscuring that
  `service.ts` base64url-encodes the returned raw bytes. A follow-on author could have returned
  `serializeBootstrapEvidenceEnvelope()`'s already-base64url string and double-encoded the field.
  Tightened the comment to state the builder must return **raw** `utf8(JSON.stringify(env))` bytes, NOT
  the `serialize()` string, and that the service base64url-encodes them. (`service.ts`, comment-only.)

### Sanctioned design calls (no change — deliberate, documented, tested)

- **Signing-image format bump.** Adding the index-9 slot makes the canonical register signing image
  intentionally **not** byte-identical to the literal pre-ticket image. This is the correct reading of the
  ticket's explicit "fixed array position, normalized `?? null`" requirement, and is safe in-repo: no
  register signature is persisted or cross-version-verified (registers are ephemeral, signed and verified
  live by the same shared function). The "absent ≡ `""` ≡ `null`" and "non-bootstrap unchanged from this
  baseline" properties hold and are tested.
- **`meetsDifficulty` malformed-difficulty policy.** Negative bits → clamp-to-0 → `true` (open); non-finite
  → `false` (closed). This asymmetry is deliberate and documented; difficulty is a trusted verifier-side
  config constant (not attacker-controlled), and rejecting `bits < 0`/non-integer as unsatisfiable is
  explicitly assigned to the db-p2p verifier. `meetsDifficulty` alone is not a security gate for malformed
  difficulty, and is not relied upon as one.

### Empty categories (explicitly)

- **Major findings: none.** The implementation is correctly scoped as the crypto-free foundation and is
  internally consistent.
- **New tickets filed: none.** Every "honest gap" in the handoff (no verifier reads the envelope yet, no
  participant-side minting, structural-only sub-field validation, `parentTopicId`/`referee` semantics) is
  by-design deferred to the two follow-on tickets that already exist in `tickets/implement/`
  (`cohort-topic-bootstrap-evidence-verifiers`, `cohort-topic-bootstrap-parent-reference`) and depend on
  this one. No work is orphaned.
- **Regressions: none.** Non-bootstrap traffic is byte-identical apart from the always-present `null`
  evidence slot in the (in-repo, non-persisted) signing image; the cross-package db-p2p specs run green.
