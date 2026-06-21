description: When a participant leaves a cohort topic, it now tells the cohort to drop its registration right away (a signed "I'm leaving" message) instead of letting the slot sit unused until its timer runs out.
prereq:
files:
  - packages/db-core/src/cohort-topic/service.ts (withdraw() now fires the remote tombstone)
  - packages/db-core/src/cohort-topic/registration/renewal.ts (participant withdraw() + cohort-side withdraw branch; verifyReattachSig→verifyParticipantSig)
  - packages/db-core/src/cohort-topic/member-engine.ts (handleRenew "withdrawn" branch: budget re-touch, no arrival)
  - packages/db-core/src/cohort-topic/wire/types.ts (RenewV1.withdraw?, RenewReplyV1 result "withdrawn")
  - packages/db-core/src/cohort-topic/wire/payloads.ts (renewSigningPayload appends withdraw)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateRenewV1 withdraw; validateRenewReplyV1 "withdrawn")
  - packages/db-p2p/src/cohort-topic/host.ts (verifyReattachSig→verifyParticipantSig at all 4 sites)
  - packages/db-p2p/src/matchmaking/seeker-manager.ts, provider-manager.ts, module.ts, reactivity/subscription-manager.ts (withdraw docstrings — review fix)
  - packages/db-core/test/cohort-topic/registration.spec.ts, wire.spec.ts, member-engine.spec.ts
  - packages/db-p2p/test/cohort-topic/peer-key-signing.spec.ts, service.spec.ts
  - docs/cohort-topic.md
difficulty: medium
----

# Cohort-topic: withdraw tombstone (remote half) — COMPLETE

## What landed

`CohortTopicService.withdraw(handle)` now does two things: (1) drops the handle from the live set so
further `renew()` pings no-op (the pre-existing local half), and (2) fires a **best-effort signed
withdraw tombstone** — a `RenewV1{ withdraw: true }` to the current primary — so the cohort evicts the
registration and gossips the eviction immediately, instead of holding the soft-state record for up to a
full TTL (~90 s). The shape is a signed `withdraw?: boolean` flag on `RenewV1`, the exact sibling of the
existing `reattach?` crash-failover attestation; it reuses every existing seam (routing via
`resolveRenew`/`findHolder`, the participant signer, the cohort-side participant-sig gate, and the
`evicted[]` gossip convergence path), so no new wire message, signer method, gossip path, or host
routing branch was added. The cohort-side signature verifier was renamed `verifyReattachSig` →
`verifyParticipantSig` since it now gates **both** privileged participant-attested paths (reattach →
promote, withdraw → evict).

See the implement commit `938aaa9` for the full end-to-end flow and design rationale.

## Review findings

Adversarial pass over the implement diff (read first, before the handoff summary). Verdict: **the
implementation is correct, secure, and well-tested.** One category of minor finding (stale docstrings)
fixed inline; no major findings; no new tickets filed.

### Checked — and what was found

- **Security (the core property) — VERIFIED.** The `withdraw` flag is inside the signed renew body
  (`renewSigningPayload` appends it after `reattach`, array 7→8). A forged/unsigned withdraw of an
  existing record is answered `unknown_registration` and evicts nothing — indistinguishable from a
  non-existent record (strictly *more* opaque than the reattach path, which redirects). The signature
  binds `participantId`, and the record is looked up by `(topicId, participantId)`, so a participant can
  only ever withdraw its **own** registration — confirmed by the real-Ed25519-key test
  (`peer-key-signing.spec.ts`: forged/unsigned never evict, correctly-signed evicts once).
- **Verifier rename completeness — VERIFIED.** `grep verifyReattachSig` over `src/` is clean (only docs
  and an already-completed ticket reference the old name). `verifyParticipantSig` is wired at all sites
  in `host.ts` and threaded into the coord engine; `RenewSignable = Omit<RenewV1,"signature">` already
  carries `withdraw?`, so the signing helper type-checks.
- **Reply-result exhaustiveness — VERIFIED.** The new `"withdrawn"` result is consumed only by the
  cohort-side `member-engine.handleRenew` branch (budget re-touch). The participant's `withdraw()`
  ignores its reply entirely, so the renewal ping/reattach loop (`renewal.ts:140/160/164`) never sees
  `"withdrawn"`. The only other `reply.result` switches over renew replies are the substrate-simulator's
  own (distinct in-sim type, never sends withdraw) — no non-exhaustive-switch breakage; both packages
  build clean.
- **Budget slot release — VERIFIED.** The `"withdrawn"` branch re-touches the topic budget from the
  post-eviction `store.directParticipants` (the source of truth), mirroring the `sweepStale` drain
  release, so a withdrawn last-direct-participant frees its slot (→ 0) instead of leaking. Covered by
  `member-engine.spec.ts` (budget → 0 **and** no arrival, the latter enforced by the throw-on-access
  `traffic` proxy).
- **Crash-failover override cleanup — VERIFIED.** The withdraw branch `failoverServing.delete(key)`
  (mirrors `sweepStale`), so a re-register under the unchanged epoch can't inherit a stale override.
  Covered by the `wp5` registration test (post-withdraw plain ping redirects, not served via stale
  override).
- **Branch ordering / precedence — VERIFIED.** `rec === undefined` → `unknown_registration` first;
  withdraw checked before `cohort()`/`assignSlots` (no slot computation needed, slightly cheaper) and
  before reattach (a record being withdrawn is gone regardless of a co-set promotion request). Withdraw
  evicts on **any** holder that receives the dial (no primary/slot check) and gossips, which is the
  correct convergence semantics for a tombstone.
- **Idempotency — VERIFIED.** Remote: second withdraw → `rec === undefined` → `unknown_registration`, no
  gossip, no budget touch. Local: `service.withdraw` captures `renewals.get(key)` *before* the delete, so
  a second call finds `undefined` and dials nothing. Covered in both `registration.spec.ts` and
  `service.spec.ts` (dial count stays 2).
- **`withdraw()` cannot throw — VERIFIED.** Both the `sign()` and `transport.send()` awaits are inside
  the participant `withdraw()` try/catch, so a signer or transport failure is swallowed and TTL expiry
  remains the fallback. This makes every caller (below) safe.
- **Docs — `docs/cohort-topic.md` VERIFIED current** (withdraw tombstone moved from "deferred" to
  "Landed since" with the security note and TTL fallback). See the inline-fix finding for the manager
  docstrings the change *should* have touched.

### Found and fixed inline (minor)

- **Stale withdraw docstrings on the 5 wrapper call sites.** `subscription-manager.ts`,
  `seeker-manager.ts`, `provider-manager.ts`, and `module.ts` (×2) all still described `withdraw` as
  "stop renewing so the record TTL-expires" — now inaccurate (it evicts immediately, TTL is only the
  fallback). `module.ts:141` was doubly wrong, describing the mechanism as "`RenewV1` TTL = 0" when the
  actual mechanism is the `withdraw: true` flag. Updated all five to reflect the immediate signed
  tombstone with TTL as fallback. Comment-only; db-p2p rebuilt clean and the cohort-topic specs still
  pass 15/15.

### Known gaps — assessed, accepted (no ticket)

- **No real two-node libp2p e2e for the `withdraw:true` frame.** Coverage is unit + mock-transport
  composition. The direct-dial handler (`host.ts:2088`) and `resolveRenew`/`findHolder` route a withdraw
  with **zero code change** and are covered for plain/reattach renews by existing real-host tests, so the
  routing risk is negligible. Judged a test-depth gap, not a correctness risk — not worth a fix ticket.
- **No withdraw-*specific* sibling-gossip-convergence test.** Withdraw calls the identical
  `gossip.evicted(rec)` seam the TTL sweep uses (whose convergence — `store.delete` + `onRecordsEvicted`
  budget re-touch on siblings — has existing tests). Covered by reuse.
- **Signing-image change is global to all renews (rolling-upgrade note).** Appending `withdraw` lengthens
  `renewSigningPayload` for *every* renew. Within a consistent deployment there is no concern (no
  signatures persisted; signer + verifier move together). During a *rolling* upgrade a version-skewed
  signature would mismatch — but only on the two **verified** paths, and both degrade gracefully:
  reattach → plain redirect (slower failover, still safe), withdraw → TTL-expiry fallback. Plain pings
  are not signature-verified cohort-side, so they are unaffected. Soft-state + TTL makes this a transient
  graceful degradation, not a break. Documented, not blocking.

### Pre-existing failure (already triaged — not this ticket)

The implement handoff flagged a load-sensitive timeout in `reactivity/mesh-tail-rotation.spec.ts` ("the
re-registration wave stays within cap_promote_fast") seen only under the full ~8-min db-p2p suite (passes
7/7 in isolation). The runner already dispatched its triage pass (commit `4fa3447`) and consumed
`tickets/.pre-existing-error.md`. This ticket's diff does not touch that code path (the mesh harness
`stop()` does not invoke `withdraw`; my only additional edits here are comment-only), so it is not
re-flagged.

## Validation run during review

```
yarn workspace @optimystic/db-core build && test    → 996 passing
yarn workspace @optimystic/db-p2p build              → clean
cd packages/db-p2p && mocha test/cohort-topic/{service,peer-key-signing,wire}.spec.ts → 15 passing
(after the docstring fixes: db-p2p rebuilt clean, service+peer-key-signing → 15 passing)
```

Lint: the repo's `lint` script is a no-op placeholder (`echo 'Lint not configured for all packages'`) —
nothing to enforce. The full db-p2p suite (~8 min, surfacing the flaky mesh timeout above) is not
agent-runnable inside the idle-timeout budget and is left to CI; the cohort-topic specs run directly and
pass.
