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
  - packages/db-core/test/cohort-topic/registration.spec.ts (cohort-side withdraw onRenew tests)
  - packages/db-core/test/cohort-topic/wire.spec.ts (withdraw round-trip + signing-image distinction)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts (withdraw → budget release, no arrival)
  - packages/db-p2p/test/cohort-topic/peer-key-signing.spec.ts (signed-withdraw evicts; forged does not)
  - packages/db-p2p/test/cohort-topic/service.spec.ts (withdraw sends one tombstone dial, evicts immediately)
  - docs/cohort-topic.md (withdraw tombstone moved from "deferred" to "landed")
difficulty: medium
----

# Cohort-topic: withdraw tombstone (remote half) — review handoff

## What landed

`CohortTopicService.withdraw(handle)` previously only deleted the local renewal handle, so a withdrawn
participant just stopped pinging and the cohort soft-state TTL-expired (up to ~90 s later) on its own.
This ticket adds the **remote half**: a proactive, signed tombstone that frees the cohort record
immediately.

The chosen shape (per the resolved design in the implement ticket) is a signed `withdraw?: boolean`
flag on `RenewV1` — the exact sibling of the existing `reattach?: boolean` crash-failover attestation.
It reuses every existing seam (routing via `resolveRenew`/`findHolder`, the participant signer, the
cohort-side participant-sig gate, and the `evicted[]` gossip convergence path), so **no new wire
message, signer method, gossip path, or host routing branch** was added.

### End-to-end flow

```
participant: service.withdraw(handle)
  → renewals.delete(key)         (stop local pings first; a concurrent renew() now no-ops)
  → renewal.withdraw()           (best-effort signed RenewV1{ withdraw:true } to current primary)
      transport.send → resolveRenew → handleRenew → renewal.onRenew:
        verifyParticipantSig? false → reply "unknown_registration" (NO evict — reveals nothing)
        ok → store.delete + failoverServing.delete + gossip.evicted(rec) → reply "withdrawn"
      handleRenew "withdrawn" branch → topicBudget.touch(topic, directParticipants)  (re-touch DOWN; never an arrival)
      send failure → swallowed; the record TTL-expires as the fallback (withdraw never throws)
  next gossip round → evicted[] → sibling bus store.delete + onRecordsEvicted budget re-touch
```

### Key design points the reviewer should validate

- **Security (the core property):** the `withdraw` flag is part of the signed renew body
  (`renewSigningPayload` appends it after `reattach`, array length 7→8). A forged/unsigned withdraw is
  answered `unknown_registration` and evicts nothing — a third party cannot evict someone else's
  registration. Sibling to the reattach gate. The verifier (`verifyParticipantSig`, renamed from
  `verifyReattachSig`) now gates **both** privileged participant-attested paths (reattach → promote,
  withdraw → evict).
- **Key-less / unit mode:** the gate is absent → withdraw evicts unconditionally, exactly as the
  reattach gate is skipped in unit composition. Documented parity, not a hole.
- **Budget slot release:** withdrawing a topic's last direct participant re-touches the topic budget to
  0 (the `handleRenew` "withdrawn" branch), mirroring the `sweepStale` drain release — else the slot
  leaks like the untouched-TTL-drain bug `sweepStale` already guards.
- **Crash-failover override cleanup:** the withdraw branch deletes any `failoverServing` override
  (mirrors `sweepStale`), so a re-register under the unchanged epoch can't inherit a stale override.
- **Idempotency:** double withdraw — remote: `rec === undefined` → `unknown_registration`, no gossip,
  no budget touch; local: `renewal === undefined` → no-op (no dial).
- **withdraw vs reattach both set on a frame:** never produced by the participant; the withdraw branch
  is placed first, so it wins (a record being withdrawn is gone regardless of a promotion request).

## Test coverage (the floor — treat as a starting point, not exhaustive)

All pass. `yarn workspace @optimystic/db-core test` → **996 passing**. `yarn workspace @optimystic/db-p2p`
cohort-topic specs → **15 passing** (service.spec + peer-key-signing.spec run directly).

- **Wire (`wire.spec.ts`):** RenewV1{withdraw:true} round-trip; absent-withdraw decodes without the
  field (back-compat plain ping); non-boolean withdraw rejected; RenewReply{result:"withdrawn"}
  round-trip; `renewSigningPayload` distinguishes withdraw vs reattach vs plain ping, and
  `withdraw:false === absent` (no signature ambiguity).
- **Cohort side (`registration.spec.ts`):** withdraw on a held record → "withdrawn" + record gone + one
  `gossip.evicted`; gate-false → "unknown_registration", record present, no gossip; gate-true → evicts;
  double withdraw idempotent; withdraw clears a prior crash-failover override (subsequent plain ping
  redirects, not served via stale override).
- **Real-key signing (`peer-key-signing.spec.ts`):** a real-key signed withdraw evicts + gossips once;
  forged (wrong-key) and unsigned withdraws are `unknown_registration` and never evict; double withdraw
  idempotent. Existing reattach assertions still pass after the payload-array change.
- **Budget (`member-engine.spec.ts`):** register one participant, withdraw via `handleRenew`, assert
  budget participant count → 0 and (because the harness stubs `traffic` with a throw-on-access proxy)
  **no arrival recorded**.
- **Service composition (`service.spec.ts`):** withdraw sends exactly one tombstone dial, evicts the
  cohort record immediately (`directParticipants` 1→0), a post-withdraw renew is a no-op (no dial), and
  a second withdraw is a no-op.

## Known gaps / things to scrutinize (honest)

- **No real two-node libp2p e2e for the withdraw frame.** The direct-dial `RenewV1` handler
  (`host.ts:2085`) and `resolveRenew` route a withdraw with zero code change, and that routing is
  covered for plain/reattach renews by existing tests — but **no test dials an actual `withdraw:true`
  frame across two real nodes** end-to-end. Coverage is unit + mock-transport composition. If the
  reviewer wants a real-dial assertion, that's the gap to fill.
- **Sibling gossip convergence is covered by reuse, not a new withdraw-specific test.** Withdraw calls
  the identical `gossip.evicted(rec)` seam the TTL sweep uses (`bus.ts` evicted → `store.delete` +
  `onRecordsEvicted` budget re-touch), which has existing eviction-convergence tests. There is no new
  test asserting a *withdraw-originated* eviction propagates to a sibling's store specifically.
- **Reactivity / matchmaking callers now dial on withdraw.** `subscription-manager.ts:317`,
  `seeker-manager.ts:60`, `provider-manager.ts:88`, `matchmaking/module.ts` call `service.withdraw`.
  They needed no change, but their teardown now issues a best-effort tombstone dial. This was not
  separately tested; worth a glance that none of those call sites assumed `withdraw` was dial-free.
- **Signing-image change is global to all renews.** Appending `withdraw` lengthens the
  `renewSigningPayload` array for *every* renew (ping/reattach/withdraw). Signer (db-core participant)
  and verifier (db-p2p `host.ts`) move together via the shared helper and no signatures are persisted,
  so there is no cross-version concern — but confirm no other code pins the array length.

## Pre-existing failure flagged (not this ticket's)

`tickets/.pre-existing-error.md` documents a **load-sensitive timeout** in
`reactivity/mesh-tail-rotation.spec.ts` → "the re-registration wave stays within cap_promote_fast" seen
during the full db-p2p suite. It **passes in isolation** (7/7, that test alone ~30 s against its own
60 s budget) and this ticket's diff does not touch its code path (the mesh harness `stop()` does not
invoke `withdraw`). Deferred to the triage pass per ticket rules.

## Validation commands

```
yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-core test
yarn workspace @optimystic/db-p2p build
# cohort-topic specs directly (the full db-p2p suite is ~8 min and surfaces the flaky mesh timeout above):
cd packages/db-p2p && node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/cohort-topic/service.spec.ts" "test/cohort-topic/peer-key-signing.spec.ts" --reporter spec
```
