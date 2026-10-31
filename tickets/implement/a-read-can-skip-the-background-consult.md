description: Let a read ask the machine answering it not to start the background check against the other machines in the group that a routine read of a held block normally starts, so the table watcher's timer can read its own copy without sending a network request.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-core/src/network/struct.ts (`BlockGets`), packages/db-core/src/transactor/network-transactor.ts (`downstreamGets`), packages/db-core/src/collection/collection.ts (`Collection.readCommittedTails`, `readAttributed`, `readAlone`), packages/db-core/src/collection/struct.ts (`CommittedTailQuery`), packages/db-p2p/src/repo/coordinator-repo.ts (`readRepairBlock`, `startHeldBlockConsult`), packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts, docs/transactions.md, docs/internals.md
difficulty: easy
----
First half of GitHub #48's remaining idle cost; the second half is `an-idle-watch-tick-sends-no-read-request`, which uses this.

## Why

On a node that holds a block, a read is answered from its own copy. When the copy's lazy read-repair window (`readRepairWindowMs`, 10 s) has expired, the read also starts a consult of the block's cohort behind it (`startHeldBlockConsult` in `packages/db-p2p/src/repo/coordinator-repo.ts`): one request per cohort peer per 32 blocks. The watch service's tick (`ReactivityCollectionWatch` in `packages/db-p2p/src/reactivity/collection-watch.ts`) reads every watched collection's header and tail every 20–30 s, always past the window, so on a two-member group every idle tick costs one or two consult requests per machine with nothing changed. The tick needs a way to say "read what you hold; don't start that consult".

## Design

A new optional field on `BlockGets`:

```ts
/** The asker does not want this read to start the read-repair consult that the lazy window alone
 *  would run BEHIND the read. ... */
skipWindowConsult?: true;
```

Semantics, enforced in `CoordinatorRepo.readRepairBlock`:

- It removes exactly the consult that would have run behind the read — the `background` branch (window expired, no floor demand, `readRepairMode: 'lazy'`, not `awaitWindowConsults`). With the flag that branch starts nothing and logs no `cluster-tx:read-repair-triggered`; it still calls `flagUnconfirmedCurrency`, so a doubt memo recorded by an earlier pass still stamps `unconfirmedAheadRev` (honesty is unchanged, only the effort moves).
- Every consult that blocks the read is unaffected, because its answer depends on the cohort: a block missing locally (the absence verdict), a held block whose read carries a floor above its copy (`floorDemandsConsult`), and every consult under `'paranoid'`. The `awaitWindowConsults` test seam: the flag skips there too (it is the same window-only consult, merely awaited).
- The window's freshness stamp is not touched, so the next read without the flag consults as before.

Carried everywhere a `BlockGets` travels:

- `downstreamGets` in `network-transactor.ts` forwards the field on every batch, both rounds (the floors are forwarded per batch; this is a whole-read flag, forwarded whole). A remote coordinator answering a node that holds nothing therefore also skips its own background consult for that read — deliberate, so the watch tick means the same thing for a subscriber that stores nothing (see the second ticket for the bound). `RepoService.answerGet` passes the operation to `CoordinatorRepo.get` verbatim, so no protocol change; a peer on an older build ignores the field and consults as before. Check that the reader's remote decorator (`stateHoldingsOnReads` in `packages/db-p2p/src/repo/stated-holdings.ts`) keeps the field.
- `Collection.readCommittedTails(transactor, queries, options?: { skipWindowConsult?: boolean })` puts it on both requests it may make (header plus known tails, then moved tails) and on the per-block fallback reads after a whole-request failure (`readAttributed`, `readAlone`).
- `TestTransactor` and other `ITransactor`s ignore it, which is correct: it is an effort hint, never a correctness one.

## Edge cases & interactions

- Missing block with the flag: still consults and still produces the absence verdict / `unavailable` flags — verified by test.
- Held block, window expired, flag set: no consult started, local entry served — verified by test.
- Floor above the held copy with the flag: still a blocking consult — by inspection (the branch order: `background` already requires `!floorDemands`).
- `paranoid` mode: unaffected — by inspection (`background` requires `'lazy'`).
- A read inside the window: unaffected (no consult either way).
- Doubt memo present: entry still stamped `unconfirmedAheadRev`, so `NetworkTransactor.get` still earns its second-chance round against another coordinator (which also receives the flag) — by inspection.
- Mixed versions: an older coordinator ignores the field — no gate needed, since the flag only reduces effort.
- `skipClusterFetch` (the sync-protocol recursion guard) is a different, stronger thing (no consult of any kind, never flags); do not merge the two.

## Tests

In `packages/db-p2p/test/coordinator-repo-held-block-background-consult.spec.ts` (reuse its storage and callback doubles):

- held block, expired window, `skipWindowConsult: true` → the consult callback is never called and the read returns the held copy; the same read without the flag consults (an existing spec may already show the second half — reuse it rather than duplicate).
- missing block with `skipWindowConsult: true` → the consult still runs.

No test for the forwarding through `NetworkTransactor` or `readCommittedTails` (wiring).

## Docs

- `BlockGets.skipWindowConsult` doc comment: what it skips, what it never skips, forwarded on the wire, older peers ignore it.
- `docs/transactions.md` § Lazy read-repair window: one sentence naming the opt-out and who uses it (the watch tick).
- `docs/internals.md` — the read-path paragraph ("on a machine in the block's cohort an idle poll costs no network request inside the lazy read-repair window, plus one cohort consult per block per window") gains a clause that a read marked `skipWindowConsult` costs none outside it either.

## TODO

- Add `skipWindowConsult` to `BlockGets` with its doc comment.
- Honor it in `CoordinatorRepo.readRepairBlock`'s `background` branch only.
- Forward it in `downstreamGets`; confirm `stateHoldingsOnReads` and the plugin's `getRepo` decorators preserve it.
- Add the `options` parameter to `Collection.readCommittedTails` and thread it through `readAttributed` / `readAlone`.
- The two specs above.
- Doc updates above; run `yarn lint:docs`.
- Build, then `yarn test` in db-core and db-p2p.
