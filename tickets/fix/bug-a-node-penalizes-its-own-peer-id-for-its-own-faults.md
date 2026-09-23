description: When a machine's own copy of the database fails a step, the machine files a complaint against itself. Enough complaints and it stops trusting itself, after which it will not accept writes it is supposed to handle.
architecture: docs/architecture.md#reputation--equivocation
files:
  - packages/db-p2p/src/reputation/peer-reputation.ts (`PeerReputationService.reportPeer` — the one place a guard would go; the service is never told which peer id is its own)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`prevoteLocalPromise` and `collectCommits` — the two call sites that can name the local peer)
  - packages/db-p2p/src/libp2p-key-network.ts (`isSelectable` — where a banned score removes a peer, self included, from coordinator selection)
  - packages/db-p2p/src/network/network-manager-service.ts (the second `isBanned` consumer)
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The blast radius is bounded — it takes sixteen local consensus faults inside one thirty-minute decay window to reach the ban threshold, and a machine failing that often has a bigger problem than its own reputation entry, so a maintainer may reasonably rank this below work with a user visible in the loop.
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-09-23T18:36:45.764Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\bug-a-node-penalizes-its-own-peer-id-for-its-own-faults.fix.2026-09-23T18-36-45-761Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
# A node files reputation penalties against itself

## What happens

Every machine keeps a running score for each machine it talks to, and stops dealing with one whose score gets bad enough. The score is meant to describe *other* machines. It does not exclude the machine keeping it.

So when this machine's own copy of the database throws during a consensus step — a validation failure, a merge failure, a storage fault — the coordinating code records that as a penalty against this machine's own identifier, in the same table it uses for everyone else. Nothing distinguishes the entry from a penalty against a stranger.

Once enough of those accumulate, the machine's own identifier crosses the "stop dealing with this one" threshold, and the machine removes itself from the list of candidates allowed to handle a piece of data. On a deployment of one or two machines there may be no other candidate, so writes that machine is responsible for simply stop being accepted — for as long as the score stays high. The score decays, so it recovers on its own, but the outage lasts as long as the faults keep arriving.

## Why it is one problem and not two

The reputation service has no notion of "me". It is constructed with no identity, so nothing in it can tell a report about a stranger from a report about its own host, and every caller has to remember to exclude itself by hand. Two callers in the consensus coordinator do not: the promise round's local-member step reports the local identifier unconditionally, and the commit round's collection step reports whichever members failed, which includes the local one on the path where the local pre-signature did not take.

Fixing the two callers would leave the same trap for the third. The root cause is that the service cannot refuse a report it should never have been given.

The design already treats self-harm as something to suppress rather than tolerate: the dispute subsystem has a monitor whose stated job is to stop a machine disputing when its own dispute losses climb, so it does not damage itself ([docs/architecture.md §Reputation & equivocation](../../docs/architecture.md#reputation--equivocation)). The scoring table under the same heading describes penalties as tracking *peer* behaviour. Both say what is intended here; nothing enforces it.

## Expected behaviour

A machine's reputation table describes other machines only. A report naming the machine's own identifier is not recorded, and the machine is never excluded from handling data on the strength of its own faults — which are, in any case, not something a different machine would handle any better.

Local faults still need to be visible. They are already logged at each site; whatever replaces the self-report should keep them countable by an operator, just not by a mechanism that can take the machine out of service.

## How to confirm it

Read-only inference, not observed. Confirming it takes a coordinator wired with a real reputation service and a local member that throws on the promise round: drive sixteen writes through it inside the decay window and check that the service reports the coordinator's own identifier as banned, and that coordinator selection then refuses to name that machine.

## For whoever picks this up

Two things worth settling before writing code, not decided here:

- The service would need to be told its own identifier. It is built in the node factory, which has one to hand, but it is also built directly in tests and could be built by an embedder — so the identity has to be optional, and a service built without one has to behave exactly as it does today.
- Whether a local fault deserves *some* record under a different name. "This machine faulted sixteen times in half an hour" is worth surfacing; it is only the "therefore stop using it" consequence that is wrong.

Noticed while reviewing `every-member-votes-for-whichever-racing-write-reached-it-first`, which added the promise-round call site. That change preserved behaviour the previous code already had, so it is evidence, not the cause.
