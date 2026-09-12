description: A test that is meant to prove a write still works when two servers can only reach each other through a middleman currently decides at run time whether to run at all, and skips itself about one run in ten while the suite still reports green. Rebuild it so it always runs, and fails loudly when the thing it exists to check cannot be exercised.
files: packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, packages/db-p2p/test/util/relay-topology.ts, packages/db-p2p/test/util/peer-store-wait.ts, packages/db-p2p/test/foreign-peer-interop.integration.spec.ts (reference: how a non-Optimystic peer is assembled), packages/db-p2p/src/libp2p-key-network.ts (read-only reference: `findCluster` membership scoping)
difficulty: medium
----

# Make the relay-crossing write spec run every time

## The problem, restated with what was measured

`multi-coordinator-write-relay.integration.spec.ts` is the only test that exercises a write whose second inter-coordinator promise crosses a circuit relay. Before asserting anything it searches 24 candidate block ids for one whose cohort (as node A computes it) contains the relay-only coordinator B, and calls `this.skip()` when none does. A skipped run and a passing run are indistinguishable in the suite summary, so the capability can break without the gate going red.

Measured locally on this tree (Windows, loopback), running the one spec file repeatedly:

```
cd packages/db-p2p
OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/multi-coordinator-write-relay.integration.spec.ts" --reporter min
```

**3 self-skips in 45 consecutive runs (~7%)**, on an unchanged tree. The rate moves with how much logging is enabled (debug output slows the run and lets convergence finish), which is exactly why it reads as random.

## Root cause — the relay competes for the one non-self cohort slot

Both coordinators run with `clusterSize: 2`. In `findCluster` (`packages/db-p2p/src/libp2p-key-network.ts`) the membership-scoped path reserves one slot for self and keeps `clusterSize - 1` — that is, exactly **one** — non-self peer: the first peer FRET's cohort walk returns for that key which is confirmed to serve this network. The relay is spawned by `spawnRelayNode`, i.e. a full Optimystic node on the *same* network name, so it serves `/optimystic/<net>/{cluster,repo}/1.0.0` and is a legitimate candidate for that single slot. A and the relay and B are three peers competing for two seats, one of which is always A's.

A skipping run was captured with `DEBUG='optimystic:db-p2p:libp2p-key-network*' OPTIMYSTIC_VERBOSE=1`. All 24 probes produced the **same** cohort, `[A, relay]`, and every one logged:

```
findCluster:membership key=… serves=2 unknown=0 foreignDropped=0 kept=2
findCluster key=… fretCohort=3 connected=2
```

So B was not late, not unidentified, and not off the ring — `serves=2` says A had both B and the relay fully classified as serving peers, and `fretCohort=3` says all three were live ring members. B simply lost the one slot to the relay for all 24 keys.

That is not 24 independent coin flips. Which of the two wins a given key is decided by the walk outward from that key's coordinate, so the *share of the keyspace* that resolves to B rather than to the relay is a property of the run's random peer-id layout, fixed for the whole run. When B's share of the keyspace happens to be small, all 24 probes miss together and the spec skips; in a passing run captured earlier the loop needed 10 probes before a key favoured B. Probing more ids lowers the skip rate and never removes it — which is why the ticket rules out widening the search, and why the previous precondition (a single fixed probe) failed the same way before it was replaced by this loop.

## The design: take the relay out of the keyspace, then assert instead of skip

Three changes, the first of which does the real work.

**1. The relay stops being an Optimystic keyspace participant.** The relay in this topology exists to carry circuits — nothing in what the spec asserts needs it to be a storage node. Replace it with a hand-assembled libp2p node that speaks identify and circuit-relay-v2 and nothing else. It advertises no `/optimystic/<net>/cluster/1.0.0` and no `/optimystic/<net>/repo/1.0.0`, so `membershipOf` classifies it `foreign` and it can never occupy the non-self cohort slot; FRET's own classification probe likewise never admits it as a ring member. A and B are then the only serving peers on the network, the single non-self slot can only be B, and **every** key's cohort is exactly `{A, B}` regardless of the peer-id layout. The lottery is gone — not made rarer.

Give the hand-built relay the **network-scoped identify prefix** (`optimystic/<network>`, slash-less, as `@libp2p/identify` wants it — see `packages/db-p2p/test/foreign-peer-interop.integration.spec.ts`). This matters: a relay whose identify never negotiates would *also* be excluded from the cohort, but as `unknown` rather than `foreign`, and the spec would then be passing for a reason nobody chose. The spec asserts the intended reason (below).

**2. The search loop is deleted.** One fixed block id, named as a constant.

**3. The precondition polls the real predicate and fails red.** Replace both the FRET `exportTable` convergence wait and the search loop with a single `waitFor` on the condition that actually matters: A's `findCluster` for the fixture block id returns a cohort containing B. It waits out connection/identify/FRET-classification settling, and if that never happens it throws with a message naming what never became true. No `this.skip()` survives anywhere in the file below the `OPTIMYSTIC_INTEGRATION` gate in `before`.

This design was prototyped during planning as a throwaway spec (since deleted) and run 20 times: **20 passes, 0 failures, 0 pendings**, with a single fixed block id and the cohort asserted to be exactly `{A, B}` on every run.

### Helper interface

Add to `packages/db-p2p/test/util/relay-topology.ts`, alongside the existing `spawnRelayNode` (which stays — `circuit-relay-long-lived.spec.ts`, `dcutr-direct-upgrade.spec.ts` and `relay-address-propagation.spec.ts` still use it):

```ts
/**
 * A relay that carries circuits but is NOT a participant in the Optimystic keyspace: plain
 * libp2p, identify under this network's prefix, circuit-relay-v2 server, and no cluster/repo
 * protocols. Use it when a spec asserts on cohort membership — an Optimystic relay
 * (`spawnRelayNode`) is a serving peer and competes for cohort slots with the peers under test.
 */
export async function spawnPlainRelayNode(network: string, opts?: { host?: string }): Promise<Libp2p>
```

Shape (validated):

```ts
await createLibp2p({
    addresses: { listen: [`/ip4/${host}/tcp/0/ws`] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
        identify: identify({ protocolPrefix: `optimystic/${network}` }),
        relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } })
    }
}) as unknown as Libp2p;
```

`applyDefaultLimit: false` preserves what `spawnRelayNode({ applyDefaultLimit: false })` gives the spec today — without it the relay caps each circuit at 128 KiB / 2 min. `pickRelayWsAddr` and `waitForCircuitListen` both work against this node unchanged.

### Spec shape after the change

```
relay = spawnPlainRelayNode(NETWORK_NAME)
a, b  = spawnBrowserShapedCoordinator(relayWs)          // unchanged
waitForCircuitListen(a), waitForCircuitListen(b)        // unchanged
dial both ways through the relay, wait for connection   // unchanged
waitFor(cohortOfA(BLOCK_ID).includes(bId))              // replaces the FRET wait AND the search loop
assert cohortOfA(BLOCK_ID) === exactly {A, B}
assert A's view of the relay: identified, and serving neither cluster nor repo
assert every A→B connection is relayed (limited)
pend + commit, assert both succeed                      // unchanged
```

## Edge cases & interactions

- **Vacuous self-only cohort.** `clusterPolicy.allowDownsize: true` means a cohort of just `{A}` completes a write happily. That is the failure the original `this.skip()` was avoiding, and deleting the skip must not reintroduce it: assert the cohort is **exactly** `{A, B}` (set equality, not `includes`) immediately before the pend.
- **Excluded for the wrong reason.** A relay whose identify silently failed to negotiate is classified `unknown` and is *also* kept out of the cohort — the spec would pass while testing something nobody designed. Assert on A's peerStore view of the relay (`waitForPeerStoreProtocols` in `packages/db-p2p/test/util/peer-store-wait.ts`): the protocol list must be non-empty and contain the network's identify id, and must contain neither `/optimystic/<net>/cluster/1.0.0` nor `/optimystic/<net>/repo/1.0.0`.
- **The A↔B path silently going direct.** The spec's whole point is a promise over a limited connection. Loopback plus WS+circuit-only transports prevents a DCUtR upgrade today, but assert rather than assume: before the pend, every connection A holds to B must be relayed (`c.limits != null || c.remoteAddr` contains `/p2p-circuit` — the same rule as `isLimitedConnection` in `packages/db-p2p/src/network/open-protocol-stream.ts`).
- **Convergence genuinely failing.** If B never becomes an admissible cohort member, the cohort poll must time out red with a description naming the condition — never skip, never fall through to a weaker assertion. Give it a generous budget (60 s was used in the prototype) and raise `this.timeout` if the sum of waits approaches it.
- **Reservation never granted.** `waitForCircuitListen` already throws with the node's current multiaddrs; keep that path.
- **Teardown.** The relay is now a plain `Libp2p` with no Optimystic services; it still belongs in the existing `afterEach` `Promise.allSettled([...].map(n => n.stop()))`, and the relay must still be stopped last-or-together so circuits do not strand the coordinators' stop paths.
- **The other consumers of `relay-topology.ts`.** `spawnRelayNode` keeps its behaviour and its callers; the new helper is additive. Update that module's header comment, which currently enumerates the specs it serves. A separate backlog ticket (`dcutr-holepunch-nat-attribution-harness`) also plans work in this file — additive helper, no conflict expected.
- **Regression guard by comment.** The next reader must not "simplify" the new helper back to `spawnRelayNode`. Put one sentence at the call site saying that an Optimystic relay is a serving peer and would restore the cohort lottery this ticket removed.
- **Two pending counts, only one of them a symptom.** Under the plain `test` script this spec is pending because of the `OPTIMYSTIC_INTEGRATION` gate in `before` — constant, and not the bug. The symptom is a pending count that *varies* between runs of `test:integration` on an unchanged tree; after this change that count must be 0 for this suite on every run.
- **Typed node surface.** The file currently reads `(a as any).keyNetwork` / `(a as any).coordinatedRepo`. `createLibp2pNode` already returns `OptimysticNode` (`packages/db-p2p/src/optimystic-node.ts`), so type the coordinator spawner's return as `OptimysticNode` and drop those casts in this file while rewriting it. Keep the existing `commit({...} as any)` request cast — the wider conversion is `debt-node-attachment-reads-bypass-typed-surface` and is not this ticket's job.
- **Build/typecheck.** `tsc` compiles `test/` into `dist/test`, so the new helper must typecheck (`yarn workspace @optimystic/db-p2p typecheck`), not merely run under Node's type stripping.
- **Shell.** The package's `test:integration` script uses a POSIX leading env assignment. Run it from the Bash tool, or in PowerShell set `$env:OPTIMYSTIC_INTEGRATION=1` before the mocha command.

## Verification this ticket owes

Run the single spec **20 times** and report the tally (passes / failures / pendings) in the review handoff. Anything other than 20 passes / 0 pendings means the design did not land:

```
cd packages/db-p2p
for i in $(seq 1 20); do OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/multi-coordinator-write-relay.integration.spec.ts" --reporter min; done
```

Then the wider gates: `yarn workspace @optimystic/db-p2p typecheck`, the package's unit suite, and `yarn workspace @optimystic/db-p2p test:integration` once end-to-end so the sibling relay specs are seen to still pass with the new helper in the module.

## TODO

- Add `spawnPlainRelayNode` to `packages/db-p2p/test/util/relay-topology.ts` with the doc comment above; update the module header comment's list of consumers.
- Rewrite `multi-coordinator-write-relay.integration.spec.ts`: plain relay, one fixed block-id constant, no search loop, no `this.skip()` below the `before` gate.
- Replace the FRET `exportTable` wait and the search loop with the single cohort `waitFor`; keep the connection wait and the circuit-listen waits.
- Add the four assertions: exact cohort `{A, B}`; relay identified but serving neither cluster nor repo; every A→B connection relayed; pend and commit succeed.
- Rewrite the file's header comment: it currently explains the removed bimodal precondition and the search loop that replaced it. State instead why the relay must not be an Optimystic node, and that both earlier preconditions failed because the relay competed for the single non-self cohort slot.
- Type the coordinator spawner as `OptimysticNode` and drop the `(x as any).keyNetwork` / `.coordinatedRepo` casts in this file.
- Run the 20× loop, the typecheck, the unit suite and the full integration suite; report the tallies honestly in the review handoff, including anything left undone.
