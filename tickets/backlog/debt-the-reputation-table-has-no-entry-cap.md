description: The list a machine keeps of how other machines have behaved never forgets anyone, and a stranger can add a new name to it just by sending one message, so the list grows for as long as the machine runs.
architecture: docs/architecture.md#reputation--equivocation
files:
  - packages/db-p2p/src/reputation/peer-reputation.ts (`PeerReputationService.getOrCreateRecord` — the one place an entry is created; `pruneRecord`; the `NOTE:` on the `peers` map)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`ClusterMember.validateSignatures`, `ClusterMember.detectEquivocation` — the writers that name a peer taken off the wire)
  - packages/db-p2p/src/matchmaking/traffic-validation.ts (`reportTrafficCrossCheck` — a third writer)
  - packages/db-p2p/src/peer-address-book.ts (`MAX_MERGED_ADDRS_PER_PEER`, `MAX_LEARNED_PEERS_PER_RECORD` — the in-repo precedent for capping this same ingress)
difficulty: easy
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: An entry is small and an eviction policy has to pick something to forget, so a maintainer may reasonably judge that an attacker who can already open unlimited streams has cheaper things to exhaust than a few hundred bytes per message.
----
# The reputation table has no entry cap

## What is wrong

Every machine keeps one record per other machine it has formed an opinion about. Nothing ever removes a record, and nothing limits how many there can be. A record is created the first time any misbehaviour is reported against a name, and the name comes from the message being judged — so whoever sends the message chooses it.

Read at the code: `PeerReputationService` in `packages/db-p2p/src/reputation/peer-reputation.ts` holds its records in a plain map created at construction. `getOrCreateRecord` is the only place an entry is added and applies no cap. `pruneRecord` trims the individual penalty events inside a record once they have decayed, but deliberately leaves the record itself in place. `resetPeer` would remove one, and **has no caller anywhere in `packages/*/src`** — only tests call it. So the map only ever grows, for the life of the process.

## Why a stranger can grow it

`ClusterMember.validateSignatures` in `packages/db-p2p/src/cluster/cluster-repo.ts` checks every vote signature on every inbound consensus record and reports an `InvalidSignature` penalty against the name a failing signature is attributed to — but only once `verifySignature` has proven the attached public key really is the key that name identifies. That proof is `peerIdBindsPublicKey`, and its own `NOTE:` already states the relevant limit plainly: a sender that mints a fresh keypair and uses that key's own derived name passes the check every time. Nothing about it says the name belongs to a real participant.

So one message carrying a freshly minted name and a deliberately bad signature adds one new permanent entry. The receiving machine need grant the sender no standing at all: the check runs before any membership test, and the per-connection authorization hook is off unless the embedding application supplies one.

**Measured by reading the code, not by running it**: one entry per message, because the validation loop throws at the first failing signature rather than continuing through the rest. An entry is one small object holding one penalty event, plus the name itself as the map key (roughly fifty characters). Two other writers reach the same map with wire-supplied names — `ClusterMember.detectEquivocation` and `reportTrafficCrossCheck` in the matchmaking traffic validator — and neither has been measured here. What would confirm the whole thing: drive one node's cluster protocol with a run of records, each from a fresh keypair with one bad signature, and watch the map's entry count.

## Why this is worth a guard rather than a shrug

This repository already treats exactly this ingress as needing a bound. The peer address book learns multiaddresses from the very same inbound consensus records, and caps both how many addresses it will take per peer and how many peers it will take per record, for the stated reason that the ingress is unvalidated and what needs bounding is cost rather than authenticity. The reputation table is the uncapped sibling of an ingress the codebase went out of its way to cap.

Stated as the rule the codebase seems to want: **a collection keyed by a name that arrives off the wire is bounded at the point entries are created.** One place enforces it here.

## Expected behaviour

The table holds a bounded number of records. When it is full and a new name must be recorded, something is forgotten — and what is forgotten should be the record that is cheapest to lose rather than an arbitrary one. A record whose penalties have all decayed to insignificance carries no information and is the obvious candidate; after that, the least recently touched. Forgetting a record is not a correctness problem: a forgotten name simply scores zero again, which is what an unseen machine already scores.

Two things the fix must not break. Forgetting must never be able to promote a machine out of a ban it has earned more cheaply than time already does — an attacker who can force evictions must not be able to launder their own bad record out of the table by spraying names. And a machine's own name is refused before a record is ever created (see the self-report guard in the same file), so it neither occupies a slot nor can be evicted.

## What this ticket is not

Not about whether an unauthenticated peer should be able to reach the signature check at all — that is the authenticated membership layer the `NOTE:` at `verifySignature` already records as an open residual. This ticket assumes that ingress stays open and asks only that what it can grow be bounded.
