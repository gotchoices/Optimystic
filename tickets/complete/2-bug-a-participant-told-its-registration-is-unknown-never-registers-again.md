description: A machine keeping a group subscription alive now treats the group's "we have no record of you" answer as a failed check-in, so after three in a row it recovers by re-attaching to a backup or subscribing again, and when it subscribes again it adopts where that new subscription landed instead of throwing it away.
architecture: docs/cohort-topic.md#ttl-and-renewal
files: packages/db-core/src/cohort-topic/registration/renewal.ts, packages/db-core/src/cohort-topic/service.ts, packages/db-core/test/cohort-topic/registration.spec.ts, packages/db-core/test/cohort-topic/service.spec.ts, packages/db-p2p/src/reactivity/collection-watch.ts, packages/db-p2p/src/reactivity/subscription-manager.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/substrate-simulator/src/registration.ts, docs/cohort-topic.md, docs/internals.md
repro: verified
----
# Complete: an "unknown registration" renewal reply counts as a failed ping, and a re-walk's landing is adopted

## What landed

Implemented in `ticket(implement): bug-a-participant-told-its-registration-is-unknown-never-registers-again`.

- **Participant** (`TtlRenewalParticipant`, `packages/db-core/src/cohort-topic/registration/renewal.ts`): `acceptPingReply` is an exhaustive switch over the renew result. `ok` and `primary_moved` reset the failure count. `unknown_registration` and `withdrawn` count as a failed ping (`strike`), and three in a row run the existing failover. `RenewalParticipantTransport.relookup()` now returns the accepted re-walk's `RenewalAssignment`. The participant adopts its primary, backups, epoch hint and correlation id. A `finally` resets the failure count however the relookup ends.
- **Service** (`WalkRegisterService`, `packages/db-core/src/cohort-topic/service.ts`): a per-registration `WalkLanding` records the last walk's tree tier, cohort members and traffic, and `syncHandle` copies it onto the handle. Primary, backups and epoch still come from the participant record.
- **db-p2p**: the stale `NOTE:`s in `collection-watch.ts` and `subscription-manager.ts` were removed or rewritten, and the `resolveRenew` comment in `host.ts` was reworded.
- **Docs**: in `docs/cohort-topic.md` § TTL and renewal, each reply now has its own bullet, plus a note on why the participant waits for three strikes. The wire section gained `RenewV1.withdraw` and the `withdrawn` result. The `docs/internals.md` "TTL renewal" bullet was updated.
- **Review pass**: the design simulator now models the same rule (see findings).

## Review findings

Read the implement diff first, then the handoff. Ran the db-core renewal and service specs (46 passing) and the full `substrate-simulator` suite (258 passing). eslint on the three changed sources, `tsc --noEmit` on the simulator, and `yarn lint:docs` were all clean. db-core was rebuilt after the edit. The implementer's full db-core (1858) and db-p2p (3200) runs plus the two real-socket integration specs predate my changes. Those changes are a comment in db-core and simulator-only code, so I did not re-run them.

**Correctness: checked, no defect in the diff.**
- The reply handling is exhaustive (a `never` default), and the wire validator already restricts `result` to the four values.
- Mixed failure sources share one counter. For example, two unreachable pings followed by one `unknown_registration` fail over, which matches the documented rule.
- `adopt` replaces the record immutably and leaves `attachedAt` alone. Nothing on the participant side reads `attachedAt`.
- Renews do not check the correlation id at the cohort: there is no use in `member-engine.ts` or `host.ts`. Swapping it on adopt is therefore safe, and it keeps the "matches the original RegisterV1" wire contract.
- If `hintFromReply` throws after an accepted walk, the landing is not adopted, the counter resets, and the next three strikes re-walk. Register time behaves the same way.
- A `renew` racing a displacing `register` can `syncHandle` onto the displaced handle. That is harmless, because the displaced handle is never driven again.
- `withdrawn` is only ever produced for a withdraw tombstone (`renewal.ts` cohort side), so the doc's claim about it holds.

**TTL interaction: checked, fine.** The register frame carries the service TTL (`this.ttl`, 90 s), while the participant pings at `req.ttl / 3`. Every caller's `req.ttl` is at most 90 s (subscriber 90/60 s, provider 90 s or the profile value, seeker 10 s), so the cohort never evicts between pings. I filed no ticket and no tripwire because nothing in this diff touches that pairing.

**Implementer's known gaps: dispositions.**
- *Simulator models the rejected alternative.* Fixed inline. `ParticipantRenewal.onReachablePrimary` in `packages/substrate-simulator/src/registration.ts` now counts `unknown_registration` as a strike and re-runs the lookup on the third. It skips the backup re-attach because the simulator's cohort keeps one record for all its members, so a lost record means no backup holds it either. The class comment was updated. No simulator test or scenario reached that branch: the churn scenario never calls `evictStale`, and the "whole cohort unreachable" answer cannot reach `onReachablePrimary`. As a result `churn.reLookups` is unchanged and the suite still passes. I added no new simulator test because db-core already holds the bug's reproduction.
- *A re-walk re-sends the first registration's `appPayload`.* Traced. The only reader of a held record's reactivity payload is `ReactivityForwarderHost` (`forwarder-host.ts`), and it only checks that the payload decodes. Nothing reads `tailIdAtAttach` or `lastKnownRev`, and the subscription manager's `lastKnownRev` is fixed at construction anyway. Matchmaking providers re-register on every payload change (`setCapacity` / `signalFull`), so their re-walk payload is current. This is conditional, so it is parked as a `NOTE:` tripwire at the `relookup` closure in `service.ts`.
- *No test for the `finally` reset on a throwing relookup.* Declined: the reset is a two-line `try/finally` with no branching beyond what the existing failover tests exercise.
- *`attachedAt` not updated on adopt.* No reader on the participant side, so nothing was changed.

**Tests: kept all three.** "counts an unknown_registration answer as a failed ping" is the bug's reproduction. "adopts the assignment a relookup lands" pins the new adoption contract. The service-level "re-walk … moves the handle there" pins the tree-tier sync that `followTail` now relies on. None of them restates the implementation or verifies a mock.

**Source hygiene: checked, no change needed.** Comments state reasons such as back-off and authority, not narration. The functions are small and single-purpose.

**Docs: checked.** `docs/cohort-topic.md`, `docs/internals.md` and `docs/reactivity.md` (the watch-service tick) were read and match the new behaviour. No doc referenced the old backlog slug, and `yarn lint:docs` resolves.

**Tickets filed: none.** Nothing met the filing bar.
