description: A test that was silently skipping itself about one run in ten — while the suite still reported green — now runs every time and fails loudly if the thing it exists to check cannot be exercised. Ready for a code-review pass.
files: packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, packages/db-p2p/test/util/relay-topology.ts
difficulty: medium
----

# Review: the relay-crossing write spec now runs every time

## What changed

Two files, both under `test/`. No production code was touched.

**`packages/db-p2p/test/util/relay-topology.ts`** — added `spawnPlainRelayNode(network, { host? }): Promise<Libp2p>`. It hand-assembles a bare libp2p node (webSockets + noise + yamux) with exactly two services: `identify` under the network-scoped slash-less prefix `optimystic/<network>`, and `circuitRelayServer({ reservations: { applyDefaultLimit: false } })`. It advertises no `/optimystic/<net>/cluster/1.0.0` and no `/optimystic/<net>/repo/1.0.0`. The existing `spawnRelayNode` is unchanged and all seven of its callers are untouched; this helper is purely additive. The module header comment was rewritten — its old list of three consumer specs was stale (there are eight), and it now flags that one helper deliberately does not build an Optimystic node.

**`packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts`** — rewritten. The relay is now the plain node; the 24-candidate keyspace search loop and the `this.skip()` that followed it are gone; the FRET `exportTable` convergence wait is gone. One fixed block id (`BLOCK_ID = 'mcw-relay-block'`). The only `skip` left in the file is the `OPTIMYSTIC_INTEGRATION` gate in `before`. The coordinator spawner returns `OptimysticNode`, so `(a as any).keyNetwork` and `(a as any).coordinatedRepo` are gone; the `commit({...} as any)` request cast stays, as the ticket directed.

## Why this removes the skip rather than making it rarer

`findCluster` reserves one cohort slot for self and keeps `clusterSize - 1` others — at the `clusterSize: 2` this spec uses, exactly one non-self slot — and admits only peers it has positively classified as serving this network. An Optimystic relay advertises this network's cluster/repo protocols, so it classified as `serves` and competed with coordinator B for that one slot. Which of the two won a given key is fixed by the run's random peer-id layout, so all 24 probes missed together on an unlucky layout.

The plain relay advertises neither protocol, so `membershipOf` classifies it `foreign` and it is dropped from every cohort on every layout. A and B are then the only serving peers and the single non-self slot can only be B — for every key. The precondition is now a `waitFor` on that exact predicate (A's cohort for `BLOCK_ID` contains B), which throws naming the condition instead of skipping.

## Verification actually run (all on this tree, Windows, loopback)

| gate | command | result |
|---|---|---|
| the 20× loop the ticket owed | `for i in $(seq 1 20); do OPTIMYSTIC_INTEGRATION=1 node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/multi-coordinator-write-relay.integration.spec.ts" --reporter min; done` from `packages/db-p2p` | **20 passing / 0 failing / 0 pending.** Per-run wall clock 318 ms – 1 s. |
| typecheck | `yarn workspace @optimystic/db-p2p typecheck` | exit 0 |
| lint | `npx eslint` on both changed files | exit 0 |
| unit suite | `yarn workspace @optimystic/db-p2p test` | 2705 passing, 50 pending, 0 failing |
| full integration suite | `yarn workspace @optimystic/db-p2p test:integration` | 31 passing, **2 pending**, 0 failing — the relay spec ran and passed in 212 ms |

The 2 pendings in the integration run are both pre-existing static `it.skip`s in the cohort-topic substrate suite, unrelated to this ticket: the `[unimplemented:real-tier — tracked by reactivity-rotation-host-wiring-e2e §D]` rotated-recover case and the `[covered at cohort-admission + replication level here]` participant-register walk. The relay spec contributes zero pendings — which is the symptom this ticket existed to remove.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Negative controls — proof the assertions are live, not vacuous

Both were run by temporarily editing the tree and then restoring it from a scratchpad copy; the working tree now holds only the two intended file changes (`git status --short` shows exactly those two, and neither control edit survives).

**Control A — put an Optimystic relay back in the keyspace** (`spawnRelayNode as spawnPlainRelayNode`), 8 runs: **0 passing / 8 failing.** Six failed on `the relay must not serve this network's cluster protocol`. Two failed on `waitFor timed out after 60000ms: A's cohort for 'mcw-relay-block' includes the relay-only coordinator B` — those two are the unlucky layouts, i.e. exactly the runs the old spec would have silently skipped, now red. This is the single most useful thing a reviewer can re-run.

**Control B — drop `identify` from the plain relay**, 1 run: failed with `A never saw the relay's identify protocol /optimystic/multi-coord-write-relay-it/id/1.0.0; its peerStore holds: ["/ipfs/ping/1.0.0","/libp2p/circuit/relay/0.2.0/hop","/libp2p/circuit/relay/0.2.0/stop"]`. So the "excluded as `foreign`, not as `unknown`" assertion genuinely distinguishes the two exclusion reasons; the spec is not passing for a reason nobody chose.

## The four assertions, and what each is guarding

- **Cohort is exactly `{A, B}`** — set equality via sorted `deep.equal`, not `includes`. `allowDownsize: true` lets a self-only cohort complete a write happily, so a weaker check would pass while asserting nothing about a second promise crossing anything. Proven live by control A.
- **A's peerStore view of the relay**: identify id present, cluster and repo ids absent. Proven live by controls A and B respectively.
- **Every A→B connection is relayed** — `c.limits != null || remoteAddr.includes('/p2p-circuit')`, the same rule as `isLimitedConnection` in `src/network/open-protocol-stream.ts`, plus a `length > 0` guard so `every` cannot pass vacuously. Not independently proven by a control; loopback + WS/circuit-only transports means no DCUtR upgrade is available to break it here.
- **pend and commit both succeed** — unchanged from before.

## What a reviewer should push on

- **The cohort predicate is evaluated twice** — once by the final `waitFor` iteration, once for the exact-set assertion. Between them a peer could in principle drop, turning the cohort self-only and failing the set assertion. With the relay `foreign` the only possible members are A and B, and B stays connected, so this never fired in 20 runs plus the full suite. Judge whether it is worth capturing the polled value instead; I left it as the simpler read.
- **The "every A→B connection is relayed" assertion has no negative control.** Constructing one means enabling a direct transport between A and B, which changes the topology the rest of the spec depends on. I judged that out of scope; it is the weakest-evidenced of the four.
- **The relay's `applyDefaultLimit: false` is hard-coded**, unlike `spawnRelayNode` where it is an option. Nothing needs the capped variant of a plain relay today. Trivially parameterizable if a reviewer prefers symmetry.
- **Teardown ordering.** `afterEach` still stops all three together via `Promise.allSettled`, as before. The relay is now a plain `Libp2p` with no Optimystic services, so its `stop()` is cheaper; no stranding was observed across ~30 runs.
- **Wall clock dropped from multi-second to ~0.4 s.** That is the removed 40 s FRET `exportTable` wait and the removed 24-probe loop, both of which were doing work the single cohort poll subsumes. Worth a sanity glance that nothing meaningful was removed along with them — the cohort poll is strictly stronger than the FRET wait it replaced (a peer on the ring but unidentified satisfies the old wait and fails the new one).

## Not done

- **`yarn check` at repo root was not run** (lint + lint:docs + build + typecheck + test + test:integration across all workspaces). The changes are test-only and confined to `packages/db-p2p/test/`, and the four gates above cover that package end to end; the full root gate's wall clock puts it outside what an agent run should hold open. A human or CI should run it before release if that is the normal bar.
- No production code was inspected for the underlying relayed-promise behaviour — this ticket was about the test's honesty, not about the write path it exercises.

## Tripwire parked

- A genuinely-failing cohort precondition burns the full 60 s before going red (measured in control A: 60 s red vs ~0.4 s green). Recorded as a `NOTE:` on `COHORT_TIMEOUT_MS` in the spec, with the condition for revisiting — if this wait ever starts failing routinely and suite wall clock matters, shorten it.

## Artifact

`tickets/.logs/1-debt-relay-cohort-spec-skips-itself-on-unlucky-layout.integration.log` holds the full integration-suite output referenced above. It is in the auto-pruned log directory; nothing else was written to the tree.
