----
description: Let a machine prove that a record really was updated by checking a signature the group produced when it committed, instead of having to reach two other machines that say the same thing. Without that proof, a machine that cannot reach enough peers can never catch up, and small or partly-connected deployments get stuck permanently.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/commit-cert.ts, packages/db-p2p/src/storage/struct.ts (BlockArchive), packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/sync/protocol.ts
difficulty: hard
severity: wrong-result
likelihood: normal-use
repro: verified
tradeoffs: It is a large piece of work whose own prerequisite (cohort-membership anchoring) is not built, and the availability arm below can be worked around by an operator setting `clusterPolicy.assumedClusterSize` — for two-machine deployments; three-machine ones have no workaround at all.
----

# Verify restored blocks against a commit certificate (Sybil-resistant)

## Why this exists

The near-term fix (`p2p-read-repair-verify-peer-claims`, in implement/) makes
block read-repair and reconcile require a **quorum of peers to agree** on the
claimed latest revision + its content before accepting it. That defeats a
*minority* of lying peers. It does **not** defeat a single attacker that spins up
many fake peer identities (a Sybil attack): those fake identities can manufacture
a fake "quorum" because the quorum check counts distinct peer-ids, and nothing
proves those ids are legitimate members of the block's cohort.

The stronger, Sybil-resistant guarantee is to verify the claimed latest against a
**commit certificate** — the cohort's threshold signature produced when the block
was actually committed. A forger cannot produce a valid cohort signature it never
collected.

## What blocks doing this today

Three gaps, all real work:

- **Certs are not stored with blocks.** A commit cert lives only in an in-memory
  TTL cache (`cluster/commit-cert.ts`) keyed by `actionId`, used for reactivity.
  Block archives (`storage/struct.ts` `BlockArchive`) carry no cert.
- **The sync protocol does not serve certs.** `sync/service.ts` builds archives
  from stored revisions; there is no field or path to return the cert alongside a
  revision, so a restoring node cannot fetch one to verify.
- **Cohort-membership anchoring is not wired into these restore paths.**
  Verifying a threshold signature requires knowing which peer-ids are legitimately
  in the block's cohort. That machinery exists in part (completed
  `cohort-topic-trust-anchor-*` work / membership certs) but is not connected to
  read-repair or reconcile, and the per-vote binding check in `cluster-repo.ts`
  `verifySignature` explicitly does not establish cohort membership on its own.

## Rough shape of the work

- Persist the commit cert with the committed revision (extend the archive
  revision record and storage write path).
- Extend the sync protocol / `BlockArchive` to return the cert for a revision.
- Add a `verifyCommitCert` step in `queryClusterForLatest` / `reconcileBlock`
  that reconstructs the signed commit image and checks the threshold signature
  against the cohort's anchored membership; accept a claimed latest when its cert
  verifies (stronger than / short-circuits the quorum-agreement path).
- Decide retention: certs must survive long enough to serve historical restores,
  which the current TTL cache does not guarantee.

## Sibling ticket at the same seam

`debt-read-repair-penalty-provable-only` covers the *other* half of the same weakness in
`queryClusterForLatest`: because a peer's claimed latest cannot be proven, read-repair currently
penalizes the reputation of any peer reporting a higher revision than the sampled quorum — including
an honest peer that is simply ahead. The two were kept as separate tickets (both slugs are cited from
`NOTE:` comments in `coordinator-repo.ts`, `quorum-restore.ts`, and `reconcile-block.ts`), but they
should be triaged together: the penalty ticket's cheap fix (stop penalizing an uncorroborated higher
revision) is independently shippable now, and this ticket is what makes the penalty *provable* rather
than merely dropped. A planner may fold them.

This was filed as a future hardening pass on the grounds that it was not an
active bug — the quorum + content-hash gate already stops the realistic
minority-liar case. **The second arm below overturns that half of the framing:**
the same missing proof is also a reproduced availability defect, so the
promotion question is no longer only about Sybil resistance. The cohort-membership
anchor is still not ready to consume here, which is what keeps this in backlog.

---

## Second arm (appended 2026-08-24): this is an availability defect, not only Sybil hardening

Added from `fix/stale-read-returned-as-authoritative-when-repair-cannot-converge`, which reached
this site as the *only sound* fix for a reproduced non-convergence. The metadata above was raised
from `likelihood: contrived` / `repro: static` on this evidence; the analysis below is why.

### What was measured

Corroboration counts *voters*. A voter count cannot be met when the voters are unreachable, and the
floor is 2. Sweeping `resolveClusterPolicy` → `corroboratorCapacity` → `quorumSize` over real
cohort sizes gives one rule: **a cohort of three or more needs two cohort peers besides the reader
to answer, or the repair declines.** So:

- A three-machine deployment has **zero** fault tolerance for repair. One peer unreachable *from
  one reader* — healthy and reachable from everybody else — leaves that reader's copy permanently
  unrepairable.
- A two-machine deployment that never declared `clusterPolicy.assumedClusterSize` falls back to
  `clusterSize` (default 10), so its floor never relaxes and it can repair nothing, ever.

Reproduced in `packages/db-p2p` against a three-peer cohort with one member unreachable: no quorum,
no restoration, the reader stays at its old revision across every pass. Matches the field logs
(`cluster-fetch:no-quorum { responders: 1, required: 2 }`, 1821 times in one boot).

### Why the cost of this ticket changed

The corroboration floor's strict default was chosen as *degraded rather than dead* — an unrepaired
block was still served, just stale. **That is no longer what happens.**
`coordinator-serves-stale-data-as-if-confirmed` landed on the same day (2026-08-12) and made an
unconfirmable read throw `BlockPossiblyStaleError` rather than silently serve. Correct, and the
right call — but it means an unrepairable block is now **read-dead**, not degraded. The two
decisions appear to have been made without either seeing the other. The tradeoff that justified the
strict default was priced against the old cost.

### Why no cheaper fix exists

Every alternative reduces to "trust fewer voters because the others did not answer", which is the
attack the floor exists to stop. Specifically rejected during the investigation:

- **Use the count of peers that actually answered as the capacity.** A routing-level attacker who
  shrinks a reader's cohort view to `[reader, attacker]` produces one answerer with nobody silent,
  and would be believed. This is the `max(cohortPeerCount, …)` in `corroboratorCapacity` doing its
  job; removing it removes the protection.
- **Relax when nobody was silent.** Same hole, same reason — silence is not what the attacker
  needs to induce.
- **Ask a reachable peer to relay an unreachable peer's answer.** That is a certificate with extra
  steps and no signature.

A commit certificate breaks the circularity because **one peer carrying a certificate is as strong
as N peers agreeing** — the signature set *is* the corroboration, so the reader never needs to
reach a second peer. That property is what this ticket is for, and it is worth as much for
availability as for Sybil resistance.

### What still blocks it

Unchanged, and stated honestly: the three gaps in the section above, plus
`feat-cluster-membership-threshold-cert-anchoring` (also backlog, also not buildable). Note the
precedent for landing this at partial strength: `verifyInvalidationCertificate` in
`cluster-repo.ts` already verifies at layer-1 (challenger-bound signer set, membership, dedup) and
**logs** the residual anchoring gap rather than waiting for the anchor. A certified repair claim
verified to that same standard would still be strictly stronger than today's "two peers said the
same number", which carries no signatures at all. A planner should weigh that staging.

### Meanwhile

`implement/repair-deadlock-is-never-named` does not fix any of this. It makes the deadlock legible
— a named, once-per-block signal when every cohort member answered and there were still too few of
them, plus a startup advisory that stops implying three machines are enough. That is deliberately
diagnostics only, because nothing else is sound without this ticket.

