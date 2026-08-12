description: A node that is briefly alone on the network — just started, or a moment after losing its last connection — cannot read a table that has never been written to. The read fails outright instead of coming back empty, which can stop the node from finishing its own start-up.
prereq:
files: packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-core/src/transactor/network-transactor.ts
difficulty: hard
repro: verified
----

# A read served by a degraded self-coordinator still fails closed on an unreachable cohort

Filed from the consuming repo (`../sereus`), where it is currently the top failure
of `packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts`
(7 of 8 consecutive runs on 2026-08-12).

## What happens

A node with **zero connections** reads a block it does not hold locally and that
nothing anywhere holds — the header block of a collection that has never been
written (an empty table). Two subsystems each behave as designed and compose into
a read that can never succeed:

1. `Libp2pKeyPeerNetwork.findCoordinator` finds no connected peer, decides a retry
   cannot improve (`retry-futile`), and picks **self** — knowingly degraded:
   `shouldAllowSelfCoordination` said no (`grace-period-not-elapsed`), so the pick
   is logged `fret-self-degraded ... intent=read` rather than refused. The point of
   that fallback is that an isolated node can still read its own replica.
2. The read then lands on the local `CoordinatorRepo.get`, which consults the
   cohort for the missing block. The one non-self cohort member is unreachable, so
   the consult is silent, `fetchBlockFromCluster` returns `inconclusive: true`, and
   `flagUnconfirmedAbsence` marks the entry `unavailable: 'peers-unreachable'`
   (`coordinator-repo.ts:391`, `:423`). `NetworkTransactor.get` retries against a
   different coordinator, has none, and the read throws
   `Block <id> is unavailable (peers-unreachable): the repo could not determine
   whether it exists`.

So the degraded self-pick hands the read to a repo that immediately invalidates it.
An isolated node can read only blocks it already holds — and a block that has never
been written is, by definition, not one of those. There is no state in which the
read later succeeds *from local data*: it needs a connection first.

## Log evidence

One captured window (peer-id-suffixed namespaces from
`debug-logs-cannot-say-which-node-they-came-from`; `KhDt` is the isolated node,
`AgJL` the peer it cannot reach). Trimmed to one round; the sequence repeats
identically until the caller gives up:

```
findCoordinator:fret-candidates key=FNSaQ7hhS7sl ids=[ AgJL…, KhDt… ] connected=[]
self-coord-blocked: grace-period-not-elapsed since=3190ms
findCoordinator:fret-self-degraded key=FNSaQ7hhS7sl reason=grace-period-not-elapsed intent=read attempt=0
findCoordinator:done key=FNSaQ7hhS7sl ms=0 source=fret
findCluster:detail key=ZGVmYXVsdC9S cohortPeers=[ KhDt…, AgJL… ] connectedPeers=[]
cluster-fetch:peers-silent { blockId: 'default/Revocation', silent: 1, consulted: 2 }
cluster-fetch:no-quorum   { blockId: 'default/Revocation', responders: 0, required: 1,
                            repairCorroborationClusterSize: 2 }
findCoordinator:start key=FNSaQ7hhS7sl excluded=[ AgJL… ]      <- transactor retry #1
… same result …
findCoordinator:start key=FNSaQ7hhS7sl excluded=[ KhDt…, AgJL… ]
findCoordinator:all-excluded key=FNSaQ7hhS7sl self=KhDt…       <- falls back to self anyway
… same result … then the read throws
```

`responders: 0` is the tell that the block is genuinely absent everywhere, not
merely absent locally: no peer claimed any revision of it. The consult failed only
because the one peer that could have said "I hold nothing" could not be reached.

## Why this matters beyond the test

The consuming product (Cadre) filters every membership read through a revocation
tombstone table. That table is empty on a fresh network, so **every** peer-record
read scans a never-written collection — and therefore every such read fails on a
node that has no connections yet. A node in its first seconds (or in the 30 s
`gracePeriodMs` after losing its last connection) cannot read its own control
database at all, which is exactly when start-up needs to.

The asymmetry is worth stating plainly: a *write* commits on a super-majority of the
cohort (0.75 by default), while an *absence* now requires unanimity — one silent
member is enough to make it unanswerable, forever if that member is simply
undialable.

## What is NOT wrong here

- The fail-closed rule itself is defensible and was added deliberately
  (`complete/2-cluster-read-consult-cannot-report-unreachable.md`): a silent peer
  could be the sole holder, so serving an authoritative absent is a lie. Nothing in
  this ticket argues for reverting it wholesale.
- `flagUnconfirmedAbsence` is not misfiring; its inputs are exactly what the code
  says they are.

What is unresolved is the **composition**: a coordinator that was selected *because*
the node is isolated then applies a rule that only a connected node can satisfy.

## Candidate shapes (not a decision — the fix stage should weigh them)

- **Consult the self-coordination verdict.** When the local repo is serving a read
  the key network already routed to a degraded self (isolation acknowledged), a
  missing block is as confirmed as it will ever get; report it authoritative and let
  the caller's own isolation semantics apply. Requires plumbing the "this is a
  degraded self-serve" bit from `findCoordinator` to `CoordinatorRepo.get`, which
  does not exist today.
- **Give absence the same threshold writes use.** Treat the consult as conclusive
  when a super-majority of the cohort answered "holds nothing", rather than
  requiring silence from nobody. Does not help a 2-member cohort where the one peer
  is the silent one — which is the case measured above.
- **Distinguish "never existed" from "not here".** `responders: 0` with every
  reachable peer answering is a different state from "one peer answered with a
  revision we could not acquire". Only the latter needs to fail closed.

Whichever shape wins, it interacts with `implement/1-coordinator-serves-stale-data-as-if-confirmed`,
which is mid-implementation at the **same site** (`CoordinatorRepo.get`'s flagging
decisions) and pushes the opposite way — it widens what gets flagged as unconfirmed.
Read that ticket first; if the two are best resolved together, fold this in as a
second arm rather than landing them blind to each other.

## Second arm (added by the review of `coordinator-serves-stale-data-as-if-confirmed`)

That ticket has landed. It made a **present** block say when it could not be confirmed
current, and it left the mirror case on the **missing** path deliberately untouched — so
this ticket now owns both halves of the same decision, which is why it is filed here as an
arm rather than as its own ticket.

The untouched case: a block missing locally, one cohort peer claims a revision, the
corroboration quorum declines it (one voter, floor of two), and **every** peer answers, so
nothing is silent. `fetchBlockFromCluster` computes that claim and hands it up
(`claimedAheadRev`), but `CoordinatorRepo.get` only consults it for present blocks — the
missing entry goes back as an unflagged, authoritative "this block does not exist", to a
reader that a peer has just told the block *does* exist at a revision.

This is the same lie the just-landed work removed for present blocks, and it is the exact
distinction the third candidate shape above already proposes: "one peer answered with a
revision we could not acquire" is a different state from `responders: 0`. Note the two arms
pull opposite ways at the same code site — the isolated-boot arm wants absence to be
believed more readily, this one wants it believed less — which is the point of resolving
them in one pass:

- `responders: 0`, everyone reachable answered "I hold nothing" → the absence should be
  authoritative even on an isolated/degraded self-coordinated read (arm one).
- at least one peer claims a revision, corroborated or not → the absence is a guess and must
  say so (arm two), regardless of how many peers stayed quiet.

The marker to reuse already exists and already crosses the wire; whether this arm should
stamp `unavailable: 'peers-unreachable'` (existence doubt — the reader must retry) or the
newer `unconfirmedAheadRev` (currency doubt) on an entry with no content at all is the
design question the fix stage should settle. Both are plumbed end to end today.

## Reproduce

In `../sereus/packages/integration-tests` (fails in the first ~5-15 s, before the
scenario's own subject matter is reached):

```
yarn vitest run src/scenarios/control-cohort-edge-carries-data.integration.ts
```

with `DEBUG='optimystic:db-p2p:coordinator-repo*,optimystic:db-p2p:libp2p-key-network*'
and `OPTIMYSTIC_VERBOSE=1` for the trace above.

**Measurement hazard:** heavy `DEBUG` output slows the run enough that it often
fails on a *different*, unrelated boot gate instead. Attribute a run by its error
text, not by the fact that it failed.

A local repro in this repo should be cheaper and is the right first step: a
`CoordinatorRepo` whose `keyNetwork.findCluster` returns `{self, peerX}`, whose
`clusterLatestCallback` rejects for `peerX`, and a `get` for a block no one holds.
That is the whole mechanism; the sereus scenario adds nothing but realism.
