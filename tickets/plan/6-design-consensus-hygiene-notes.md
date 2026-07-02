description: A handful of small but real design-hygiene gaps in the consensus layer — the exact byte format that nodes hash to agree on a transaction is only shown as a throwaable non-cryptographic example, two related thresholds default to different values in different components, and a couple of safe-but-surprising behaviors aren't documented for app authors. Pin the byte format, couple the thresholds, and document the footguns.
prereq:
files:
  - docs/transactions.md (:792-801 — non-cryptographic 32-bit example hash)
  - packages/db-p2p/src/cluster/cluster-repo.ts (ClusterMember.superMajorityThreshold default 1.0 ~192)
  - packages/db-p2p/src/repo/coordinator-repo.ts (coordinator policy threshold default 0.75 ~92)
  - docs/correctness.md (Theorem 15 — soft reads / lazy read-repair)
  - docs/right-is-right.md (ejection / reputation locality open question)
  - tickets/backlog/speculative/7.5-gossip-reputation-blacklisting.md (existing home for the ejection item)
difficulty: medium
----

The design review's low-severity "assorted design notes" collect several small consensus-layer hygiene gaps. They are grouped here because each is small; the implementer may split if one grows.

**1. Canonical operations-hash serialization is unspecified.** Validator agreement rests on every honest node hashing a transaction's operations identically, but `transactions.md:792-801` shows only a non-cryptographic 32-bit *example* hash. The canonical operation serialization must be specified and versioned alongside `engineId`, so all nodes hash the same bytes and the format can evolve safely. (The separate implementation-level operation-ordering bug is tracked as Transaction-section item Txn #10; this ticket is the spec, not that bug — but coordinate so the specified canonical form matches whatever ordering fix lands there. The client-signature work, design-client-transaction-signatures, also depends on this canonical form being pinned.)

**2. Super-majority threshold defaults diverge.** `ClusterMember.superMajorityThreshold` defaults to 1.0 (`cluster-repo.ts:192`) while the coordinator policy defaults to 0.75 (`coordinator-repo.ts:92`). A member expecting unanimity while the coordinator commits at 75% is a latent phase-disagreement misconfiguration. Enforce config coupling so the two cannot silently drift apart — derive them from one source, or validate at startup that they agree.

**3. Reads are soft (documentation footgun).** A non-responsible read warns and serves anyway, with a 10-second lazy read-repair window. This is fine per Theorem 15, but it is a footgun for application authors who have not read that theorem — a read can return slightly stale data without an obvious error. Document the behavior and its window where app authors will see it.

**4. Ejection is local (already parked).** Reputation lives per-node with decay, so an "ejected" peer that reconnects to fresh nodes carries no scarlet letter — `right-is-right.md` raises this as its own open question. This item already has a home in `backlog/speculative/7.5-gossip-reputation-blacklisting.md`; **do not duplicate it here** — just cross-reference it so the review finding is accounted for.

## Expected behavior

- A specified, versioned canonical operation serialization for the operations hash, tied to `engineId`.
- Startup-enforced coupling (or single-source derivation) of the member vs. coordinator super-majority thresholds so they cannot diverge silently.
- App-facing documentation of the soft-read behavior and its 10-second read-repair window.
- The ejection-locality concern left in its existing backlog ticket, referenced from here.

## Edge cases & interactions

- **Versioning the hash format** — changing the canonical serialization must not retroactively invalidate already-committed history; version it so old and new coexist during migration.
- **Threshold coupling across config sources** — the coupling must hold however the two values are configured (defaults, explicit config, per-deployment overrides); a mismatch should fail fast at startup, not commit-time.
- **Soft-read staleness bound** — document the worst-case staleness a caller can observe within the read-repair window so authors can decide if a soft read is acceptable for their use.
- **Interaction with client signatures** (design-client-transaction-signatures) — the canonical serialization pinned here is the byte form the client signature covers; keep them consistent.
