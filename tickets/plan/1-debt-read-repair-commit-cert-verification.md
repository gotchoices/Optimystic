----
description: Let a machine prove that a record really was updated by checking a signature the group produced when it committed, instead of having to reach two other machines that say the same thing. Without that proof, a machine that cannot reach enough peers can never catch up, and small or partly-connected deployments get stuck permanently.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/commit-cert.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/storage/struct.ts (BlockArchive), packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/test/block-transfer-push-persist.spec.ts
difficulty: hard
severity: wrong-result
likelihood: normal-use
repro: verified
----

# Verify restored blocks against a commit certificate (Sybil-resistant)

## Promoted to plan, 2026-08-27 — read this section first

Two things changed since this was parked, and together they retire the reason it was parked.

**1. The floor this ticket hardens is already bypassable, so "is it worth the cost" is the wrong
question.** `blocked/repair-floor-defends-a-door-the-push-path-leaves-open` (now absorbed here, and
deleted) measured it rather than arguing it. `BlockTransferService.handlePush` accepts a pushed block
from any peer, validates only that the payload parses and has a `header`, and persists it via
`saveReplicatedBlock` using the **pusher's own** rev and action id — which is exactly what that node
then reports when a reader asks what it holds:

```
push accepted: [ 'single-holder-block' ]  missing: []
push accepted: [ 'single-holder-block' ]  missing: []
reader served payload: FORGED  rev: 7
reader now HOLDS payload: FORGED  rev: 7
```

Run with the strict default (`repairCorroborationClusterSize: 10`, floor of two, no relaxation). A
peer that can dial two cohort members manufactures two honest-looking corroborators, and the floor is
satisfied by construction. The reader then becomes a third. The acceptance half is pinned green in
`test/block-transfer-push-persist.spec.ts:48,65` — working as designed, for the design in
`docs/internals.md:859` (any peer that can open a connection may issue database operations;
`authorizeInboundStream` is the embedder's opt-in seam and defaults to `undefined`).

So today we pay permanent unreadability of a deployment's earliest data for a guarantee any peer with
two connections can walk around. That is not a threat model to choose between; it is one mechanism
that works and one that does not, and the certificate replaces both.

**2. The decision that was blocked has been made.** Fund this path. Neither the corroboration floor
nor the push path is the durable answer: once a revision carries proof, origin stops mattering, the
floor stops doing load-bearing work, and an unauthenticated push becomes harmless because an
unproven block is simply not accepted. Do not spend this ticket re-litigating Position A vs Position
B — implement the thing that dissolves the question.

### What was verified in the tree on 2026-08-27, so the planner does not re-derive it

- `BlockArchive` (`storage/struct.ts:19`) is `{ blockId, revisions, range, pending? }` — **no
  signature or certificate field anywhere in the type**. There is nothing on the restore/sync wire to
  check, which is why "take the peer's word" is the whole path, not a corner of it.
- `buildCommitCert` (`cluster/commit-cert.ts`) already assembles the real artifact: the cohort's
  per-member Ed25519 **commit** votes over the commit hash, concatenated in signer order, plus the
  exact signed preimage. It is then handed to an in-memory sink with
  `DEFAULT_COMMIT_CERT_TTL_MS = 60_000` for reactivity. Even the node that witnessed consensus cannot
  prove it an hour later.
- Client signatures are real but unenforced in practice: `requireClientSignature` exists,
  `createQuereusValidator` is exported, and **no shipping entry point constructs one** — the node
  takes `validator` as an option nothing sets (see `backlog/feat-no-deployment-validates-transactions-at-pend`).
  They also validate the *transaction at pend*, not the block bytes replicated later.

### The design question this ticket must answer — it is not just wiring

The commit cert signs the commit hash over the record's **message** — the transaction — not over the
resulting block bytes. A receiver can therefore prove *"the cohort approved action X at revision N"*
but not *"these bytes are what X produces from N-1"*. Block ids are **not** content hashes (see
`complete/bug-docs-claim-block-ids-are-content-hashes`), so the id binds nothing either. Closing that
needs one of:

- **Verify by replay** — replicate signed transforms rather than materialized state, and replay from a
  base the receiver already trusts. Strongest binding; costs a replay and a trusted base, and
  interacts with how `BlockArchive` already carries `pending` transforms.
- **Extend the signed preimage** to cover a digest of the resulting block, so the certificate binds
  content directly. Cheaper to verify; changes the commit-vote preimage, which is a wire-compatibility
  event — and note `computeClusterMessageHash` canonicalises the whole message generically, so an
  older peer recomputes a changed preimage correctly (established while shipping
  `complete/1-commit-and-cancel-records-omit-the-coordinating-block`).

Pick one, with the reasoning written down. This is the crux of the ticket; everything else is
plumbing.

### Staging — the default, unless the plan stage finds better

Land at **layer-1 strength now** and log the residual anchoring gap, following the precedent this
ticket already cites: `verifyInvalidationCertificate` verifies a challenger-bound signer set,
membership and dedup, and logs what it cannot yet anchor rather than waiting for
`feat-cluster-membership-threshold-cert-anchoring`. A certified claim verified to that standard is
strictly stronger than "two peers said the same number", which carries no signatures at all. Waiting
for the anchor keeps a measured hole open indefinitely; shipping without it is a real improvement that
the anchor later upgrades in place.

Once a cert can be verified, `handlePush` must require one — that is what closes the forgery above,
and it should be part of this work rather than a follow-on, because a push path that still accepts
unproven blocks re-opens everything this ticket buys.

### Sizing — split it

This does not fit one agent run. Emit prereq-chained implement tickets; the natural seams are:
persist the cert with the revision → carry it in `BlockArchive` and the sync protocol → verify on the
read-repair/reconcile path → require it on `handlePush` → retention policy (certs must outlive a
60 s TTL to serve historical restores). Fold `backlog/debt-read-repair-penalty-provable-only` if its
cheap arm (stop penalising an uncorroborated higher revision) falls out of this work; leave it filed
if it does not.


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


## Arm — new evidence, filed 2026-08-25 (gotchoices/Optimystic#15)

An outside reporter measured the availability half of this ticket as a live, permanent data-loss-
shaped failure, and sharpened *which* quantity is wrong.

`corroboratorCapacity` relaxes the floor based on **cohort size**. What bounds corroboration is
**how many peers hold the block**. A block with exactly one holder supplies exactly one claim, so it
is declined in any cohort of three or more — and both paths that could create a second holder
(`CoordinatorRepo.queryClusterForLatest`, `createReconcileBlock`) consume the same decision. One
holder is therefore where it stays, permanently.

Verified against our own 0.24.2 build: identical evidence (one honest claim, all other members
answering "I hold nothing") is accepted at a cohort view of two and declined at three, four and
nine.

Why this strengthens the case for a certificate specifically: the state is produced by **growth**,
not by misconfiguration. Whatever was committed while the deployment was one node has one holder,
and the cohort that later derives for that key has three — so a deployment's founding records are
exactly the data that becomes unreadable, and `clusterPolicy.assumedClusterSize` cannot express "this
block has one holder". A certificate is the only listed direction that lets a lone claim be trusted
without handing an attacker the sole-claimant lever.

That investigation has since concluded (its ticket is gone; successors below). It rejected the two
cheaper directions on measured grounds — relaxing the floor on an affirmative "I hold nothing" is
strictly weaker than today's rule and self-amplifying, since an acquiring reader becomes a genuine
second voter; and structural corroboration against a parent pointer is not buildable, because parents
name children by bare id only (`BranchNode.nodes: BlockId[]`), with no revision or content hash to
check a lone claim against. It landed two implement tickets instead:
`replicate-owned-blocks-when-the-cohort-grows` (stop creating singly-held blocks, and heal existing
ones while their holder is online) and `name-the-single-holder-deadlock` (say what is happening).
**Neither covers a block whose sole holder is offline or gone — this ticket is still what covers
that.** The threat-model question it surfaced has been absorbed into the "Promoted to plan" section at the
top of this ticket, and that blocked ticket deleted.
