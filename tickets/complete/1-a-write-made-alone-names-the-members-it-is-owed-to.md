description: When a machine writes alone because the other members of its group are unreachable, it now names those members as the ones the write is owed to — in the write's report, in its record of copies still owed, and so in who gets the copy pushed the moment they reconnect. Reviewed; the release note for sereus is below.
files:
  - packages/db-core/src/network/i-key-network.ts (`IKeyNetwork.absentCohortMembers`, optional)
  - packages/db-core/src/network/durability.ts (`localDurability` takes an absent list)
  - packages/db-core/src/network/struct.ts (`DurabilityQuorum` 'local', `WriteDurability.cohort` / `unconfirmed` docs)
  - packages/db-p2p/src/libp2p-key-network.ts (`absentCohortMembers`, `servingPeersOutside`, `nearestTo`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`soloCohortDurability`, `absentCohortMembers`, `pendSolo`, `commitSolo`, `noteBlockShortfall`)
  - packages/db-p2p/src/repo/i-under-replication-ledger.ts, packages/db-p2p/src/repo/under-replication-drain.ts (docs)
  - packages/db-p2p/test/coordinator-repo-write-durability.spec.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts
  - docs/internals.md, docs/correctness.md, docs/debugging.md, packages/db-p2p/docs/repo.md, .release-notes.pending.md
----

# A write made alone names the members it is owed to

Reported by sereus (sereus-sam, https://github.com/gotchoices/sereus/issues/44).

## What landed

A commit or pend that takes the solo short-circuit because its block's cohort resolved to this node alone now asks the key network which serving members it knows of belong in that cohort but are missing from it (`Libp2pKeyPeerNetwork.absentCohortMembers`). Candidates come from the remembered serving verdicts (`rememberedServing`, re-read through `membershipOf`), excluding self and every peer in FRET's assembly band; the expected cohort is the nearest `clusterSize` of (assembled cohort ∪ candidates) by two-sided ring distance. The answer becomes `{ quorum: 'local', confirmed: 1, cohort: 1 + n, unconfirmed: absent, cohortPeerIds: [self, ...absent] }`; with nobody known it is byte-identical to before. The under-replication ledger records the named members for `local` as for `majority`, so the drain pushes the copy as soon as each named member is connected and identified, without waiting for FRET to re-admit it. `commit:solo-cohort` gains `knownAbsent`, `absentPeers` and `awaitingBootstrap`. Landed in `ticket(implement): a-write-made-alone-names-the-members-it-is-owed-to`.

## Review findings

**Checked, by reading the implement diff first and then the surrounding code:**

- *Correctness of the candidate set.* `servingPeersOutside` → `membershipOf` drops a remembered peer whose fresh peerStore list no longer serves this network, and never admits `unknown` peers. Excluding the whole band rather than only the cohort (the implementer's deviation) is right: the only band members it removes from consideration are ones FRET placed outside the cohort (the `clusterSize` cut) or that read foreign. Ranking them with the approximate metric could name a peer that FRET had already ruled out as not responsible. Agreed, no change.
- *Bootstrap wait.* The second assembly inside `absentCohortMembers` goes through `assembleServingCohortAt`, which can wait for a bootstrap peer. It can only wait when the first assembly did not already close the wait, which happens when `resolveCohort` answered from the responsibility cache. That is the same bounded wait `findCluster` itself makes. Acceptable.
- *Consumers of `local`.* Grepped every reader of `WriteDurability.cohort` / `unconfirmed` / `cohortPeerIds` across packages. Only `distinctReports` (compares peer lists as sets) and `reportBlockHolders` (not reached from the solo path) read them, and nothing assumes `local` means `cohort === 1`. `mergeDurability` ranks by quorum, not cohort size.
- *Ledger and drain.* `noteBlockShortfall` now records `unconfirmed` for everything but `unrouted`. The drain's named-entry path needs no change, and the phase-5 and phase-7 integration runs show a named `local` entry clearing once B returns.
- *Error handling.* A throwing lookup is logged (`coordinator-repo:absent-members-failed`) and names nobody. Per-peer peerStore failures are skipped inside `getPeerStoreProtocolsByPeer`. A corrupt persisted id makes `peerIdFromString` throw in `nearestTo`, and that lands in the same logged fallback.
- *Docs.* `docs/internals.md`, `docs/debugging.md`, `docs/correctness.md`, `packages/db-p2p/docs/repo.md` and the in-code docs on the ledger and drain all describe the new state. `yarn lint:docs` is clean.
- *Tests.* All three changes earn their place. The coordinator spec pins the answer and the ledger entry. The key-network spec pins the ranking branch (one remembered peer inside the expected cohort, one outside), which is the only real branching in the new lookup. The integration assertion confirms with real sockets that `rememberedServing` still holds B after FRET drops it. None was cut, and none was added: no defect was found that a test would reproduce.

**Found and fixed inline:**

- *Release note.* `.release-notes.pending.md`'s top section was v1.12.1's: it was drafted at eea9abc1, 24 minutes before `chore: release v1.12.1`, with no commits in between. I relabelled it "v1.12.1 — published to npm, no GitHub release page yet", following the file's existing convention, and added a new "Unreleased — since v1.12.1" section with this change's note, including the API-visible change that `local` no longer implies `cohort === 1`.

**Tripwires (conditional, parked as `NOTE:`):**

- *Lookup cost grows with remembered peers.* `servingPeersOutside` makes one peerStore read, and `nearestTo` one ring hash, per remembered serving peer outside the band, on every solo write. On a node cut off from a wide network it once saw, that is every peer it ever saw serving, on every write. Parked as a `NOTE:` on `servingPeersOutside` in `packages/db-p2p/src/libp2p-key-network.ts`, with the remedy: memoize ring positions and pre-select by distance.

**Noticed, not acted on (with reason):**

- *`cohort` can exceed `clusterSize` on a wide, cut-off network.* Self's cohort resolved to self alone, but self is not among the nearest `clusterSize` of the peers it remembers. In that case `cohort` reports `1 + clusterSize`. The named peers are still the right ones to push to, and no consumer reads `cohort` as a bound, so I left it alone. If the field ever gains a consumer that treats it as at most `clusterSize`, the fix is to report this case as `unrouted` instead.
- *Already recorded by the implementer as accepted tradeoffs or known gaps:* the ranking approximation (`NOTE:` on `absentCohortMembers`); a named member that never returns keeps its ledger entry until the size cap evicts it (`NOTE:` in `noteBlockShortfall`); one cohort answer serves every block of a multi-block solo commit, computed for `blockIds[0]`, the same approximation the `majority` path makes; an unscoped key network names nobody; and the rebalance block-holders sink still hears nothing from a solo commit. None of their revisit conditions has tripped.

**Major findings / tickets filed:** none. Nothing found serves a current-release anchor beyond what landed.

## Validation

`yarn workspace @optimystic/db-p2p build`, `yarn lint` and `yarn lint:docs` are clean. `yarn test` in db-p2p: 3277 passing, 70 pending. `small-deployment-lifecycle.integration.spec.ts` with `OPTIMYSTIC_INTEGRATION=1`: 7 passing. The implementer's run of db-core (1882 passing) and the full `yarn test:integration` stand: this review touched only a comment in db-p2p and the release-notes file.

## Note to send sereus-sam (once released — fill in the version)

> Optimystic vX.Y.Z addresses part of sereus#44.
>
> **What lands.** When a node writes alone because the other members of its group are unreachable, and it has previously seen those members serving the network, it now says so. The write's `WriteDurability` stays `quorum: 'local'` (not fully durable, as before), but `cohort` counts the known members and `unconfirmed` names them. The node's under-replication record names them too, so the copy is pushed to each one as soon as it is connected and identified — no longer waiting for FRET to re-admit it to the ring, which matters more now that p2p-fret 1.0.2 drops a disconnected relay-only peer sooner. The `commit:solo-cohort` log line gains `knownAbsent` (and `absentPeers`) and `awaitingBootstrap`.
>
> **What it does not fix.** A joiner that writes alone and then stops for good still loses that write: no mechanism can deliver bytes from a machine that never comes back. Seeing that a write is only `local` needs the app to read the durability class (our GitHub #26), or cadre-core's own rule of treating "no strand peer connected" as not writable. Whether a lone node should accept the write at all is still under design on our side. We also found that once the two machines reconnect, restart delivery works over both TCP and a circuit relay (~5 s in our reproductions), so the 30-minute miss in your run most likely means the two strand nodes never re-established a connection.
>
> **Please rerun the scenario** with `DEBUG=optimystic:*` and send the `commit:solo-cohort` lines from the joiner. `knownAbsent > 0` means it knew the founder and was not connected; `awaitingBootstrap: true` means it was still waiting on a configured peer; neither means it never identified the founder's strand node, which would point at the first-sync gate.
