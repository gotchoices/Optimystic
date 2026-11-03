description: A node gives up on a peer after a fixed multiple of the declared link speed, so on a phone link whose send queue grows with traffic it abandons requests whose answers are only queued, and each one re-sent makes the queue longer. Let each such time limit also stretch to the response time actually measured from that peer, as TCP sizes its retransmit timer.
files: packages/db-p2p/src/rpc-deadline.ts (`resolveLinkDeadlines`, `withinRequestBudget`, `withRpcDeadlineDefaults`), packages/db-p2p/src/protocol-client.ts (`processMessage`), packages/db-p2p/src/cluster/client.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/libp2p-node-base.ts (`cohortQueryTimeoutMs` consult sites, `NodeOptions.linkRoundTripMs`), packages/db-p2p/src/cluster/cluster-policy.ts (`reconcilePassTimeoutMs`), packages/db-p2p/docs/cluster.md
tradeoffs: Stretched limits make a peer that has really stopped answering cost longer to give up on, and a per-peer estimator adds state to every request path, while the option is only known to be needed on one test harness's phone-shaped link; a deployment can already declare a larger link, though that raises every limit for every peer all the time.
----
# Link deadlines stretch to measured response time

Proposed by Sereus, whose maintainer accepted the principle on 2026-11-03 for its own architecture (gotchoices/sereus#48). Optimystic owns two of the deadlines that fired, so Optimystic designs its own estimator. p2p-fret owns the third and needs its own ticket. The full evidence and the alternatives Sereus rejected are in `../sereus/tickets/blocked/decide-link-deadlines-from-measured-response-time.md`.

## The rule

A deadline over an open connection to a peer is the larger of its count of declared round trips and the same count of that peer's measured response time.

- Measured response time is a smoothed average plus four times its smoothed variation (RFC 6298).
- Each answered request updates it. An answer to a request that was sent more than once does not, since it cannot be matched to one attempt.
- The declared value is the floor and the starting estimate, so a peer not yet heard from is waited on exactly as today.
- A ceiling bounds the stretch, so a peer that stopped answering is still given up on. RFC 6298 allows a ceiling no lower than 60 s.
- A deadline that opens a connection stays declared: before the connection exists there is no response from that peer to measure.
- It is an option. Absent the option, behaviour stays as it is today.

## Why

The declaration is fixed and a send queue is not. Where a link's cost is per frame, the queue grows with traffic, so a deadline counted in declared round trips gives up on requests whose answers are only queued, and each re-send lengthens the queue that made it late.

Sereus measured this in the phone arm of its workload scenario, where each outbound WebSocket frame is held 20 ms behind the one before it and the event loop is 70% busy (two-member group, Optimystic 1.15.0, 2026-10-17):

- One clean round puts 472-476 frames on the busiest socket, which is 9.5 s at that rate, against the 7 s a cohort peer gets to answer a read.
- All 53 read-repair consults sent during the rounds found the other member silent at 7 s, and so did all 224 in the 180 s after.
- The writes of rounds 1-3 failed, the other five rounds each committed alone, and the two sides ended holding different rows that did not converge in 180 s.

On Optimystic 1.20.1, one joiner's seat transaction sent the other member 26 cluster requests and abandoned all of them to the 10.5 s response deadline. Later runs vary: on 1.19.0 the reporter's two runs on a quiet machine completed all 8 rounds and converged, but still recorded 106 consults that gave up on a peer that was up. A run on a loaded machine failed every round.

## Which deadlines

In scope, the two that fired:

- `cohortQueryTimeoutMs`, the per-peer budget of a cohort read, run through `withinRequestBudget`.
- `responseTimeoutMs`, the wait for a reply once a stream is open, applied by `ProtocolClient.processMessage`.

Out of scope: every deadline that opens a connection (`dialTimeoutMs` and libp2p's connection limits), the cohort-topic reply reads (`feat-cohort-topic-reply-reads-follow-the-declared-link`, which is about following the declaration at all), and FRET's maintenance ping.

## Questions the plan must settle

Sereus's text states the rule, not a mechanism. Reading the code raised these, none of them measured:

- **An estimate fed only by answered requests may never rise.** `ProtocolClient.exchange` aborts the stream when the deadline fires, so an answer arriving after it is never seen, and an abandoned request gives no sample. If every request to a peer is abandoned, as in the measurement above, the estimate stays at the declared floor and nothing stretches. RFC 6298 covers this case by doubling its timer on each expiry, which the rule as written leaves out; retry backoff (`LinkDeadlines.retryBackoffBaseMs`) spaces the re-sends but does not lengthen the deadline. Candidates: back the estimate off on expiry, or feed it from whatever is answered on any protocol to that peer, including small requests that clear the queue sooner. Confirm with the phone arm which of these is enough.
- **Where a sample starts.** It should start when the request is issued, so that it includes the wait to open a stream behind the queue. `processMessage` already takes `t0` ahead of opening the stream, while the response deadline starts only once the stream is open. A request that takes the re-send path in `processMessage` is one that was sent twice and gives no sample.
- **A whole-request budget that may include a dial.** `withinRequestBudget` covers dial, negotiation, request and reply under one budget, and the rule says a deadline that opens a connection stays declared. Decide what a consult gets when no connection is open.
- **Which count, when a host set the value itself.** Optimystic derives the cohort query budget at three round trips, but Sereus declares `clusterPolicy.cohortQueryTimeoutMs` as two. `rpcDeadlines` is documented as used exactly as given, with no floor. Decide whether an explicit value is a floor that stretches, and how many measured round trips stretch it. Sereus expects its value to become the floor Optimystic stretches above.
- **Budgets above the stretched deadlines.** `reconcilePassTimeoutMs` is derived from the cohort query budget, and `transactionTimeoutMs` and a transaction's expiration bound the rounds beneath them. A stretched per-peer wait can outlast a fixed outer budget, which then fails the operation at the same time it failed before. Decide which of them follow the stretch.
- **What the sample measures.** Response time includes the peer's own work, such as a consensus handler running its storage writes, as well as the queue. Decide whether one estimate per peer serves every protocol, given the small sync consult and the block-carrying requests differ in size.
- **Where the state lives.** `LinkDeadlines` is resolved once per node and the clients take fixed values, so a per-peer value needs a new seam that is reachable from every `ProtocolClient` subclass. It must be bounded in size, since peer ids come off the wire (the bound in `PeerReputationService` is the precedent), and must run on React Native.

## Expected

With the option on, in `../sereus/packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts`'s phone arm (`STRAND_WORKLOAD_PHONE=1`), the `cohort silent` count falls towards zero while both members are up, no round commits alone, and the arm converges. One run takes about an hour, so that confirmation is out of band. With the option off, every deadline is what `resolveLinkDeadlines` gives today.
