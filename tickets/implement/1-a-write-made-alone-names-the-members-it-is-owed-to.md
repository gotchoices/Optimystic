description: When a machine writes alone because the other members of its group are unreachable, it reports and records the write as owed to nobody, even though it knows those members exist. Name them, so the write's report is honest, the machine's record of owed copies lists them, and the copy is sent to them as soon as they are connected.
files:
  - packages/db-core/src/network/i-key-network.ts (`IKeyNetwork` — add an optional method beside `awaitingBootstrapContact`)
  - packages/db-p2p/src/libp2p-key-network.ts (`rememberedServing`, `membershipOf`, `assembleServingCohort`, `findCluster`, `servingCohortAt`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`commitSolo`, `pendSolo`, `soloCohortDurability`, `noteBlockShortfall`)
  - packages/db-core/src/network/durability.ts (`localDurability`)
  - packages/db-core/src/network/struct.ts (`DurabilityQuorum` 'local' doc, `WriteDurability.unconfirmed` / `cohort` docs)
  - packages/db-p2p/src/repo/under-replication-drain.ts (`owedPeers` — should need no change; confirm)
  - packages/db-p2p/docs/repo.md (§The durability gate and the under-replication ledger table; §The under-replication drain "Works out who is owed a copy")
  - docs/internals.md ("Out of scope here: a write to a collection the node already holds, made before contact, still commits alone." under the three-answer block read)
  - p2p-fret `hashPeerId` (exported; the ring coordinate of a peer id)
repro: verified
----

# A write made alone names the members it is owed to

Reported by sereus (sereus-sam, https://github.com/gotchoices/sereus/issues/44). Sereus wants a release as soon as this lands; tell sereus-sam the version, and tell them what this does and does not fix (below).

## What was found (fix stage)

**The reported loss is a lone-survivor write, and its admission is not ours to change here.** On the slow relay arm, the joiner's node was connected only to the relay when it wrote. Its key network had no live serving peer besides itself, so every block's cohort resolved to the joiner alone and the commit took the solo short-circuit at `quorum: 'local'`. That is the same shape as a lone survivor of a two-machine group writing while its partner is away (phase 5 of `packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts`), and optimystic cannot tell the two apart: in both, the node remembers a serving member that is not currently in the ring. Whether such a write is admitted is owned by `backlog/more-design/6.5-partition-healing`, where the maintainer decided (2026-09-15) not to pin it with a point fix. An arm with this evidence was appended there. A machine that writes alone and then stops for good cannot deliver its write by any mechanism; the guarantees available are an honest report (`local` is already not fully durable — `isFullyDurable` is false) and the app being able to see it (plan ticket `5.5-feat-sql-commit-durability-reaches-the-app`, GitHub #26), or sereus's own option of treating "no strand peer connected" as not writable.

**Restart delivery works once the two machines reconnect (hypothesis 2 refuted at the db-p2p layer).** Two temporary reproductions were run and then removed (they passed, so they reproduce nothing), both using `test/util/two-machine-lifecycle.ts` with the documented two-machine configuration:

- direct TCP: pair writes; B stops; A writes alone (`commit:solo-cohort`, `quorum: 'local'`); A stops and restarts with a **fresh in-memory key-value store** (its under-replication ledger lost — sereus supplies no `kvStore`, so this is its configuration); B starts dialing A; B held every block A wrote alone ~5 s after the pair formed.
- the same over a circuit relay, phone-shaped (WebSockets + circuit transports only, `spawnRestartablePlainRelay`), A restarting knowing only the relay: same result, ~5 s.

The deliverer in both was the rebalance monitor's growth arm (`rebalance check: gained=3 lost=0 grown=3` after restart: owned blocks are re-seeded from storage and the first check reports the whole non-self cohort). So the phones' 30-minute miss is not a failure of the replication paths once connected; the likely cause is that the two strand nodes never re-established a connection after restart, which this layer cannot see. The diagnostics below are meant to settle that from the next sereus log.

**What is wrong regardless of admission (hypothesis 1, this ticket).** The solo commit reports `cohortPeerIds: [self]`, `unconfirmed: []`, `cohort: 1` — "the cohort was named and nobody is missing" — and `noteBlockShortfall` records the ledger entry with an empty missing set. The node knew better: `rememberedServing` in `packages/db-p2p/src/libp2p-key-network.ts` holds every peer this process has seen serving this network (and, with `persistence`, across a restart), and a peer FRET has dropped from the live ring stays in it. The empty set has two costs:

- The write's report says the write is complete on a cohort of one, when it is owed to a member the node knows about. An app reading `unconfirmed` (once GitHub #26 surfaces it) learns nothing.
- The drain re-resolves an empty entry through `findCluster`, which needs FRET to have re-admitted the member to its ring. A named entry is pushed as soon as the member is connected and identified, whatever FRET thinks (`owedPeers` in `packages/db-p2p/src/repo/under-replication-drain.ts` never re-resolves named members). This matters more under p2p-fret 1.0.2, which now marks a disconnected address-less (relay-only) peer dead, so relay-only partners leave the ring sooner.

## Design

**Key network: the known serving members missing from a block's cohort.** Add an optional method to `IKeyNetwork` in `packages/db-core/src/network/i-key-network.ts`, beside `awaitingBootstrapContact`, e.g. `knownMembersOutsideCohort?(key: RoutingKey): Promise<string[]>` (name it as you see fit). `Libp2pKeyPeerNetwork` answers it from the same assembly `findCluster` uses (`assembleServingCohort`), so the two cannot disagree:

- Candidates are the remote peers whose membership verdict is `serves` — `rememberedServing`, which is the one memory of positive verdicts — minus the assembled cohort, minus self. Never `unknown` or `foreign` peers, and never bootstrap peers merely configured (a bootstrap peer is often a relay). Read the verdict through `membershipOf`'s rules so plan ticket `3-a-peer-joins-a-cohort-by-claiming-the-networks-protocols`, which adds an embedder membership predicate there, covers this too.
- Expected cohort = the nearest `clusterSize` peers among (assembled serving cohort ∪ candidates). When that union has at most `clusterSize` members — every closed group up to the cluster size, which includes the sereus two-member strand — every candidate is in it, no ranking needed. Otherwise rank candidates by two-sided ring distance from the block's coordinate (`hashKey(key)`), using `hashPeerId` from p2p-fret for a candidate's coordinate. This only decides who is pushed a copy, and a copy to a peer outside the true cohort is harmless (the drain already accepts that for named members), so an approximation of FRET's alternating walk is acceptable; say so in a comment.
- Return the candidates that made the expected cohort, in proximity order. A node that has never seen another serving peer returns `[]`, so a genuine one-machine deployment is unchanged.

Only `CoordinatorRepo`'s solo path asks, and only when the cohort resolved to this node alone, so no normal-path lookup pays for it.

**Durability.** `soloCohortDurability` (`packages/db-p2p/src/repo/coordinator-repo.ts`), for a cohort resolved to exactly this node, includes the known absent members: `quorum: 'local'`, `confirmed: 1`, `cohort: 1 + n`, `unconfirmed: [...absent]`, `cohortPeerIds: [self, ...absent]`. With none, the answer is today's `localDurability(self)` exactly. Extend `localDurability` in `packages/db-core/src/network/durability.ts` with an optional absent list rather than building the object by hand. `local` stays the class — "nobody else holds the revision yet" is still true; `unrouted` is untouched. Update the `'local'` doc in `DurabilityQuorum` and the `soloCohortDurability` doc, both of which currently describe a solo write as "a correct and complete one-machine write": that is true only when no member is named. Check every reader of `cohort`, `unconfirmed` and `cohortPeerIds` (`mergeDurability`, `durabilityRank`, the plugin's display paths, tests asserting `cohort: 1`) for an assumption that a `local` answer has `cohort === 1`. `pendSolo` uses the same function and should stay consistent with it.

**Ledger.** `noteBlockShortfall` records `missingPeerIds: durability.unconfirmed ?? []` for `local` as it does for `majority` (`unrouted` keeps `[]`). The drain then treats the entry as named. Confirm that `UnderReplicationDrain.owedPeers` needs no change, and that a named `local` entry whose members all confirm clears and fires the full-replication event exactly as a `majority` entry does.

**Diagnostics for the open phone question.** The `commit:solo-cohort` log line gains `knownAbsent` (the count, or the short ids) and `awaitingBootstrap` (the key network's `awaitingBootstrapContact()`, which `CoordinatorRepo` already asks on the read path). On the next sereus run this separates three cases the current line cannot: the joiner knew of the founder and was not connected (`knownAbsent > 0`), it was still waiting to hear from a configured peer (`awaitingBootstrap`), or it had never identified the founder's strand node at all (neither) — the last meaning the first-sync gate passed without the two strand nodes ever exchanging identify, which is sereus's to look at.

**Tradeoff to record as a `NOTE:` at the ledger write.** A named member that never returns keeps its entry until the ledger's size cap evicts it — the same as an empty entry on a node whose cohort stays self-only today, so no new cost. Revisit if a deployment reports ledger growth from a permanently departed partner; the remedy is the declared member list (`feat-declared-membership-feeds-cohort-assembly`) or a "forget peer" operation, the same remedy the accepted-tradeoff `NOTE:` at `membershipOf` names.

## Tests

One behaviour, one test, at the lowest layer:

- In the existing `CoordinatorRepo` solo-commit tests (find them with `grep -rln "commit:solo-cohort\|soloIsSelf\|localDurability" packages/db-p2p/test`), a key-network double that reports one known absent member: the solo commit's durability names it in `unconfirmed` and `cohortPeerIds` with `cohort: 2`, and the ledger entry's `missingPeerIds` names it. A double without the method (or returning `[]`) gives today's answer — likely already covered by existing assertions; do not add a second test for it.
- If the ring-distance ranking is implemented (the union wider than `clusterSize`), it has real branching: one `Libp2pKeyPeerNetwork` unit test that a remembered peer farther than `clusterSize` live members is not named, and a nearer one is. Skip if the implementation limits itself to the small-group arm and documents the wider case as a `NOTE:`.

Do not add a real-socket spec for restart delivery: it passed in the fix stage and the growth arm's restart behaviour is already pinned (`cohort-growth-heals-single-holder.spec.ts`; phase 7 of the lifecycle spec covers the durable-ledger restart).

## Docs

- `docs/internals.md`: the sentence "Out of scope here: a write to a collection the node already holds, made before contact, still commits alone." → say it still commits alone, at `local`, and now names the serving members it knows of as unconfirmed and owed; whether it should be admitted at all is the partition-healing design's.
- `packages/db-p2p/docs/repo.md`: the ledger table row for `local` (named when the node knows serving members outside the cohort, empty otherwise), and the drain's "Works out who is owed a copy" bullet.
- `docs/internals.md` § UnderReplicationDrain points at repo.md; check it still reads true.

## TODO

- Add the optional `IKeyNetwork` method and implement it in `Libp2pKeyPeerNetwork` from `rememberedServing` and the cohort assembly.
- Extend `localDurability` with named absent members; use it from `soloCohortDurability` (make the solo paths await the key network's answer when the cohort resolved to self).
- Record `unconfirmed` as `missingPeerIds` for `local` in `noteBlockShortfall`; add the tradeoff `NOTE:`.
- Add `knownAbsent` and `awaitingBootstrap` to the `commit:solo-cohort` log line.
- Update the `DurabilityQuorum` / `WriteDurability` docs, repo.md and internals.md as above.
- Add the unit test(s) above; run `yarn build`, `yarn test` in db-core and db-p2p, and `yarn test:integration` in db-p2p (the lifecycle and relay specs assert `quorum: 'local'` on the away write and may assert on `cohort` or `unconfirmed`).
- In the review handoff, draft the note to sereus-sam: what lands (honest `unconfirmed`, named ledger entries, the new log fields), what it does not fix (a joiner that writes alone and stops for good still loses the write; that needs the app to see `local` — GitHub #26 — or cadre-core's own writability gate), and the request to rerun the scenario with the new log fields.
