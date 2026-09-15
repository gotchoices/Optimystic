description: Nothing tests the path every real user takes: one phone writes data alone, restarts, then adds a second machine as a backup, loses one of the two for a while, and restarts both. Write that end-to-end test over real network connections, so a release cannot ship with any step of it broken.
prereq:
files:
  - packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts (new)
  - packages/db-p2p/test/two-node-convergence.integration.spec.ts (pattern: two real nodes, `transactorFor`, a Tree collection over `NetworkTransactor`)
  - packages/db-p2p/test/real-libp2p.integration.spec.ts ("cold-restart over real transport with shared storage" — the restart-over-durable-storage pattern; `generateKeyPair` for a stable identity)
  - packages/db-p2p/test/util/multiaddrs.ts (`pickLocalTcpMultiaddr`)
  - packages/db-p2p/src/storage/memory-storage.ts (`MemoryRawStorage`, shared across a node's restarts)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (the `grown` arm that pushes a solo-written block to a newly co-responsible peer; throttled scans)
  - packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts (the in-process version of the join-and-replicate step)
  - docs/optimystic.md (§ Deployment Sizes — the recommended two-machine configuration this spec must use)
  - docs/architecture.md (§ Supported deployment sizes)
difficulty: medium
----

# Why

Release goal (2026-09-14): every core low-node-count scenario works. An inventory of the test suite found the pieces of the ordinary growth path covered only separately, mostly in-process: solo writes and solo restart over real sockets, two-node convergence with both nodes present from the start, and cohort growth with streams stubbed in-process. No single test runs the sequence a real user goes through, over real sockets, with the configuration the docs recommend. Several past defects in this repository (acknowledged writes that landed nowhere, founder blocks never replicated, a solo node that never settled read repair) lived exactly at the joins between those steps.

# The scenario

One spec file with one `describe` whose `it` blocks run in order against shared state (or one long `it` with labelled phases, if ordering between `it`s is fragile here; say which you chose and why). Two real libp2p nodes over loopback TCP, each with its own stable private key and its own `MemoryRawStorage` that survives that node's restarts. A Tree collection written through `NetworkTransactor`, as in `two-node-convergence.integration.spec.ts`.

Configuration: the one `docs/optimystic.md` § Deployment Sizes recommends for two machines, meaning default `clusterSize` and `clusterPolicy: { repairCorroborationClusterSize: 2 }`. Do **not** use the `clusterSize: 2` shortcut the existing two-node specs use; the point is to test what an application following the docs actually runs. A is given the declaration from its first start, as a host that already knows a backup is coming would; note in the handoff whether A started undeclared would behave differently (one run is enough to say so, it does not need its own test).

Phases and the property each one asserts:

1. **Solo.** A starts with no peers and no bootstrap. Write several rows. Read them back on A.
2. **Solo restart.** Stop A; start it again with the same key and storage. All rows readable; a new write succeeds.
3. **Add a backup.** B starts, bootstrapped to A. Wait (bounded) until B holds A's solo-written blocks **locally**. Prove locality the only honest way: stop A, then read every row on B. A copy B merely fetches through A on demand does not count as a backup. If the cohort-growth push is throttled beyond a reasonable test budget, use whatever construction option shortens the scan interval, and if none exists say so in the handoff rather than adding a production option just for the test.
4. **Both write.** Restart A. Each node writes rows; each reads the other's rows.
5. **One away.** Stop B. Write on A. Record whether the write is acknowledged or refused, with the error if refused. Restart B. The invariant asserted: **every write that was acknowledged at any point is readable on both nodes once both are up**, and B's own pre-stop rows survived its restart. Whether a lone survivor of a two-machine group should accept writes is under design (`tickets/backlog/more-design/6.5-partition-healing.md`); this spec pins durability of what was acknowledged, not the admission policy. Put the observed behaviour in the review handoff.
6. **Both restart.** Stop both; start both over their storage. Every acknowledged row readable on each node. One more write from each succeeds and is readable on the other.

Gate on `OPTIMYSTIC_INTEGRATION=1` like the sibling specs so it runs in `yarn test:integration` and therefore in `yarn check`. Keep total runtime near two minutes; state the measured time in the handoff.

# Edge cases & interactions

- **A failure here is a finding, not a flaky test.** If any phase fails, do not loosen the assertion, add retries beyond the bounded waits, or `skip`. Reduce it to the smallest failing phase, keep the spec asserting the correct behaviour, and file a `fix/` ticket naming the phase and the log evidence. If a documented behaviour is actually wrong in the docs rather than the code, say which and fix the doc. The spec may land failing only if the fix ticket exists and the handoff says so prominently, because a release gate must not go silently green on a broken scenario.
- **No layout-dependent self-skips.** `debt-a-test-can-quietly-decide-not-to-run` exists because a relay spec used to `this.skip()` on an unlucky peer-id layout. With two storage nodes and default `clusterSize`, both are in every cohort, so no layout question arises; do not add a precondition that can skip.
- **Bounded waits, and name what timed out.** Use `waitFor` with a message saying which property never became true, so a failure in phase 3 reads as "B never held block X locally" rather than a bare timeout.
- **Port reuse on restart.** Restarting a node on the same TCP port can race the OS releasing it. Either pick a fresh port per start and re-dial by peer id from the peer store (the "re-dials a peer by peer id alone" case in `real-libp2p.integration.spec.ts` shows it works), or show the same-port path is reliable across repeated runs.
- **Freshness caches after restart.** A restarted node's read-repair window and responsibility caches reset (docs § Deployment Sizes, "Applying a new count"). The first read of each block after a restart may consult the other node. That is expected; do not assert it is absent.
- **Teardown.** Every node stopped in `after`, including on a mid-phase failure, so a failing run does not leak sockets into the next spec file.
- **Repeat before handing off.** Run the spec at least five times in a row, and report pass count. One green run of a real-socket spec proves little.

# TODO

- Write `small-deployment-lifecycle.integration.spec.ts` with the six phases above, using the recommended two-machine configuration.
- Run it five or more times with `OPTIMYSTIC_INTEGRATION=1` (`yarn workspace @optimystic/db-p2p test:integration -- --grep "<describe name>"` or the mocha equivalent); record pass count and runtime.
- File `fix/` tickets for any phase that fails, as described above.
- `yarn build && yarn test` for db-p2p; `yarn lint`.
- Review handoff: observed phase-5 behaviour (acknowledged or refused), measured runtime, repeat-run results, any fix tickets filed.
