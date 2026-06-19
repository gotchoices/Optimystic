----
description: On a networked strand, looking up a row by its full multi-column primary key sometimes returns nothing even though the row is definitely there, which can make a duplicate-prevention check silently fail.
prereq:
files: ../sereus/packages/cadre-core/src/strand-membership-writer.ts, ../sereus/packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
difficulty: hard
----

## Background

Surfaced in sereus while writing the closed-strand membership e2e
(`strand-membership-closed-strand-e2e.integration.ts`). Against the **networked**
Optimystic transactor, a full composite-PK point lookup of the form

```sql
select 1 from Strand.MemberPeer where MemberKey = ? and PeerId = ?
```

returned `undefined` even though the row was provably present (`select count(1)`
on the same table returned `1`). The e2e worked around it by reading the singleton
row directly (`select MemberKey, PeerId from Strand.MemberPeer`) instead of seeking
it by composite key, so the test asserts correctly — but the underlying seek
unreliability is a platform behavior, not a test artifact.

This is distinct from the existing
`optimystic-insert-pk-uniqueness-not-enforced` (write-side PK uniqueness) and
`optimystic-strand-sync-blind-write-convergence` (sync convergence) gaps — this is a
**read/seek** miss on a composite key in the networked transactor.

## Why it matters (production path)

`registerMemberPeer`'s insert-if-absent guard, `memberPeerExists()` in sereus's
`strand-membership-writer.ts`, uses exactly this composite-`where` seek. If the seek
fails-open (returns no row when one exists), the guard always concludes "absent" and
always inserts. Combined with the known write-side PK-uniqueness gap, that means a
re-register of the same `(MemberKey, PeerId)` could accumulate duplicate
`MemberPeer` rows on a networked strand rather than being a no-op as intended. Today
this only "fails open" to a redundant insert (harmless in the e2e because each
`(MemberKey, PeerId)` is registered once), but it is a latent correctness hazard for
multi-device / re-register flows.

## Scope

This ticket owns the **platform** half — reproduce and fix the seek miss:

- Reproduce the composite-PK seek miss against the networked transactor in isolation
  (here in optimystic), and determine whether it is a query-planner / index-seek issue
  or a sync-visibility issue.
- A regression test pinning the corrected behavior (composite-PK point lookup returns
  the row on a networked strand).

The Sereus-side disposition — whether to rely on this fix once it lands or make
`memberPeerExists` robust to the seek miss (e.g. scan-and-filter the member's peers
rather than a composite-PK point lookup) — is tracked separately in sereus
(`member-peer-exists-composite-seek-robustness`).
