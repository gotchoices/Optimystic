description: A machine on the network picks the name of each write it sends, and the receiving machine turned that name straight into a file path — so a crafted name could stop the receiver's storage from accepting any write until it was restarted, or make it hand back the contents of a file outside its own storage area. The same gap also hid some perfectly ordinary writes from the receiver's own bookkeeping. All three are now refused or listed correctly; this is the review pass.
architecture: packages/db-p2p/docs/storage.md#7-an-identifier-reaching-a-backend-names-a-location-inside-the-store
files: packages/db-core/src/blocks/block-id.ts, packages/db-core/src/collection/action-id.ts, packages/db-core/src/blocks/revision.ts, packages/db-core/src/collection/index.ts, packages/db-core/src/blocks/index.ts, packages/db-core/test/action-id.spec.ts, packages/db-core/test/block-id.spec.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p-storage-fs/src/file-batch-backend.ts, packages/db-p2p-storage-fs/src/file-write-log.ts, packages/db-p2p/docs/storage.md
----

# An action id is used as a file path without validation — review handoff

## What landed

Invariant 7 of `packages/db-p2p/docs/storage.md` used to cover one of the three wire-supplied names a storage backend turns into a location. It now covers all three, with one enforcement point:

> An identifier that reaches a `RawStoreDriver` — block id, action id, revision number — names a location inside the store, and the node refuses the request before any driver is touched if it does not.

Three rules, each stated beside its own type, all three asserted in `KvRawStorage` and nowhere else:

- **`isValidActionId`** — new, `packages/db-core/src/collection/action-id.ts`. An action id is ONE path segment: non-empty, within the shared length bound, no C0 control or ``, no `/` or `\`, not `.` or `..`, and **no `%`**. The `%` clause is the aliasing one — it is what makes the filesystem backend's `:`↔`%3A` encoding injective, so `tx:a` and `tx%3Aa` can no longer share one file. Deliberately a containment rule and not a charset: `~proof:5` and `tx:café—🔒—Ω` are ids the system stores today.
- **`isValidRevision`** — new, `packages/db-core/src/blocks/revision.ts`. `Number.isSafeInteger(rev) && rev >= 0`. One predicate closes the fs backend's filename spelling and the LevelDB backend's `setBigUint64(…, BigInt(rev))`.
- **`MAX_STORED_ID_LENGTH`** — new, in `block-id.ts` (no imports there, so no cycle with `collection/`), applied by `isValidBlockId` as well as `isValidActionId`. 1024 UTF-16 code units; the constant carries the headroom arithmetic against the write-ahead log record format's 65535-byte path field. **This closes a hole in the rule that already shipped**: a 70000-character *block* id latched the store too, and passed `isValidBlockId` before this.

`KvRawStorage` grew `checkedActionId` and `checkedRev` beside `checkedId`, named from every forward that takes one — reads included, which is the non-negotiable half (reads never touch the write-ahead log, so its containment guard is not on that path at all). `saveRevision` checks its action id too, even though the id is that record's *value*, because `materializeBlock` reads a revision and then asks for the materialization under the id it found. The class comment carries a new inspection grep beside the two already there.

`listPendingActionIds` in `packages/db-p2p-storage-fs/src/file-batch-backend.ts` now filters on `isValidActionId` instead of its own narrower charset, so a record the backend wrote is a record it lists.

Doc/comment reconciliation, so no reader is left with retired text: `containedTarget`'s doc comment in `file-write-log.ts` (it no longer cites this ticket as open; it is now the replay-only guard, for a pre-check store's log and for a log forged on disk), the "never re-derived **or format-checked**" wording at `RawStoreDriver.getProof` and in `kv-raw-storage.ts`'s commit-proofs comment (both now say the keyspace-separation decision is intact and `~proof:5` is still legal), and Invariant 7 itself — heading renamed, "What this does NOT address" retired, the three distinct harms stated with the recoverability measured rather than overstated.

## What a reviewer should go at

**The rule's edges are a judgement call and this is where to push.** `isValidActionId` admits colons, non-ASCII, `@`, lone surrogates, trailing spaces and dots. The survey behind that is in the fix ticket: all 223 action-id literals in the repository pass, and the three outside `[A-Za-z0-9:_-]` are `~proof:5`, `tx:café—🔒—Ω` and the lone-surrogate id in `packages/db-p2p/test/raw-store-codec.spec.ts`. If you think a tighter rule is right, the argument has to survive those three.

**The `%` clause is the one clause with a compatibility edge.** It refuses an id a pre-rule node could have written, so a store holding a `pend/tx%3Aa.json` written as the literal id `tx%3Aa` can no longer be *written* under that id again — it is still readable (nothing was renamed), and the listing now skips it as junk rather than reporting it. That is the intended trade (the alternative is two ids sharing a file), but it is the clause most worth a second opinion.

**The inspection grep is new and I rewrote it once.** The first version used `[^)]*`, which cannot cross the `)` of `this.checkedId(blockId)` and so matched nothing *including the bad forms*. The shipped version matches the bare-argument spelling:

```
grep -rnE "this\.driver\.[a-zA-Z]+\(.*, (actionId|rev)[,)]" packages/db-p2p/src
```

Verified both ways: empty on the tree, and it does catch `, rev)` / `, actionId,` when fed those lines. Its one blind spot is documented at the site — `listRevisions` names the locals `lo`/`hi`, assigned from `checkedRev` two lines above the call. Worth checking whether you consider that acceptable.

**`saveBlockProof`'s ordering.** `checkedId` and `checkedRev` both run before `ensureCommitProof`, so a refused name still cannot leave a memoized proof body behind for a block that can never reference it. Read the method to confirm I did not move the write earlier.

## Use cases, and what was actually run

**The three harms, each verified on the real filesystem backend** (`FileRawStorage` over the real `FileBatchBackend`, Windows 10 / Node 25). Driving the built `dist` directly, before and after:

| | before | after |
|---|---|---|
| `savePendingTransaction('held', '../../../escaped', t)` | store latched; the next ordinary write and `close()` both failed | `InvalidActionIdError`; the store takes and lists a later write |
| `getPendingTransaction('held', '../../../OUTSIDE-SECRET')` | returned the contents of a `.json` file beside the store | `InvalidActionIdError` |
| pend `tx:AbC-_9`, `tx:café—🔒—Ω`, `~proof:5` then list | `["tx:AbC-_9"]` — two legitimate records invisible | all three listed |
| pend `tx:a`, then `tx%3Aa` | one file, the second overwriting the first | `tx%3Aa` refused |
| pend `a/b` | `pend/a/` directory, listed as nothing | refused |

The throwaway script that produced the "after" column lived in the session scratchpad and is not in the tree.

**Commands run** (per `tickets/rules/testing.md` — no package's full `yarn test`):

- `yarn workspace @optimystic/db-core build`, `… @optimystic/db-p2p build`, `… @optimystic/db-p2p-storage-fs build` — all clean. Root `yarn typecheck` not run: no quereus plugin changed.
- `yarn lint:docs` — 49 documents, all citations/links resolve (the renamed Invariant 7 heading included).
- `yarn lint:deps` — every import declared.
- `npx eslint` over all ten changed/added source and spec files — clean.
- db-core: `test/action-id.spec.ts test/block-id.spec.ts` — 8 passing.
- db-p2p: `test/kv-raw-storage.spec.ts` (47 passing), plus `cached-raw-storage` `write-group-driver` `journal-batch-backend` `shared-cache-pool` `raw-store-codec` `proof-keyspace-isolation` (467 passing), plus `storage-repo` `block-storage` `quorum-restore` `quorum-restore-certified` `reconcile-block` `block-archive-proof` `released-block-sweep` (366 passing).
- db-p2p-storage-fs: `test/file-storage.spec.ts` (77 passing), `test/file-write-log.spec.ts` (29 passing).
- **All four other backends that consume the changed shared conformance suite were run by file too**, since the suite's identifier case is new: `db-p2p-storage-ns/test/sqlite-storage.spec.ts` (54), `db-p2p-storage-rn/test/leveldb-storage.spec.ts` (60), `db-p2p-storage-web/test/indexeddb-storage.spec.ts` (58). All passing. No pre-existing failures surfaced anywhere, so nothing was written to `tickets/.pre-existing-error.md`.

Review still owes the **full** suites (`yarn test` per package, and `yarn check:rn`), which is where a cross-cutting kernel change like this earns its keep.

## Tests added, and what each verifies

- `packages/db-core/test/action-id.spec.ts` (new) — the one place `isValidActionId`'s edges are pinned: an accept table with a reason per row (the colon forms, `~proof:5`, `tx:café—🔒—Ω`, the bare alphanumerics, a legacy UUID, `a..b`, exactly at the length bound) and a reject table (empty, `.`, `..`, `../escaped`, `a/b`, `a//b`, a backslash escape, `tx%3Aa`, any `%`, NUL, one over the bound), plus the non-string case and the error type. Modelled on `block-id.spec.ts`.
- `packages/db-core/test/block-id.spec.ts` — two rows added, at and one over `MAX_STORED_ID_LENGTH`. The table was already the single home for the block-id edges, and the bound is a new clause on it.
- `packages/db-p2p/src/testing/raw-storage-conformance.ts` — the existing block-id case is widened into one case over all three identifiers, asserting the cross-backend CONSEQUENCE and nothing about the rules' edges: a write is refused, a **read** is refused, and the store still takes an ordinary write afterwards. One case, not three, because it is one behaviour.

No new fs-only case: the read refusal is assertable from the shared suite, so the ticket's escape hatch was not needed. No boundary table for `isValidRevision` — see the open question below.

## Settled while implementing

**Is `0` a legitimate revision?** Yes. `StorageRepo.pend` compares and lists from `request.rev ?? 0` (`packages/db-p2p/src/storage/storage-repo.ts:1358,1367`), so a rev-less pend reaches `listRevisions(0, …)`. The rule's floor is 0, accepted.

**Does anything legitimately reach a negative revision?** No, and no caller was changed. The two expressions that could arithmetically produce one are both guarded above storage: `computeRevertedBlock` probes only when `invalidatedRev > 1` (`packages/db-p2p/src/dispute/invalidation.ts:426`), and `storage-repo.ts:1761`'s `getBlock(request.rev - 1)` fails `BlockStorage`'s `inRanges` and throws `RevisionNotCoveredError` before any revision record is read, since stored ranges never start below 0.

**The restore path's `Number(rev)`.** The fix ticket read this as "safe by accident". It is actually safe by a gate: `vetRestoredArchive` refuses a non-numeric revision key before `saveRestored` is reached, and `packages/db-p2p/test/block-storage.spec.ts:1038` already pins that. The new `checkedRev` is a second line behind it, not a behaviour change, and that test passes unchanged.

## Open questions and known gaps — read these before signing off

- **`isValidRevision` has no boundary table of its own.** It is two conditions over `Number.isSafeInteger`, and its cross-backend consequence rides the conformance case, so I judged a dedicated spec below the bar in `tickets/rules/testing.md`. The ticket's test list did not name one either. If you disagree, the row set is small (`0`, a safe integer, `-1`, `1.5`, `NaN`, `Infinity`, `2**53`, a string) and `revision.ts` is where the reasons live.
- **The length bound is argued, not measured at the boundary.** 1024 code units is justified by arithmetic against the log's 65535-byte path field (stated in the constant's comment), not by a test that builds a 65536-byte path. The 70000-character latch itself was measured in the fix ticket; what is unmeasured is whether anything between 1024 and the cap matters, and I claim it does not because the arithmetic has an order of magnitude of headroom.
- **Nothing was done about the fs backend's `listPendingActionIds` skip being log-only.** A record skipped as junk is logged and invisible; there is no counter and no surfacing. That was true before and is unchanged, but the filter's population has changed (it now skips strictly less), so it is worth a glance.
- **Two identifier limits are untouched and still real**, both already documented at their sites and in Invariant 7: a block id that aliases another block's store directory (`x/revs`, `x/blocks/y`), and a win32 name with a trailing space or dot that Explorer cannot address. Retiring either means encoding block-id segments in the on-disk layout.
- **No tripwires were parked for this ticket.** Nothing I found was conditional-and-fine-now; the three harms were defects and are fixed, and the two limits above are pre-existing accepted limits with their own `NOTE:`s already in place.
