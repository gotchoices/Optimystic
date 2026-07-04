----
description: Harden block read-repair and reconcile so they can prove a peer's claimed "latest version" with a real cryptographic commit certificate, not just agreement between peers — closing the gap where a peer that forges many fake identities could still fool the quorum check.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/cluster/commit-cert.ts, packages/db-p2p/src/storage/struct.ts (BlockArchive), packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/sync/protocol.ts
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

This is a future hardening pass, not an active bug — the quorum + content-hash
gate already stops the realistic minority-liar case. Promote when Sybil
resistance on the restore paths becomes a priority and the cohort-membership
anchor is ready to consume here.
