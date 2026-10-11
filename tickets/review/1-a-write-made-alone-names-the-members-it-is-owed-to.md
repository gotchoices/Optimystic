description: When a machine writes alone because the other members of its group are unreachable, it now names those members as the ones the write is owed to — in the write's report, in its record of copies still owed, and so in who gets the copy pushed the moment they reconnect. Review the change and send the release note to sereus.
files:
  - packages/db-core/src/network/i-key-network.ts (`IKeyNetwork.absentCohortMembers`, new, optional)
  - packages/db-core/src/network/durability.ts (`localDurability` takes an absent list)
  - packages/db-core/src/network/struct.ts (`DurabilityQuorum` 'local' doc, `WriteDurability.cohort` / `unconfirmed` docs)
  - packages/db-p2p/src/libp2p-key-network.ts (`absentCohortMembers`, `servingPeersOutside`, `nearestTo`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`soloCohortDurability` now async, `absentCohortMembers`, `pendSolo`, `commitSolo` log line, `noteBlockShortfall` + its `NOTE:`)
  - packages/db-p2p/src/repo/i-under-replication-ledger.ts (`missingPeerIds` / `satisfy` docs)
  - packages/db-p2p/src/repo/under-replication-drain.ts (class doc only; `owedPeers` unchanged)
  - packages/db-p2p/test/coordinator-repo-write-durability.spec.ts
  - packages/db-p2p/test/libp2p-key-network.spec.ts
  - packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts (phase 5)
  - docs/internals.md, docs/correctness.md, docs/debugging.md, packages/db-p2p/docs/repo.md
----

# A write made alone names the members it is owed to — review handoff

Reported by sereus (sereus-sam, https://github.com/gotchoices/sereus/issues/44). Sereus wants a release as soon as this lands; the note for them is at the end.

## What changed

Before: a commit that took the solo short-circuit (its block's cohort resolved to this node alone) answered `{ quorum: 'local', confirmed: 1, cohort: 1, unconfirmed: [], cohortPeerIds: [self] }` — "the cohort was named and nobody is missing" — and recorded an under-replication ledger entry with an empty missing set ("unknown"). That was false whenever the node remembered a serving partner that had merely dropped out of FRET's live ring (the lone survivor of a two-machine group, or a relay-only joiner).

Now:

- **Key network.** `Libp2pKeyPeerNetwork.absentCohortMembers(key)` answers "which serving members do I know of that belong in this key's cohort but are not in it now". Candidates are the peers in `rememberedServing`, re-read through `membershipOf` (so the planned embedder membership predicate in plan ticket `3-a-peer-joins-a-cohort-by-claiming-the-networks-protocols` will cover it), excluding self and **every peer in the assembly's band** (see the deviation below). The expected cohort is the nearest `clusterSize` of (assembled cohort ∪ candidates) by two-sided ring distance (`minDistance` over `hashPeerId`), and the candidates in it are returned nearest first. Never-seen-another-peer → `[]`, so a genuine one-machine deployment is unchanged.
- **Durability.** `soloCohortDurability` asks it only when the cohort resolved to exactly this node, and builds `localDurability(self, absent)` → `{ quorum: 'local', confirmed: 1, cohort: 1 + n, unconfirmed: absent, cohortPeerIds: [self, ...absent] }`. With none, byte-identical to before. A throwing lookup is logged (`coordinator-repo:absent-members-failed`) and names nobody. `pendSolo` uses the same function, so a solo pend reports the same way.
- **Ledger.** `noteBlockShortfall` now records `unconfirmed` as `missingPeerIds` for `local` as for `majority`; only `unrouted` keeps `[]`. The drain treats it as a named entry: pushed as soon as the member is connected and identified, never re-resolved through `findCluster`, so FRET re-admitting the member to its ring is no longer a precondition. `UnderReplicationDrain.owedPeers` needed no change (confirmed by reading `owedPeers` → `recordConfirmed` → `satisfy`; and the lifecycle spec's phase 5 now waits for exactly that named `local` entry to clear, and it does).
- **Diagnostics.** `commit:solo-cohort` gains `knownAbsent` (count), `absentPeers` (12-char ids, only when non-zero) and `awaitingBootstrap` (`IKeyNetwork.awaitingBootstrapContact`). These separate: knew of the founder but was not connected (`knownAbsent > 0`); still waiting on a configured peer (`awaitingBootstrap: true`); neither (genuinely alone, or never identified the other strand node — the last is sereus's to look at).
- **Tradeoff `NOTE:`** at the ledger write in `noteBlockShortfall`: a named member that never returns keeps its entry until the ledger's size cap evicts it — no new cost over today's unnamed entry; revisit condition and remedy stated.

Audited readers of `cohort` / `unconfirmed` / `cohortPeerIds` (`mergeDurability`, `distinctReports`, `durabilityRank`, `withTornBlocks`, `reportBlockHolders`, `lineage.ts`, the transactor and the Quereus plugin): none assumes a `local` answer has `cohort === 1`.

## Deviations from the ticket, and known gaps

- **Band, not cohort, is excluded from candidates.** The ticket said "minus the assembled cohort". I exclude the whole assembly band (the live ring members FRET returned near the key). A remembered peer that is live in the band but left out of the cohort was left out by FRET itself, which is the authority on live members; ranking it with my approximate metric could otherwise name a live, non-responsible peer as "owed" (most plausibly at `clusterSize: 1`). Reviewer: confirm you agree.
- **Ranking is an approximation of FRET's alternating successor/predecessor walk** (stated in a `NOTE:` on `absentCohortMembers`). Only decides who is pushed a copy; harmless. When cohort ∪ candidates ≤ `clusterSize` (every small group, including sereus's two-member strand) every candidate is in it whatever the ranking.
- **One cohort answer for every block of a multi-block solo commit**, computed for `blockIds[0]` — the same approximation the `majority` path already makes for `unconfirmed`.
- **Unscoped key network (no `protocolPrefix`)** never learns serving verdicts, so it names nobody unless `servingPeers` was restored from persisted state. Production always sets a prefix (`createLibp2pNodeBase`).
- **Corrupt persisted peer id.** If `rememberedServing` holds a string `peerIdFromString` rejects, the whole lookup throws and the solo answer names nobody (logged). Not guarded per-id; persisted ids are filtered to FRET's table on save, so not expected.
- **Cost.** Every solo commit/pend whose cohort resolved to self now makes a second cohort assembly, one peerStore read per remembered peer outside the band, and one SHA-256 per member of the union, plus an `awaitingBootstrapContact()` call for the log line. A node that has never seen another serving peer pays one assembly and nothing else (the `findCluster` `NOTE:` measured an assembly at ~0.009 ms). No tripwire filed — only the solo path pays.
- **The rebalance block-holders sink still hears nothing from a solo commit** (unchanged; the growth arm's first check after a partner reappears already reports the whole cohort).
- **Release notes not drafted.** `.release-notes.pending.md`'s top section ("Unreleased — since v1.12.0") looks like it is the already-released v1.12.1's; I left the file for whoever cuts the release rather than restructure it.

## Tests

- `packages/db-p2p/test/coordinator-repo-write-durability.spec.ts` — "a solo commit that knows of a member it could not reach names it as owed, in the answer and in the ledger": a key-network double reporting one absent member → `{ local, confirmed 1, cohort 2, unconfirmed [B], cohortPeerIds [self, B] }` and a ledger entry with `missingPeerIds: [B]`. The no-method case is the existing "a cohort that resolved to exactly this node … local" deep-equal and "a solo commit records an empty missing set" tests, both unchanged and passing.
- `packages/db-p2p/test/libp2p-key-network.spec.ts` — "absentCohortMembers() names a remembered serving peer that ranks inside the expected cohort, and not one that ranks outside it": `clusterSize: 2`, two live serving members, two remembered-but-gone peers (one nearest the key, one farthest) → only the nearest is named. Pins the ranking branch.
- `packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts` phase 5 — one added assertion beside the existing `quorum: 'local'` check: the away write's `unconfirmed` is exactly `[B]`. This is the real-socket confirmation that `rememberedServing` holds B after FRET drops it; it passed, and the phase's existing wait for A's ledger to clear now exercises the named `local` entry.

## Validation run

`yarn build`, `yarn lint`, `yarn lint:docs`, `yarn typecheck`: clean. `yarn test` in db-core: 1882 passing. `yarn test` in db-p2p: 3277 passing, 70 pending. `yarn test:integration` from root: db-p2p 50 passing / 2 pending, quereus-plugin-optimystic 1007 passing / 8 pending. Not run: `check:rn` (no new syntax; `p2p-fret` was already imported), `lint:deps` (no dependency change).

## Use cases to check by hand

- Two-machine group, B stopped, A writes: answer `local`, `cohort: 2`, `unconfirmed: [B]`; ledger entry names B; B restarts and connects → drain pushes, entry clears, full-replication event fires.
- Genuine one-machine node: answer and ledger exactly as before (`cohort: 1`, `unconfirmed: []`, empty missing set).
- Joiner that never identified the founder: `knownAbsent: 0`, `awaitingBootstrap` true until the configured peer is heard from.

## Note to send sereus-sam (once released — fill in the version)

> Optimystic vX.Y.Z addresses part of sereus#44.
>
> **What lands.** When a node writes alone because the other members of its group are unreachable, and it has previously seen those members serving the network, it now says so. The write's `WriteDurability` stays `quorum: 'local'` (not fully durable, as before), but `cohort` counts the known members and `unconfirmed` names them. The node's under-replication record names them too, so the copy is pushed to each one as soon as it is connected and identified — no longer waiting for FRET to re-admit it to the ring, which matters more now that p2p-fret 1.0.2 drops a disconnected relay-only peer sooner. The `commit:solo-cohort` log line gains `knownAbsent` (and `absentPeers`) and `awaitingBootstrap`.
>
> **What it does not fix.** A joiner that writes alone and then stops for good still loses that write: no mechanism can deliver bytes from a machine that never comes back. Seeing that a write is only `local` needs the app to read the durability class (our GitHub #26), or cadre-core's own rule of treating "no strand peer connected" as not writable. Whether a lone node should accept the write at all is still under design on our side. We also found that once the two machines reconnect, restart delivery works over both TCP and a circuit relay (~5 s in our reproductions), so the 30-minute miss in your run most likely means the two strand nodes never re-established a connection.
>
> **Please rerun the scenario** with `DEBUG=optimystic:*` and send the `commit:solo-cohort` lines from the joiner. `knownAbsent > 0` means it knew the founder and was not connected; `awaitingBootstrap: true` means it was still waiting on a configured peer; neither means it never identified the founder's strand node, which would point at the first-sync gate.
