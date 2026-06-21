description: When a participant leaves a cohort topic, tell the cohort to drop its registration right away instead of letting it sit unused until its timer runs out.
prereq:
files:
  - packages/db-core/src/cohort-topic/service.ts (withdraw() — fire the remote tombstone, not just drop the local handle)
  - packages/db-core/src/cohort-topic/registration/renewal.ts (participant withdraw() + cohort-side onRenew withdraw branch; verifyReattachSig→verifyParticipantSig)
  - packages/db-core/src/cohort-topic/member-engine.ts (handleRenew: skip arrival, re-touch budget on "withdrawn")
  - packages/db-core/src/cohort-topic/wire/types.ts (RenewV1.withdraw?, RenewReplyV1 result "withdrawn")
  - packages/db-core/src/cohort-topic/wire/payloads.ts (renewSigningPayload: append withdraw)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateRenewV1 withdraw; validateRenewReplyV1 "withdrawn")
  - packages/db-p2p/src/cohort-topic/host.ts (rename verifyReattachSig→verifyParticipantSig; signer/route already flow through)
  - packages/db-core/test/cohort-topic/registration.spec.ts (cohort-side withdraw onRenew tests)
  - packages/db-p2p/test/cohort-topic/peer-key-signing.spec.ts (signed-withdraw + forged-withdraw)
difficulty: medium
----

# Cohort-topic: withdraw tombstone (remote half)

`CohortTopicService.withdraw(handle)` today only deletes the local renewal handle
(`service.ts:241`), so the participant stops pinging and the cohort soft-state TTL-expires (default
90 s) on its own. The local renewal-stop half is already correct: a withdrawn handle's `renew()` is a
no-op (`service.ts:231-239`). This ticket adds the **remote** half — a proactive, signed tombstone
that frees the cohort record immediately instead of holding it for up to a full TTL.

## Design (resolved)

The ticket offered two shapes — a dedicated `WithdrawV1` message, or `ttl = 0` semantics on a signed
`RenewV1`. **Chosen: a signed `withdraw?: boolean` flag on `RenewV1`**, the exact sibling of the
existing `reattach?: boolean` crash-failover attestation. This is the "ttl=0 RenewV1 semantics" option
in concrete form (`RenewV1` has no `ttl` field, so ttl=0 would mean adding a flag regardless), and it
reuses every existing seam:

- **Routing** — `resolveRenew` → `registry.findHolder(topicId, participantId)` → `engine.handleRenew`
  (`host.ts:1561-1569`) already dispatches a `RenewV1` to the holder cohort with no `treeTier`. A
  withdraw routes identically; **no host routing change**.
- **Signing** — the participant signer's `signRenew` signs `renewSigningPayload(body)`
  (`host.ts:910`); once `withdraw` is in that payload array the existing signer covers it, so a third
  party cannot evict someone else's registration (the security requirement). **No new signer method.**
- **Verification** — the cohort-side participant-sig gate (`verifyReattachSig`, `renewal.ts:259,298`)
  already verifies a peer-key signature over the renew image against `participantId`. It is renamed
  `verifyParticipantSig` because it now gates **two** privileged participant-attested paths (reattach
  → promote, withdraw → evict); the verify logic in `host.ts:593-597` is unchanged and automatically
  covers the new field via `renewSigningPayload`.
- **Convergence** — the cohort side gossips the eviction through the existing
  `RenewalGossip.evicted` → `pending.evicted(rec)` → next gossip round's `evicted[]` →
  sibling-bus `store.delete` + `onRecordsEvicted` budget re-touch (`bus.ts:200-210`,
  `host.ts:1424`). **No new gossip path** — backups/siblings drop the record exactly as they do for a
  TTL sweep eviction.

A dedicated `WithdrawV1` would instead require a new wire type + validator + codec entry + signing
payload + participant signer method + reply type + a direct-dial protocol branch + a resolve function
— strictly more surface for identical behavior. Rejected.

Reply: add `"withdrawn"` to the `RenewReplyV1.result` union (`types.ts:126`). The participant ignores
the reply (it is leaving), but a distinct result makes the cohort-side behavior unambiguous and
testable, and lets `member-engine.handleRenew` branch on it (skip arrival, re-touch budget).

### Flow

```
participant                         cohort primary (holder)            cohort siblings
-----------                         ----------------------            ---------------
service.withdraw(handle)
  renewals.delete(key)   ──┐  (stops local ping loop; renew() no-op)
  renewal.withdraw()       │  build signed RenewV1{ withdraw:true }
    transport.send(primary)├──────► resolveRenew → handleRenew
       (best-effort)       │          onRenew: verifyParticipantSig?
       catch → TTL fallback│            ok → store.delete + failoverServing.delete
                           │                 + gossip.evicted(rec)
                           │            bad sig → unknown_registration (no evict)
                           │          handleRenew: result "withdrawn"
                           │            → topicBudget.touch(topic, dirParticipants)  (no recordArrival)
                           ◄──────  reply { result: "withdrawn" }
                                       next gossipRound → evicted[] ────────────────► bus.store.delete
                                                                                       onRecordsEvicted → budget.touch
```

### Interfaces / types

```ts
// wire/types.ts — RenewV1 (sibling to reattach)
/** True on a withdraw tombstone — the participant attests it is leaving; the holder evicts the
 *  record immediately and gossips the eviction. Absent/false on a ping or reattach. Signed (part of
 *  the renew body) so a third party cannot evict someone else's registration. Mutually exclusive with
 *  `reattach` (the participant never sets both). */
withdraw?: boolean;

// wire/types.ts — RenewReplyV1
result: "ok" | "unknown_registration" | "primary_moved" | "withdrawn";

// registration/renewal.ts — RenewalParticipant
/** Best-effort remote tombstone: signed withdraw renew to the current primary; swallows failure
 *  (TTL expiry remains the fallback). Does not touch failure counters or trigger failover. */
withdraw(): Promise<void>;

// registration/renewal.ts — RenewalCohortSideDeps (renamed from verifyReattachSig)
/** Participant peer-key signature verifier, gating the two privileged participant-attested paths:
 *  a `reattach` promotion and a `withdraw` eviction. Absent → gate skipped (unit/key-less mode);
 *  plain pings are never verified here. */
verifyParticipantSig?: (renew: RenewV1) => boolean;
```

## TODO

### Wire layer (db-core)
- `wire/types.ts`: add `withdraw?: boolean` to `RenewV1` (doc as above); add `"withdrawn"` to the
  `RenewReplyV1.result` union.
- `wire/payloads.ts`: append `body.withdraw ?? false` to the `renewSigningPayload` array (after
  `reattach`), and add `withdraw`→`false` to the header doc's normalized-optionals list. **Note:** this
  changes the renew signed image for *all* renews (array length 7→8); signer (participant, db-core) and
  verifier (db-p2p `host.ts:593-597`, via the same helper) are both in-tree and move together, and no
  signatures are persisted, so there is no cross-version concern. Keep the field strictly appended so
  the reattach-vs-ping distinction is preserved.
- `wire/validate.ts`: `validateRenewV1` — `assignDefined(out, "withdraw", optBool(obj, "withdraw", what))`
  (mirror the `reattach` line, `validate.ts:254`). `validateRenewReplyV1` — add `"withdrawn"` to the
  `reqEnum` result whitelist (`validate.ts:264`).

### Participant side (db-core)
- `registration/renewal.ts`: generalize `buildRenew(reattach: boolean)` to flags, e.g.
  `buildRenew(opts: { reattach?: boolean; withdraw?: boolean })`, setting whichever flag is true on the
  body (omit when false, matching the current plain-ping behavior). Add `withdraw(): Promise<void>` to
  the interface + impl: `try { await this.deps.transport.send(this.current.primary, await this.buildRenew({ withdraw: true })); } catch { /* best-effort; TTL bounds the leak */ }`. Do **not**
  increment `consecutiveFailures` or call `failover()` on a send failure — withdraw is one-shot and
  fire-and-forget.
- `service.ts`: rewrite `withdraw(handle)` —
  ```ts
  const key = recordKey(handle.topicId, this.participantId);
  const renewal = this.renewals.get(key);
  this.renewals.delete(key);   // stop local pings first → concurrent renew() already no-ops
  await renewal?.withdraw();   // best-effort remote tombstone
  ```
  Idempotent: a second `withdraw` finds `renewal === undefined` and no-ops. Replace the
  `service.ts:242-244` "documented follow-on" comment with a note describing the remote tombstone +
  TTL fallback.

### Cohort side (db-core)
- `registration/renewal.ts` `onRenew`: rename the dep `verifyReattachSig`→`verifyParticipantSig`
  (update its doc to cover both paths) and the call site (`renewal.ts:298`). Add a withdraw branch
  **after** the `rec === undefined` early-return (`renewal.ts:286-288`) and **before** the slot
  computation — withdraw needs no slot/primary check, any holder evicts its replica:
  ```ts
  if (msg.withdraw === true) {
    // Signed leave attestation. A forged/missing signature must never evict someone else's
    // registration → ignore, revealing nothing (the gate is absent in key-less unit mode, matching
    // reattach). `withdraw` takes precedence over a (malformed) co-set `reattach`.
    if (this.deps.verifyParticipantSig?.(msg) === false) {
      return { v: 1, result: "unknown_registration" };
    }
    this.deps.store.delete(topicId, participantId);
    this.failoverServing.delete(key);   // mirror sweepStale: drop any crash-failover override
    this.deps.gossip.evicted(rec);
    return { v: 1, result: "withdrawn" };
  }
  ```
  (`rec`, `topicId`, `participantId`, `key` are already in scope by that point.)
- `member-engine.ts` `handleRenew` (`member-engine.ts:233-240`): branch on the result —
  ```ts
  if (reply.result === "ok") {
    this.deps.traffic.recordArrival(b64urlToBytes(msg.topicId), now);
  } else if (reply.result === "withdrawn") {
    // A withdraw removed a direct participant: re-touch the topic budget down (mirrors sweepStale,
    // member-engine.ts:251-265) so the slot does not leak. Never an arrival — it is a departure.
    const topicId = b64urlToBytes(msg.topicId);
    this.deps.topicBudget?.touch(topicId, this.deps.store.directParticipants(topicId));
  }
  ```

### Host (db-p2p)
- `host.ts`: rename `verifyReattachSig`→`verifyParticipantSig` at all four sites
  (`CoordEngineContext` field `:497`, the const `:593`, the ctx assignment `:689`, the
  `createRenewalCohortSide` arg `:1426`). The const's verify body is unchanged — it verifies
  `renewSigningPayload(renew)` against `participantId`, which now includes `withdraw`. `resolveRenew`
  and the direct-dial `RenewV1` handler (`host.ts:2085-2087`) already route a withdraw with no change.
  `signRenew` already covers the new field via `renewSigningPayload`. No other host change.

### Docs
- Update the `service.ts` `withdraw` doc and, if it names the withdraw follow-on, the §TTL and renewal
  note in `docs/cohort-topic.md`, to describe the signed withdraw tombstone as implemented.

### Tests
- `db-core/test/cohort-topic/registration.spec.ts` (the `createRenewalCohortSide` /
  `onRenew` harness, `registration.spec.ts:413+`; `renewMsg` helper at `:378`): add a
  `withdraw` arg to `renewMsg`, then:
  - withdraw on a held record → `result: "withdrawn"`, record gone from the store, one `gossip.evicted`
    fired with that record.
  - withdraw with `verifyParticipantSig` returning `false` → `result: "unknown_registration"`, record
    **still present**, no `gossip.evicted`.
  - withdraw with the gate absent (unit mode) → evicts (matches reattach's gate-absent behavior).
  - double withdraw → second is `unknown_registration` (idempotent).
  - withdraw clears a prior crash-failover override (set one via a reattach, then withdraw, then assert
    a subsequent plain ping is `unknown_registration` / not served via the stale override).
- `db-core/test/cohort-topic/wire.spec.ts`: round-trip a `RenewV1{ withdraw: true }` and a
  `RenewReplyV1{ result: "withdrawn" }` through validate/codec; assert `renewSigningPayload` differs
  between `withdraw:true` and a plain ping over the same fields.
- `db-p2p/test/cohort-topic/peer-key-signing.spec.ts` (`:148-158` builds a `verifyReattachSig` over
  `renewSigningPayload`): rename to `verifyParticipantSig`, and add a real-key signed-withdraw that
  evicts plus a wrong-key signed-withdraw that does **not** evict. Confirm the existing reattach
  assertions still pass after the payload-array change.
- Member-engine / budget: register a single participant for a topic, withdraw it, assert
  `budgetParticipantCount(topic) === 0` (mirrors the sweepStale budget test) and that no arrival was
  recorded for the withdraw.

### Validation
- `yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/dbcore.log`
- `yarn workspace @optimystic/db-p2p build && yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/dbp2p.log`
  (stream with `tee`; do not silently redirect). Run cohort-topic spec files directly if the full suite
  is slow.

## Edge cases & interactions

- **Forged / unsigned withdraw (third party):** `verifyParticipantSig` → `false` ⇒ no eviction, reply
  `unknown_registration` (reveals nothing about whether the record exists). This is the core security
  property — sibling to the reattach gate that stops a stray ping usurping a primary.
- **Key-less / unit mode (gate absent):** withdraw evicts unconditionally, exactly as the reattach gate
  is skipped in unit composition; document the parity so it is not mistaken for a hole.
- **Idempotency / double withdraw:** remote — `rec === undefined` ⇒ `unknown_registration`, no gossip,
  no budget touch; local — `renewals` entry already deleted ⇒ `renewal?.withdraw()` no-ops.
- **Concurrent `renew()` racing `withdraw()`:** `service.withdraw` deletes the map entry *before*
  sending the tombstone, so a `renew()` that has not yet entered `pingLoop` sees `!renewals.has(key)`
  and no-ops. A ping already in flight either lands before the evict (touch, then evict — converges to
  evicted) or after (record gone ⇒ `unknown_registration`, the stray ping never resurrects). Both
  orders converge to evicted.
- **Send failure (primary unreachable):** best-effort `catch` swallows; the record TTL-expires as it
  does today (the local-half fallback). `service.withdraw` never throws on a transport failure.
- **Withdraw after failover:** `current.primary` already points at the live promoted member, so the
  tombstone reaches the node actually serving the record; it evicts + gossips, and siblings converge.
- **Budget slot leak:** withdrawing a topic's last direct participant must re-touch the budget to 0
  (the `handleRenew` "withdrawn" branch), else the slot leaks identically to the untouched-TTL-drain
  bug `sweepStale` already guards.
- **Crash-failover override cleanup:** if the withdrawn record carried a `failoverServing` override,
  the withdraw branch deletes it (mirroring `sweepStale`, `renewal.ts:368`) so a re-register under the
  unchanged epoch cannot inherit a stale serving override.
- **`withdraw` + `reattach` both set on a frame:** never produced by the participant; if a malicious
  frame sets both, the withdraw branch (placed first) wins — a record being withdrawn is gone
  regardless of a promotion request.
- **Replication lag on a sibling:** a gossiped `evicted` ref for a record a sibling does not yet hold
  is a no-op `store.delete` — harmless, converges once the (now moot) record would have replicated.
- **Signing-image change:** appending `withdraw` lengthens the `renewSigningPayload` array for every
  renew; verify the existing reattach/ping signing tests do not pin the array length and still pass.

## End
