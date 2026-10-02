description: A machine far from a collection's log tail cannot check who is in the group that signs that collection's change announcements, so it trusts whatever group list it sees first; in a large network that is almost every watcher, and the fix is to check the list against the collection's own transaction log.
prereq: reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort
files: packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts, packages/db-core/src/cohort-topic/membership/verifier.ts, packages/db-core/src/reactivity/verify.ts, docs/reactivity.md, docs/cohort-topic.md
tradeoffs: A notification only prompts a re-read, so a forged one costs a needless wake rather than wrong data; until this lands, large-network verification rests on trust-on-first-use, which is acceptable for a hint but not something to build further trust on.
----

# Anchor the reactivity root's membership to the commit log

## What is wrong

A subscriber verifies a notification's signature against the root group's membership certificate. It believes that certificate only if it is anchored (`IMembershipTrustAnchor`); otherwise the db-core gate falls back to trust-on-first-use.

The only anchor bound today is the FRET ring anchor (`packages/db-p2p/src/cohort-topic/fret-trust-anchor.ts`). It answers only for ring positions the node's own routing table covers, and returns `"unknown"` for the committed tiers (T0/T1), noting they "route to the tx-log commit certificate" through a future anchor that does not exist yet. A subscriber is almost never near the tail of the collection it watches, so in a large network nearly every verification is trust-on-first-use.

## Expected behavior

Once the reactivity root is the tail block's storage group (prereq), the root's membership is something the collection's own data already attests: the commit records for the tail carry the cohort's signatures (`BlockCommitProof`, `docs/internals.md` § Durable commit proof). A commit-log anchor should accept a root membership certificate whose signers match the signers of a verified commit proof for the tail block, and reject one disjoint from them, falling back to `"unknown"` only when no proof is available.

Limits to state, not solve here: a commit proof says the listed signers signed, not that they are the block's legitimate cohort (`feat-cluster-membership-threshold-cert-anchoring`). This anchor ties reactivity trust to the same root the reader already accepts for the collection's data, no stronger.
