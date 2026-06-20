description: The safety check that decides whether a transaction-reversal is genuine can be fooled — a single bad actor can fabricate the "the arbitrators agreed" proof and undo any committed transaction. Close that hole before reversals are wired up live.
prereq: invalidation-log-entry-and-reversal
files: packages/db-p2p/src/dispute/invalidation.ts, packages/db-p2p/src/dispute/dispute-service.ts, packages/db-p2p/src/dispute/types.ts, packages/db-p2p/src/dispute/arbitrator-selection.ts, packages/db-core/src/log/struct.ts, packages/db-core/src/network/struct.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/invalidation.spec.ts, docs/right-is-right.md
difficulty: hard
----

# Invalidation certificate is forgeable — bind votes to the arbitrator set and the target

The durable-reversal primitive (ticket `invalidation-log-entry-and-reversal`) gates every
`InvalidationEntry` on `verifyInvalidationCertificate(proof)`. The design intent, stated in
`docs/right-is-right.md` § Durable Invalidation and the `DisputeResolutionProof` doc comment, is that
"a compromised peer can withhold an invalidation but **cannot forge** one." As implemented, that
guarantee does not hold. This is the security foundation of the whole reversal mechanism, so it must
be closed **before** the composition-root wiring lands (the wiring is gap #1 of the parent ticket —
today nothing originates or applies an invalidation end-to-end, so this is not yet a live exploit, but
it is a latent one).

## The three missing bindings

`verifyInvalidationCertificate` (in `packages/db-p2p/src/dispute/invalidation.ts`) does exactly one
thing per vote: confirm the Ed25519 signature matches the Ed25519 key embedded in the claimed
`arbitratorPeerId`, over the payload `${disputeId}:${vote}:${computedHash}`. It then counts
`agree-with-challenger` votes against a 2/3 decisive-vote threshold. It is missing:

1. **No binding to the legitimate arbitrator set (the critical one).** Nothing checks that a voting
   `arbitratorPeerId` was actually a *selected arbitrator* for this dispute. An attacker can generate
   N fresh Ed25519 keypairs, sign `${disputeId}:agree-with-challenger:${anyHash}` with each, and
   produce a certificate that passes for *any* `disputeId`/`messageHash`/`computedHash` of their
   choosing, with zero genuine arbitrator participation. (The existing unit test
   `accepts a challenger-wins resolution with a 2/3 super-majority of signed votes` demonstrates the
   shape: it generates three unrelated keypairs and verification returns `true`.)

2. **No binding to the target transaction.** The arbitrator votes sign only
   `disputeId:vote:computedHash` — never the `messageHash` or `invalidatedActionId`. And neither
   `applyInvalidation` nor `ClusterMember.applyConsensusInvalidation` checks that
   `proof.messageHash` corresponds to the `invalidatedActionId` / `blockIds` being reverted. So even a
   *genuine* `challenger-wins` proof for dispute D (about transaction X) can be replayed against a
   different `invalidatedActionId`/`blockIds` to revert an innocent transaction Y.

3. **No per-arbitrator dedup.** The vote loop counts every signature-valid vote, with no dedup on
   `arbitratorPeerId`. A single genuine `agree-with-challenger` vote can be duplicated to manufacture
   a "super-majority" (e.g. one real dissenting arbitrator from a dispute that legitimately resolved
   `majority-wins`, replicated 3×, flips the outcome). This is a subset of #1 but must be fixed even
   once the arbitrator set is bound (a member of the set must vote at most once).

## Why `resolveDispute` is not affected but the certificate verifier is

`DisputeService.resolveDispute` counts votes collected one-per-arbitrator via `collectVotes` (one
challenge sent per distinct selected arbitrator), so at *origination* the votes are inherently from
distinct, legitimately-selected peers. `verifyInvalidationCertificate` is the **independent** re-check
that every member runs without trusting the originator — its entire reason to exist is the threat
model where the originator is malicious. It therefore cannot inherit `resolveDispute`'s implicit
trust; it must re-establish the same guarantees from the proof alone.

## Requirements

- A member verifying an `InvalidationEntry` / `InvalidateRequest` must be able to confirm, from the
  proof and information it can independently derive or that is carried in a tamper-evident way, that:
  - each counted vote came from a peer that was a **legitimately-selected arbitrator** for this
    dispute (arbitrators are chosen deterministically by `selectArbitrators` — "next K peers beyond
    the original cluster" — given the disputed block and the peer/DHT topology; decide whether the
    eligible set is recomputed at apply time or carried+anchored in the proof, and how a member that
    cannot reconstruct the historical topology behaves);
  - each arbitrator is counted **at most once**;
  - the proof is **bound to the specific transaction** being reverted — the signed vote payload (or an
    enclosing signed structure) must commit to the target identity (`messageHash` and/or
    `invalidatedActionId` + `blockIds`), and the apply path must verify that binding against the
    request's target before writing any compensating revision or log entry.
- The fix spans the signed payload shape (`makeVote` in `dispute-service.ts`, `ArbitrationVote` /
  `ArbitrationVoteProof`), so it is a **wire/format change** — version it and document back-compat
  (old votes/proofs that lack the binding fields are not verifiable and must be rejected, not
  accepted-by-default).
- Tests must cover the forgery vectors directly: sybil-key votes rejected; duplicated-arbitrator votes
  counted once; a genuine proof replayed against a different target rejected; the legitimate path still
  accepted. Extend `packages/db-p2p/test/invalidation.spec.ts` and add cluster-path coverage.
- Update `docs/right-is-right.md` § Durable Invalidation: once the binding lands, restore the
  unqualified "cannot forge" guarantee and remove the interim caveat note added during review of the
  parent ticket.

## Notes / open design choices for the implementer

- Recomputing the historical arbitrator set at apply time is the cleanest trust model but may be
  impossible for a member that joined after the dispute or whose DHT view has churned. Carrying the
  eligible-arbitrator set inside the proof only helps if that set is itself anchored to something the
  member already trusts (e.g. the original `ClusterRecord` membership + a deterministic, verifiable
  selection function over it). Resolve this alongside the broader dispute-trust anchoring already in
  flight (`tickets/plan/cohort-topic-membership-cert-trust-anchoring.md` is a related, not identical,
  surface — do not assume it covers this).
- This is independent of, and should land before, the composition-root wiring described in the parent
  ticket's gap #1. The cascade (`7.6-invalidation-cascade-detection`) and client-notification
  (`7.6-invalidation-client-notification`) follow-ups consume the same certificate verifier, so they
  inherit this fix.
