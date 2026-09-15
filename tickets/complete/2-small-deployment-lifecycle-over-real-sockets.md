description: A new end-to-end test drives the ordinary growth path of a small deployment over real network connections: one machine writes alone and restarts, a second joins as its backup, one is away for a while, and both restart. It also fixed a timer leak that kept stopped nodes' processes alive, and it recorded that a write made while one of two machines is away is sometimes accepted and sometimes refused, depending on timing.
files:
  - packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts (new)
  - packages/db-p2p/src/cluster/block-transfer.ts (`withTimeout` clears its timer)
  - packages/db-p2p/test/block-transfer.spec.ts (review: test pinning the timer clearing)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`NOTE:` tripwire in `handleTopologyChange`)
  - docs/architecture.md (§ Supported deployment sizes: pointer to the spec)
  - tickets/backlog/more-design/6.5-partition-healing.md (arm: what phase 5 observed)
  - tickets/backlog/debt-node-factory-wiring-steps-own-their-teardown.md (update: which half the spec covers)
  - tickets/plan/6.4-commit-result-carries-durability-class.md (review: evidence arm from phase 5)
----

# What landed

`packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts` runs two real libp2p nodes over loopback TCP. Each has a stable Ed25519 key and a `MemoryRawStorage` that survive restarts. The nodes use the documented two-machine configuration: default cluster size plus `clusterPolicy: { repairCorroborationClusterSize: 2 }`. The spec is gated on `OPTIMYSTIC_INTEGRATION=1`, so it runs in `yarn test:integration` and `yarn check`. It has six phases, each its own `it` over shared state. A phase whose predecessor failed throws at once, naming that phase, instead of running on broken state.

1. **Solo.** A writes alone and reads its rows back.
2. **Solo restart.** A restarts over its storage, reads every row, and writes again.
3. **Add a backup.** B joins. The spec waits until B's own storage holds every block A committed, at A's revision or later. Then A stops and B serves every row.
4. **Both write.** Each node writes, and each reads the other's rows.
5. **One away.** B stops and A writes. The spec records, without asserting, whether that write was acknowledged or refused. B returns, and every acknowledged row must read on both nodes.
6. **Both restart.** Every acknowledged row reads on each node, and a new write from each reads on the other.

`BlockTransferCoordinator.withTimeout` used to leave its 30-second race timer running after every pull, push and confirm. Those timers kept a stopped node's process alive 12–32s after mocha finished. It now clears the timer when the race settles, the same idiom as `withDeadline` in `coordinator-repo.ts`.

Phase 5's outcome is a timing race. A write is accepted and held by the survivor alone if A's routing view has already dropped B; otherwise it is refused as `1/2 approvals`. The implementer saw 11 acknowledged and 5 refused across 16 runs, and this review's run was acknowledged after 14.2s. The design question is parked on `backlog/more-design/6.5-partition-healing`.

# Review findings

**Diff read first.** I read the implement commit (`bd262de3`) in full: the spec, the timer fix, the monitor `NOTE:`, the docs paragraph, and both backlog ticket updates.

**Correctness of the spec, fixed inline (minor):**
- `committedBlocks` pulled `machine.storage.listBlockIds` into a local and called it unbound. That only worked because `KvRawStorage` assigns the method as an arrow property. `IRawStorage` declares it with method syntax, so a storage class that implements it as a real method would throw on `this`. It is now called on the storage object.
- Removed redundant non-null assertions (`whileAway!`) on a non-nullable `const`.

**Timer-leak fix, verified and pinned:**
- The fix is correct on both paths. When the transfer settles first, `.finally` clears the timer. When the transfer rejects, the rejection propagates and the timer is still cleared. When the timeout wins, clearing an already-fired timer is harmless.
- Implement added no test for it; review added one in `block-transfer.spec.ts` ("clears the timeout timer once a transfer settles"). The test wraps the global `setTimeout`/`clearTimeout`, runs a fast push, and asserts that every transfer-timeout timer it armed was cleared. **Mutation-checked:** with the `clearTimeout` call disabled, the test fails; with the fix restored, it passes (41 passing).
- **Checked for the same class elsewhere.** Every other `Promise.race`-with-timer in `packages/*/src` already clears its timer: `withDeadline` (`repo/coordinator-repo.ts`), `withReconcileTimeout` (`cluster/cluster-repo.ts`), and `decide` (`inbound-authorization.ts`). No other instance exists.
- **Considered and not filed:** merge those four near-duplicate helpers into one shared helper. They differ on purpose: two reject, one resolves `undefined`, one resolves a sentinel, and one `unref`s. Every instance is correct today, so a shared helper would be tidier but retires no live defect.

**Tripwire in `rebalance-monitor.ts`, checked against the code.** The `NOTE:` claims nothing re-checks a not-yet-admitted joiner. The code bears that out. The growth re-check timer only arms while `hasOutstandingGrowthWork()`, which needs pending peers or budget-deferred blocks, and a peer FRET has not admitted produces neither. A later connection event within `minRebalanceIntervalMs` (default 60s) is throttled. The note is accurate and names its revisit condition, so I kept it. Its home is correct: the relay sibling `implement/2.5-two-phones-over-a-relay-transact-and-replicate` lists this spec as a prereq and will meet it.

**Docs, checked:**
- `docs/architecture.md`: the new paragraph is accurate.
- `docs/optimystic.md` § Deployment Sizes, cited by the spec header: it exists and recommends exactly the configuration the spec uses.
- AGENTS.md and `docs/releasing.md`: both describe integration specs by glob, not by name, so neither needs a change.
- `yarn lint:docs`: all citations resolve.

**Tickets:**
- The handoff suggested citing the spec from `plan/6.4-commit-result-carries-durability-class`, and review did so as an evidence arm. The arm makes three points. Phase 5's acknowledged outcome is that ticket's "solo commit" case, reached by a pair that lost a member. The caller cannot tell. Phase 5 is where the `local` class and ledger drain should later be asserted.
- The implementer's two backlog updates (`6.5-partition-healing` arm, `debt-node-factory-wiring-steps-own-their-teardown` update) are accurate and correctly scoped. No new tickets were filed: no finding needed one.

**Test design, weighed and left as is:**
- **Phase 5 does not assert the admission outcome.** This is correct, since the decision belongs to `6.5-partition-healing`. If a refused row later lands, that is only logged, not failed. That is defensible while refusal semantics are undecided, and the spec comment says so.
- **Phase 5 checks reachability, not local storage.** This is an acknowledged gap. Nothing pushes a missed write to a returning member today, and the `6.4` evidence arm names where that assertion belongs.
- **Duplicated transactor and wait helpers.** `transactorFor` and the pair-wait duplicate `two-node-convergence.integration.spec.ts` in shape. The relay sibling ticket's first TODO extracts shared lifecycle helpers into `test/util/`, so that is not duplicated here.
- **Mocha behaviour on a mid-sequence failure.** A throwing `beforeEach` is reported as a hook failure naming the failed predecessor, and mocha then skips the rest of the suite's tests. The run stays red, which is the intent.
- **Resource cleanup.** `after` stops both nodes with `allSettled`. `NetworkTransactor` holds no timers or intervals that would need disposal, so per-read transactors are fine.

**Validation run in this review:**
- `test/block-transfer.spec.ts`: 41 passing, including the new test.
- db-p2p `yarn typecheck`: clean.
- Root `yarn lint` and `yarn lint:docs`: clean.
- `OPTIMYSTIC_INTEGRATION=1` lifecycle spec: 6/6 passing, 29s in mocha and 36s wall-clock, so the process exits promptly after mocha. Phase 3 took 10.5s; phase 5 took 15.3s and was acknowledged after 14.2s. Log: `tickets/.logs/small-deployment-lifecycle.review.log`.
- I did not re-run the full db-p2p unit suite (the implementer ran it: 2708 passing). Review's only unit-suite edit is in `block-transfer.spec.ts`, which was run.

**Categories with nothing found:**
- **Performance:** none. The spec takes about 30s, dominated by phase 5's deliberate wait.
- **Type safety:** none beyond the unbound call above. The spec imports only typed exports.
- **Security:** none. The change is test-only, apart from a timer-cleanup fix that changes no protocol behaviour.
- **Pre-existing failures:** none.
