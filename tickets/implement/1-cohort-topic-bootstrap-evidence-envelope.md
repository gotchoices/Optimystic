description: Define the on-the-wire format a participant uses to attach cold-start "proof" to a topic-bootstrap request, plus the shared byte-level rules both sides agree on, so the network can later check that proof.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (RegisterV1 — add the dedicated evidence field)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (registerSigningPayload — cover the new field)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateRegisterV1 — accept/normalize the new field)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence-envelope.ts (NEW — envelope type + parse/serialize + bound-image + PoW preimage/difficulty, all crypto-free)
  - packages/db-core/src/cohort-topic/antidos/index.ts (re-export the new module)
  - packages/db-core/src/cohort-topic/walk.ts (RegisterMessageFactory — add the bootstrap-evidence builder seam)
  - packages/db-core/src/cohort-topic/service.ts (messageFactory — invoke the builder on the bootstrap re-issue)
  - packages/db-core/test/cohort-topic/bootstrap-evidence-envelope.spec.ts (NEW)
  - docs/cohort-topic.md (§Anti-DoS bullet 4 + §Wire formats Register note)
difficulty: hard
----

# Cohort-topic: bootstrap-evidence envelope format (db-core foundation)

This is the **db-core, crypto-free foundation** for the real bootstrap-evidence verifiers. It defines
*where* the evidence rides on the wire, the *versioned envelope* that carries it, the *canonical byte
images* both the participant (who mints evidence) and the cohort (who verifies it) agree on, and the
participant-side *seam* through which a db-p2p builder attaches it. The actual cryptographic checks and
the participant-side minting live in the two follow-on db-p2p tickets
(`cohort-topic-bootstrap-evidence-verifiers`, `cohort-topic-bootstrap-parent-reference`); this ticket
embeds **no PoW/reputation/committed-work scheme** — only structure and canonicalization.

## Background

`docs/cohort-topic.md` §Anti-DoS bullet 4: a cold root accepting `bootstrap: true` must demand one of
a small proof-of-work, a signature from a sufficiently-reputable peer, or a signed reference to a
parent topic that exists — tier-dependent (T0/T1 → parent reference; T2/T3 → PoW OR reputation OR
parent reference). The tier *policy* already exists
(`packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts`,
`createBootstrapEvidence` / `BootstrapEvidence.verify(reg, tier)`) and consumes three injected
synchronous verifiers `(reg: RegisterV1) => boolean`. Today db-p2p injects a permissive-but-logged
fallback (`host.ts` `createBootstrapEvidencePolicy`). This ticket gives the verifiers a real,
fully-parsed structure to read.

### Decision: a dedicated `bootstrapEvidence` wire field, NOT `appPayload`

The source plan ticket said the evidence "travels in `appPayload`". **This implementation deliberately
uses a dedicated, additive `RegisterV1.bootstrapEvidence?: string` field instead.** Rationale (resolved
here, not left to the implementer):

- `appPayload` is the **opaque application slot** — on admission the cohort copies it verbatim into the
  registration record's `appState` (`member-engine.ts` `appState: b64urlToBytes(reg.appPayload)`;
  `service.ts` `appState: req.appPayload`) and replicates it cluster-wide in cohort gossip
  (`GossipRecordV1.appState`). A cold-root bootstrap register is the *first* registration, where the
  application still needs its real `appState` (reactivity `lastDeliveredRev`, matchmaking provider
  metadata). Overloading `appPayload` would (a) displace that appState on the very register that needs
  it, (b) replicate bulky PoW bytes forever as appState, and (c) force the substrate to parse the slot
  it contractually treats as opaque.
- A dedicated field is parsed by the substrate, **covered by the participant register signature**
  (so a MITM cannot strip/swap it), and **never stored as appState**.

This is an **additive, optional** field — same shape as the existing optional `bootstrap` / `appPayload`
(absent on every non-bootstrap register, so non-bootstrap traffic is byte-identical and unaffected). Update
`docs/cohort-topic.md` §Anti-DoS bullet 4 and the §Wire formats Register note to describe the dedicated
field and supersede the "in appPayload" phrasing.

## Envelope format (`bootstrap-evidence-envelope.ts`)

A small, **versioned, fully-parsed** structure (no ad-hoc parsing) — the sibling discipline of
`sig/payloads.ts` / `wire/payloads.ts` (explicitly-ordered arrays, deterministic UTF-8 JSON, base64url
without padding). Carries at most the evidence kinds a tier accepts; a verifier reads only its kind.

```ts
/** V1 bootstrap-evidence envelope, base64url-encoded into RegisterV1.bootstrapEvidence. */
export interface BootstrapEvidenceEnvelopeV1 {
  v: 1;
  /** Proof-of-work (T2/T3 path). Absent → no PoW offered. */
  pow?: { nonce: string };                 // nonce: base64url, bound via the PoW preimage below
  /** Signed parent-topic reference (all tiers). Absent → none offered. */
  parentRef?: { parentTopicId: string; sig: string };   // both base64url; sig over the bound image
  /** Reputation endorsement (T2/T3 path). Absent → none offered.
   *  referee: peer-id-string bytes (base64url); sig: referee peer-key sig over the bound image.
   *  referee MAY equal the participant (a reputable participant self-vouches). */
  reputation?: { referee: string; sig: string };
}
```

- `parseBootstrapEvidenceEnvelope(reg: RegisterV1): BootstrapEvidenceEnvelopeV1 | undefined` — decode
  `reg.bootstrapEvidence` (base64url → JSON), structurally validate, return `undefined` on absent /
  malformed / wrong-version (a verifier treats `undefined` as "this kind not offered" → fails its
  check, never throws). **Total** like `verifyPeerSig`: any decode error → `undefined`, never throw.
- `serializeBootstrapEvidenceEnvelope(env): string` — the inverse (base64url JSON), for the builder
  and tests.

### Canonical bound image (anti-replay)

Both the PoW preimage and the parentRef/reputation signatures bind the **same tuple** so evidence
minted for one (topic, tier, peer, time) cannot be replayed for another (ticket use-case 3):

```ts
/** The bytes every bootstrap-evidence kind is bound to: (topicId, tier, participantCoord, timestamp). */
export function bootstrapBoundImage(reg: RegisterV1): Uint8Array;
// = utf8(JSON.stringify(["BootstrapEvidenceV1", reg.topicId, reg.tier, reg.participantCoord, reg.timestamp]))
```

(`topicId`/`participantCoord` are already the base64url wire strings — bind those verbatim so signer and
verifier never re-canonicalize bytes independently, matching `sig/payloads.ts`.) Note the register's
freshness/replay guard already drops a `timestamp` older than `DEFAULT_REPLAY_MAX_AGE_MS` (60 s) and any
exact `correlationId` replay, so binding `timestamp` bounds a captured proof's reuse window even for the
same tuple.

### PoW preimage + difficulty (crypto-free canonicalization only)

db-core owns the *format* of the puzzle, not the hashing (db-p2p hashes via the node's `RingHash`):

```ts
/** PoW hash preimage: the bound image ‖ nonce. db-p2p hashes this and checks meetsDifficulty. */
export function powPreimage(reg: RegisterV1, nonce: Uint8Array): Uint8Array;   // bootstrapBoundImage(reg) ‖ nonce
/** True iff the first `bits` MSBs of `hash` are zero (the difficulty target). */
export function meetsDifficulty(hash: Uint8Array, bits: number): boolean;
/** Default PoW difficulty: leading zero bits required. ~2^bits hashes to mint, one hash to verify. */
export const DEFAULT_POW_DIFFICULTY_BITS = 20;
```

The puzzle: `hash(bootstrapBoundImage(reg) ‖ nonce)` must have `≥ powDifficultyBits` leading zero bits.
Bound to `(topicId, tier, participantCoord, timestamp)` ⇒ no cross-topic / cross-peer replay; cheap to
verify (one hash + bit check), tunably costly to produce. `meetsDifficulty` reads MSB-first per byte
(mirror `addressing.ts` `prefix` bit order). `bits = 0` ⇒ always true (lets a config disable PoW cost
for tests). Reject `bits < 0` / non-integer by treating as unsatisfiable in the verifier (db-p2p), but
`meetsDifficulty` itself should clamp/guard defensively.

## Participant-side attach seam

The walk decides `bootstrap` internally on the root re-issue (`walk.ts` register loop), so the
application cannot pre-attach evidence. Add an **optional builder callback** to `RegisterMessageFactory`,
invoked **only** when `params.bootstrap` is true:

```ts
// walk.ts RegisterMessageFactory
interface RegisterMessageFactory {
  build(params: { topicId; tier; treeTier; bootstrap; appPayload? }): Promise<RegisterV1>;
}
// service.ts messageFactory(): when params.bootstrap, call the injected
//   deps.buildBootstrapEvidence?.({ topicId, tier, participantCoord, timestamp }) => Promise<Uint8Array | undefined>
// and, if it returns bytes, set body.bootstrapEvidence = bytesToB64url(bytes) BEFORE signing
// (so the participant register signature covers it).
```

Add `buildBootstrapEvidence?` to `CohortTopicServiceDeps` (db-core defines the seam, defaults to
undefined → no evidence attached, exactly today's behavior). The db-p2p builder is the follow-on ticket.
Keep `RegisterRequest`/`service.register` unchanged (the builder is keyed off `tier` + the bootstrap
re-issue, not an extra per-call arg).

## Edge cases & interactions

- **Non-bootstrap register unaffected.** `bootstrapEvidence` absent ⇒ `registerSigningPayload`
  normalizes it to `null` (like `appPayload`), so existing signed registers and their verification are
  byte-identical. Assert a non-bootstrap register's signing image is unchanged by the new field.
- **Signature coverage / normalization.** `registerSigningPayload` MUST include `bootstrapEvidence`
  (normalized `?? null`) at a fixed array position; signer and verifier agree byte-for-byte. A
  present-but-empty-string vs absent field must not produce two distinct images — normalize empty to the
  same placeholder as absent (decide: treat `""` as absent in both the validator and the payload image).
- **Builder runs before signing.** The evidence must be in `body` before `signer.signRegister(body)`,
  else the field is unsigned and strippable. Cover with a test: a built envelope is present in the
  signed image (round-trip `registerSigningPayload`).
- **Malformed / wrong-version / oversized envelope → `undefined`, never throw.** `parse…` is total.
  An attacker-supplied `bootstrapEvidence` that is not valid base64url, not JSON, wrong `v`, or missing
  required sub-fields decodes to `undefined` (the verifier then fails its check → `unwilling_cohort`).
- **Decode bound by `max_message_bytes`.** The codec already rejects an oversized frame before parse;
  the envelope is a sub-field of an already-bounded RegisterV1, so no separate size limit is needed, but
  do not allocate based on any length declared *inside* the envelope.
- **`meetsDifficulty` boundary:** `bits = 0` → true; `bits` not a multiple of 8 → check the partial
  final byte's MSBs; `bits` larger than `hash.length*8` → require all-zero (effectively unsatisfiable).
- **Empty/short `participantCoord` or `topicId`** in `bootstrapBoundImage`: bind the wire strings
  verbatim (the validator already enforces their byte lengths upstream); no special-casing.
- **Forward-compat:** unknown future evidence kinds (`v: 2`) ⇒ `parse…` returns `undefined` under the
  v1 reader (fails closed), which is the safe default.

## Key tests (`bootstrap-evidence-envelope.spec.ts`)

- `serialize → parse` round-trips each kind and a multi-kind envelope.
- `parse` returns `undefined` for: absent field, non-base64url, non-JSON, `v: 2`, missing required
  sub-fields, `""`.
- `bootstrapBoundImage` is stable and differs across topic / tier / participantCoord / timestamp (the
  anti-replay binding).
- `meetsDifficulty`: known hash vectors at `bits ∈ {0, 1, 8, 9, 20}`; MSB-first byte order; oversize bits.
- `registerSigningPayload`: a non-bootstrap register's image is unchanged vs. pre-field baseline
  (snapshot the array); a register *with* `bootstrapEvidence` includes it at the fixed position; absent
  and `""` produce the identical image.
- `validateRegisterV1` accepts a register with a valid `bootstrapEvidence` string and one without; a
  non-string `bootstrapEvidence` is rejected as malformed.
- Service factory: with an injected `buildBootstrapEvidence` returning bytes, a `bootstrap` build sets
  the field (present in the signed body) and a non-bootstrap build does not call the builder.

## TODO

- Add `bootstrapEvidence?: string` to `RegisterV1` (`wire/types.ts`) with a doc comment; thread it
  through `wire/validate.ts` (optional base64url string; `""`/absent normalized identically) and confirm
  `wire/codec.ts` needs no change (JSON pass-through).
- Add `bootstrapEvidence` (normalized) to `registerSigningPayload` at a fixed array position.
- Create `antidos/bootstrap-evidence-envelope.ts`: envelope type, `parse…`/`serialize…`,
  `bootstrapBoundImage`, `powPreimage`, `meetsDifficulty`, `DEFAULT_POW_DIFFICULTY_BITS`. Re-export from
  `antidos/index.ts` and ensure the symbols reach the db-core barrel (`@optimystic/db-core`).
- Add the `buildBootstrapEvidence?` seam: `CohortTopicServiceDeps`, the `messageFactory()` bootstrap
  branch (build → set field → sign). Leave `RegisterMessageFactory.build` signature as-is.
- Update `docs/cohort-topic.md` (§Anti-DoS bullet 4, §Wire formats Register note) to document the
  dedicated signed field and the envelope, superseding the "in appPayload" sketch.
- Write `bootstrap-evidence-envelope.spec.ts`; run `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/dbcore.log` and `yarn workspace @optimystic/db-core build` (typecheck). Fix any fallout in existing register/sign specs from the new payload position.
