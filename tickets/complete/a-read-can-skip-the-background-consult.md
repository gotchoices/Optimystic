description: A read can now ask the machine answering it not to start the background check against the other machines in the group that a routine read of a held block normally starts, so the table watcher's timer can read its own copy without sending a network request.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-core/src/network/struct.ts (`BlockGets.skipWindowConsult`), packages/db-core/src/transactor/network-transactor.ts (`downstreamGets`), packages/db-core/src/collection/collection.ts (`Collection.readCommittedTails`, `readAttributed`, `readAlone`, `tailReadFields`), packages/db-core/src/collection/struct.ts (`CommittedTailReadOptions`), packages/db-p2p/src/repo/coordinator-repo.ts (`readRepairBlock`), packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts, docs/transactions.md, docs/internals.md, docs/debugging.md
----
First half of GitHub #48's remaining idle cost. The second half, `an-idle-watch-tick-sends-no-read-request`, wires the watch tick (`committedTailReader` in `packages/db-p2p/src/reactivity/collection-watch.ts`) to pass the option; nothing sets it yet.

## What was built

- `BlockGets.skipWindowConsult?: true`: an effort hint that skips only the consult the lazy read-repair window (or its sample rate) would run behind a read of a held block. It never skips the missing-block consult, a floor-demanded consult, or any `'paranoid'` consult. It is forwarded on every downstream batch; peers that predate it ignore it.
- `CoordinatorRepo.readRepairBlock`: `windowOnly = isStale && !floorDemands && readRepairMode === 'lazy'`. With the flag set and `windowOnly`, it stamps from the doubt memo (`flagUnconfirmedCurrency`) and returns: no consult, no trigger log line, and the freshness stamp is left alone, so the next read without the flag consults.
- `Collection.readCommittedTails(transactor, queries, options?)` puts the flag on both requests and on the per-block fallback.
- Docs: transactions.md § Lazy read-repair window, internals.md read-path paragraph, debugging.md (trigger-line `background` bullet).

## Review findings

Read the diff of `ticket(implement): a-read-can-skip-the-background-consult` first, then the handoff.

- **Correctness, happy path:** checked. The skip sits after the "not stale" early return and before the `awaitWindowConsults` split, so a test seam that awaits window consults also skips. Under `SilentConsultHolds` the block never reaches the branch, because `shouldReadRepair` returns false. No problem found.
- **Exceptions preserved:** checked by reading the code. A missing block has `isStale` false and `isMissing` true, so it falls through to the blocking consult (also pinned by the second test). Floor-above-copy fails `!floorDemands`, and `'paranoid'` fails the `'lazy'` test. A doubt memo still stamps `unconfirmedAheadRev`, through the same `flagUnconfirmedCurrency` call the background branch uses.
- **Forwarding:** checked. `NetworkTransactor.get` sends both rounds through one `askRepo` → `downstreamGets`, which forwards the flag. `stateHoldingsOnReads` spreads `blockGets`. `narrowBlockGets` keeps `...rest` for left-out rounds. `RepoService.answerGet` strips only `acceptsLeftOut` and hands the rest to `CoordinatorRepo.get` verbatim. No problem found.
- **Sample-rate edge (minor, fixed):** under `'lazy'` with `readRepairSampleRate > 0`, the flag also skips a sampled re-check inside the window. That is consistent with the intent (it is still a window-only background consult), but the `BlockGets` doc mentioned only an expired window. Doc comment updated to name the sampled case.
- **Docs (minor, fixed):** debugging.md's `cluster-tx:read-repair-triggered` section did not say that a flagged read emits no trigger line. Added one sentence to the `background` bullet. transactions.md and internals.md already covered the change. `docs/reactivity.md` § The node's watch service describes the tick's cost. It is unchanged here because nothing sets the flag yet; that is the follow-on ticket's job.
- **Tests:** kept both. Each pins a named contract on branching logic: the skip leaves the window expired, and the missing-block consult survives the flag. There are no tests for forwarding (wiring), which is correct by the testing bar. Nothing was added.
- **Type safety / DRY / modularity:** `TailReadFields = Pick<BlockGets, 'skipWindowConsult'>` keeps the fallback path from forgetting the field. `true`-only on the wire, `boolean` on the options type, normalized in `tailReadFields`. No problem found.
- **Resource cleanup / error handling / performance:** nothing new is allocated or awaited. The skip removes work. No tripwire needed.
- **Observability tradeoff (intended, recorded in debugging.md):** skipped reads emit no trigger line. So once the follow-on lands, the trigger count will not reflect watch-tick reads.
- **Major findings / tickets filed:** none.

Validation: `yarn lint:docs` clean; eslint clean on touched files; db-core and db-p2p rebuilt; `yarn test` db-core 2025 passing, db-p2p 3564 passing / 74 pending, no failures. Not run: integration suites, and the Quereus plugin suite (no plugin code touched).
