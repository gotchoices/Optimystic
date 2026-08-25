description: A machine used to answer "how do I reach this third machine?" two different ways depending on which message it was answering, and the weaker answer could describe a reachable machine as having no address at all. Both answers now come from one function, and that function now has its own tests.
prereq:
files: packages/db-p2p/src/peer-address-book.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/service.ts, packages/db-p2p/src/cluster/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/peer-address-book.spec.ts, packages/db-p2p/test/redirect.spec.ts, packages/db-p2p/test/cluster-service-node-resolvers.spec.ts, packages/db-p2p/test/cluster-service-redirect.spec.ts, packages/db-p2p/docs/cluster.md, docs/internals.md
----

# What shipped

One question — "which addresses may we hand a **third** party for peer P?" — now has one answer,
`publishableAddrsForPeer` in `packages/db-p2p/src/peer-address-book.ts`, and one joining rule,
`unionPublishableAddrs`: the publishable half of our live connections first (libp2p has already
succeeded with those), then the peer's own addresses as `identify` left them in the peerStore,
de-duplicated and validated.

Four producers share it: `findCluster` (via the synchronous `unionPublishableAddrs`, because it
already holds both halves from a batched peerStore read), `RepoService.getPeerAddrs`,
`ClusterService.getPeerAddrs`, and the `getConnectionAddrs` hook `libp2p-node-base` injects. The
three redirect resolvers previously read connections alone, so a cohort member reachable only
through a relay that had only ever dialed *us* was described by a cluster record with its circuit
address and by a redirect with no address at all.

Because a peerStore read is asynchronous, `ClusterService.checkRedirect` became `async` and both
`getConnectionAddrs` component hooks became `(peerId) => string[] | Promise<string[]>` — a union, so
an embedder's existing synchronous connections-only stub still compiles and still works.

Separately, the proposal in `fix/1-inbound-relayed-connection-addr-is-never-published` — let an
**inbound** connection's `remoteAddr` be publishable when it is a circuit address — was refuted and
the refutation pinned as an accepted-tradeoff `NOTE:` on `publishableConnectionAddr`, citing
`@libp2p/circuit-relay-v2@4.1.3` (`dist/src/transport/index.js:272` for how the address is composed,
`dist/src/server/index.js:219-222` for the reservation asymmetry that decides it).

# Review findings

## Checked

Read the implement diff (`79acb23`) before the handoff, then read every file it touched and the ones
it should have.

- **The union rule at all four producers.** Each reaches `unionPublishableAddrs` with the connection
  half already filtered by `publishableConnectionAddr`. Ordering, de-duplication, and validation are
  identical at all four.
- **Whether the peerStore half can reintroduce ephemeral source sockets** — the exact bug the
  previous ticket fixed, one layer down. It cannot: `identify` stores a peer's *listen* addresses,
  not the socket it dialed from. This is proven empirically, not by reading libp2p — the real
  two-node test in `cluster-service-node-resolvers.spec.ts` names the listener's inbound
  `remoteAddr` explicitly and asserts the published set does not include it.
- **Validation parity in `findCluster`.** The old code ran the *merged* list through
  `parseMultiaddrs`; `unionPublishableAddrs` validates only the advertised half. No regression:
  `getConnectedAddrsByPeer` already puts every connection address through
  `publishableConnectionAddr` → `isCarriableMultiaddrString`, the same predicate
  `validMultiaddrStrings` uses. Not a finding.
- **The async ripple.** `checkRedirect`'s only production caller is `processOperation`, which
  awaits; all twelve test call sites await. Both hook types are unions, so the two existing
  synchronous spec stubs and any embedder's still work.
- **Race between `learnPeerAddresses` and the new peerStore read.** `processOperation` learns before
  it redirects, and `mergePeerAddresses` deliberately does not await the write — so the read could
  in principle see a half-written store. It cannot matter: `checkRedirect` reads the peerStore only
  for peers whose record entry carried **no** addresses, and those are exactly the entries
  `learnPeerAddresses` skips (`addrs.length === 0 → continue`). The two never touch the same peer.
- **What the recipient does with a longer address list.** `RepoClient`/`ClusterClient` →
  `recordPeerAddresses` → `mergePeerAddresses`, which keeps the first `MAX_MERGED_ADDRS_PER_PEER`
  (8) *in order*. So the doc's connection-first claim is load-bearing rather than stylistic — see
  the test added for it below.
- **That the peerStore arm actually resolves in production, not just in stubs.** `RepoService`'s
  components object is a plain literal with no `libp2p` key (so the throwing libp2p proxy is never
  read), and `setLibp2p(node)` runs before `node.start()` — so `getPeerAddrs` reaches a real
  peerStore from the service's first request.
- **Every other `remoteAddr` producer in the repo.** `routing/libp2p-known-peers.ts` already carries
  a `NOTE:` tripwire from a prior pass; `cohort-topic/stream-util.ts` and
  `Libp2pKeyPeerNetwork.isLimitedConnection` classify connections rather than publish addresses.
- **Docs.** Read the changed sections of `docs/internals.md` and `packages/db-p2p/docs/cluster.md`
  § Access Control against the code. Both describe the new reality accurately, including the async
  consequence and the reason the redirect resolvers were the weaker half.

## Found and fixed in this pass (minor)

- **The two new exported functions had no direct unit tests.** They were covered only through
  `RepoService` and the real-node spec — which is caller-level coverage of a rule whose whole point
  is that it has no single caller. Added eight tests to `test/peer-address-book.spec.ts`, the
  module's own spec: connection-first ordering with the advertised half deliberately listed
  advertised-first, de-duplication across the halves, validation of the advertised half (including
  the empty-string-is-the-root-multiaddr case), the inbound-only peer described by its advertised
  circuit address, the both-halves union, all four peerStore failure shapes (unknown peer that
  throws, store that throws outright, store with no addresses, no store at all) asserting none of
  them is reported as a `WARN:`, and the miss log line.
- **The truncation interaction had no test at all.** The claim "connection-first means the proven
  address survives the recipient's cap" spanned two functions and was asserted nowhere. Added a test
  that unions three dialed addresses with more advertised ones than the cap admits, runs the result
  through `mergePeerAddresses`, and asserts all three dialed addresses survive.
- **`ClusterService`'s own connection-reading fallback never exercised its peerStore arm.** Its spec
  stub supplied only `getConnections`, so the arm silently returned `[]` and passed. This is not
  redundant with `RepoService`'s coverage: the two services reach the node by different routes
  (injected `setLibp2p` vs. the throw-happy components proxy), so what is untested is specifically
  whether the object `ClusterService` hands `publishableAddrsForPeer` carries a peerStore at all.
  Added that case to `test/cluster-service-redirect.spec.ts`.

All new tests neuter-verified two ways, then the neuter reverted (`grep -r NEUTERED packages/db-p2p`
is clean): swapping the union's ordering fails 2 of them; dropping the advertised half fails 7
across three spec files, including the pre-existing `redirect.spec.ts` case.

## Major findings

None filed. Two candidates were weighed and deliberately not filed:

- **Address laundering through our own peerStore.** `learnPeerAddresses` merges addresses from an
  unvalidated inbound record into the peerStore, and a later redirect can now read them back out and
  republish them to a third party under our name. Not filed: `findCluster` has always had the
  identical exposure — a cluster record has always unioned the peerStore — and the site carries an
  accepted-tradeoff rationale (`mergePeerAddresses`, and `docs/internals.md`): a merged multiaddr
  only makes a dial *attempt* possible, the noise handshake still authenticates by peer id, so cost
  is what needs bounding and `MAX_MERGED_ADDRS_PER_PEER` / `MAX_LEARNED_PEERS_PER_RECORD` bound it
  at every hop. This change equalizes an existing exposure rather than widening it. Its stated
  revisit condition has not tripped.
- **No producer-side cap on the published set.** A redirect can now carry as many addresses as the
  peerStore holds, where before it carried at most one per outbound connection. Not filed: cluster
  records have always been uncapped in exactly the same way, the recipient caps at 8 in order, and
  the magnitude is unmeasured — a redirect names `clusterSize` peers, single digits. Capping at the
  producer would also make the ordering rationale redundant in a way the docs do not currently
  describe. If it is ever worth doing it should be done for both producers at once, not for the
  redirect path alone.

## Corrections to the handoff's own gap list

- **"A `getConnectionAddrs` that returns a rejected promise now rejects the redirect"** is not a new
  failure mode. A synchronous hook that *threw* already propagated out of `checkRedirect` into
  `processOperation`'s rejection, identically. An async stub is a new *way* to reach that outcome,
  not a new outcome. No guard added, and none is warranted.
- The handoff called `unionPublishableAddrs` vs. `publishableAddrsForPeer` "a seam a fifth caller
  could pick the wrong side of". The split is justified (`findCluster` must not pay a second
  peerStore read) and the doc comment on `unionPublishableAddrs` already says so at the site. The
  new unit tests now pin the rule itself rather than only its callers, which is the part that was
  actually missing. No `NOTE:` added — a second one would restate the doc comment above it.

## Tripwires

- The implementer's tripwire on `advertisedAddrsForPeer` (one extra `peerStore.get` per redirect
  target, bounded and unmeasured) stands as written; nothing in this review changes its terms.
- Nothing new parked. One asymmetry noticed and judged not worth a note: `findCluster`'s peerStore
  readers (`getPeerStoreAddrsByPeer`, `getPeerStoreRecordsByPeer`) swallow a miss silently while
  `advertisedAddrsForPeer` logs one. `findCluster` has its own, better diagnostic for the same
  condition — the `findCluster:addressless-members` line — so the silence there is covered rather
  than a gap. The three readers do each repeat the one-line `peer.addresses → string[]` expression;
  extracting it would trade one line of duplication for an export plus an import and would not make
  the publishing rule any more single than it already is.

## Validation

| command | result |
| --- | --- |
| `yarn lint` | clean (exit 0) |
| `yarn build` | success |
| `yarn typecheck` | clean |
| `yarn test` (whole monorepo) | **0 failing** — 1387 + 1882 + 54 + 51 + 46 + 45 + 12 + 125 + 474 + 6 + 258 passing, 56 pending |
| `OPTIMYSTIC_INTEGRATION=1 yarn workspace @optimystic/db-p2p test:integration` | 30 passing, 2 pending |

db-p2p is 1882 where the implement run reported 1874 — the eight tests added above.

One transient failure appeared on the first `yarn test` and did not recur: `quereus-plugin-optimystic`
aborted with `error TS2307: Cannot find module '@quereus/quereus'`. That workspace dependency is a
symlink to a sibling checkout (`C:\projects\quereus`) whose `dist/` was being rebuilt at that moment
by concurrent work in that repo — its `dist/src/index.d.ts` timestamp lands between the two runs.
Re-running the package immediately after gave 474 passing, and the full re-run was green. Not a
defect in this repo and not pre-existing breakage, so `tickets/.pre-existing-error.md` was not
written.

# Known gaps carried forward

These were true at implement and remain true — the review confirms them rather than closing them.

- **Nothing here was measured in production.** The change rests on reading the two code paths side
  by side. No captured failure exists showing a redirect arriving with an empty address list for a
  peer a cluster record described with a circuit address.
- **No relay topology in any test.** Both behavioral tests use a direct dial and a stubbed circuit
  address string, so the production scenario in the argument (a peer reachable *only* through a
  relay) is proven by construction. `test/relay-third-party-address-gap.spec.ts` is where a live
  circuit would go.
- **Self-relay-only addresses now reach redirect payloads**, as they already reached cluster records.
  Intended — a sibling reaching the peer through our relay is the working path — but no test names
  that case on the redirect side specifically.
