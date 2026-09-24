description: The list a machine keeps of how other machines have behaved never forgets anyone, and a stranger can add a new name to it just by sending one message, so the list grows for as long as the machine runs.
architecture: docs/architecture.md#reputation--equivocation
files:
  - packages/db-p2p/src/reputation/peer-reputation.ts (`PeerReputationService.getOrCreateRecord` — the one place an entry is created; `pruneRecord`; the `NOTE:` on the `peers` map, which this ticket replaces)
  - packages/db-p2p/src/reputation/types.ts (`ReputationConfig` — gains the cap; `PeerRecord`)
  - packages/db-p2p/test/peer-reputation.spec.ts (existing spec; add the one test here)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`ClusterMember.validateSignatures`, `detectEquivocation` — writers that name a peer taken off the wire; no change expected)
  - packages/db-p2p/src/matchmaking/traffic-validation.ts (`reportTrafficCrossCheck` — third wire-named writer; no change expected)
  - packages/db-p2p/src/peer-address-book.ts (`MAX_MERGED_ADDRS_PER_PEER`, `MAX_LEARNED_PEERS_PER_RECORD` — in-repo precedent for capping this ingress)
  - docs/architecture.md (`Reputation & equivocation` section — one sentence on the cap)
difficulty: easy
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: An entry is small and an eviction policy has to pick something to forget, so a maintainer may reasonably judge that an attacker who can already open unlimited streams has cheaper things to exhaust than a few hundred bytes per message.
----
# The reputation table has no entry cap

## What is wrong

Every machine keeps one record per other machine it has formed an opinion about. Nothing removes a record and nothing limits how many there can be. A record is created the first time misbehaviour is reported against a name, and the name comes from the message being judged, so whoever sends the message chooses it.

Confirmed by reading the code (not run): `PeerReputationService` holds its records in a plain `Map` (`peers`). `getOrCreateRecord` is the only place an entry is added and applies no cap. `pruneRecord` trims penalty events inside a record but leaves the record. `resetPeer` removes one and has no caller in `packages/*/src` (grep over `resetPeer` shows only the definition and the interface), so the map only grows for the life of the process. `recordSuccess` also creates records, but it has no caller against `IPeerReputation` outside tests, so it is not an attacker path today; it goes through the same `getOrCreateRecord`, so it is covered by the same fix.

`ClusterMember.validateSignatures` reports `InvalidSignature` (weight 50) against the name a failing signature is attributed to once `peerIdBindsPublicKey` proves the key matches the name. Anyone can mint a keypair and use its own derived name, so one message with a bad signature adds one permanent entry (the validation loop throws at the first failure, hence one per message). `detectEquivocation` and `reportTrafficCrossCheck` are two more wire-named writers, not measured. Confirming: drive one node's cluster protocol with records each from a fresh keypair carrying one bad signature, and watch `getAllReputations().size`.

The same codebase already caps the sibling ingress (`peer-address-book.ts`: `MAX_MERGED_ADDRS_PER_PEER`, `MAX_LEARNED_PEERS_PER_RECORD`). Rule: **a collection keyed by a name that arrives off the wire is bounded at the point entries are created.** That point is `getOrCreateRecord`; enforce it only there.

## Design

Add an optional `maxPeers` to `ReputationConfig` (default 1024; real cohorts are single digits, so this is far above any honest working set). Keep `getOrCreateRecord`'s callers unchanged by having it return `PeerRecord | undefined`; both callers (`reportPeer`, `recordSuccess`) return early on `undefined`.

When `peers.size >= maxPeers` and a new name needs a record, pick one victim by this order, computed with the existing `computeScore` and no new stored field:

1. Never a record whose current score is at or above the ban threshold (`isBanned`). Time already releases a ban (weight 100 falls below 80 in about 10 minutes at the default half-life); eviction must not release one sooner, otherwise spraying fresh names launders a real offender out of the table.
2. Among the rest, the lowest current score. A record whose penalties have all decayed, or that carries only successes, scores about 0 and goes first, which is the record that carries the least information.
3. Ties break to the least recently touched: `max(lastPenalty, lastSuccess)`, oldest first.

If every record is banned there is no victim: refuse the new record, drop the report, and log one `peer-reputation` line with the cap and a running count of refusals (same pattern as `refuseSelfReport`; count it, never act on it). A forgotten name scores 0 again, which is what an unseen machine already scores, so eviction is not a correctness problem.

Explicit non-goals: a machine's own name is already refused before a record is created (`refuseSelfReport`, `recordSuccess`'s `isSelf` guard) so it neither occupies a slot nor is evicted; do not touch that. Do not address whether unauthenticated peers should reach the signature check (open residual noted at `verifySignature`).

Accepted limits to state at the code site as `NOTE:`s, not fix: (a) only bans are protected, so a spray of fresh names, each scoring 50, can push a lower-scoring deprioritized record out — the same effect time has, just sooner; (b) an attacker with unlimited fresh keys can eventually fill a table with banned-weight records, after which genuine new offenders go unrecorded until those decay (minutes at the default half-life); (c) the victim scan is O(entries × penalties per entry) per creation once the table is full — tripwire: if the cap is ever raised into the tens of thousands or a profile shows the scan, keep a running lowest-score index or sample a bounded number of candidates.

## Tests

One test in `packages/db-p2p/test/peer-reputation.spec.ts`, at the service level (no mocks of repo-owned modules): with a small `maxPeers` (e.g. 4) and a short `halfLifeMs`, a banned record survives a spray of fresh names while the table never exceeds the cap and a lower-scoring record is the one forgotten; with the table entirely banned, a new name is refused and the cap holds. Follow the file's existing convention for time (real wall clock polling; see its `NOTE:`) — prefer a short half-life over sleeping. Do not add a test for the default value or config plumbing.

## TODO

- Add `maxPeers` (default 1024) to `ReputationConfig` in `types.ts` with a doc comment, and read it in the constructor
- Implement victim selection and refusal in `getOrCreateRecord`; update `reportPeer` and `recordSuccess` for the `undefined` return
- Replace the `NOTE:` on the `peers` map with one describing the cap and the three accepted limits above
- Add the single test described above
- Add a sentence to `docs/architecture.md` § Reputation & equivocation: the table is bounded, bans are never evicted, a full table of bans refuses new names; run `yarn lint:docs`
- Run `yarn test` in `packages/db-p2p` (or `yarn test -- --grep PeerReputation`) and typecheck
