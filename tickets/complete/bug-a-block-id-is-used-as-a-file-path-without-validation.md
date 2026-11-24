description: A stored item's name can no longer point outside the machine's own storage area — one check now rejects such a name wherever a stored item is read or written, so another machine on the network can no longer make this one write files where it pleases.
architecture: packages/db-p2p/docs/storage.md
files: packages/db-core/src/blocks/block-id.ts (new; `isValidBlockId`, `assertValidBlockId`, `InvalidBlockIdError`), packages/db-core/src/blocks/index.ts, packages/db-core/src/blocks/structs.ts (`BlockId`), packages/db-core/test/block-id.spec.ts (new), packages/db-p2p/src/storage/kv-raw-storage.ts (`checkedId`), packages/db-p2p/src/testing/raw-storage-conformance.ts (`rejection`), packages/db-p2p/src/storage/released-block-ledger.ts, packages/db-p2p/docs/storage.md (§7, and the stale claim under Invariant 2), packages/db-p2p-storage-fs/src/file-write-log.ts (`containedTarget`, `replaySegment`, `applyBatch`), packages/db-p2p-storage-fs/src/file-batch-backend.ts (`blockPath`), packages/db-p2p-storage-fs/test/file-storage.spec.ts, packages/db-p2p-storage-fs/test/file-write-log.spec.ts
repro: verified
----

# A block id is used as a file path without validation

## What landed

A block id is the name of one stored item, and the filesystem backend uses it raw as a relative path. Nothing validated one anywhere, so a peer naming a block `../escaped` made this node write a file outside its own store.

**The rule lives in db-core, once.** `isValidBlockId` / `assertValidBlockId` / `InvalidBlockIdError` in `packages/db-core/src/blocks/block-id.ts`: a block id is valid when it is a non-empty string, holds no C0 control character and no ``, holds no backslash (a win32 path separator, so a `/`-split check alone would miss `a\..\..\b`), does not start with a Windows drive prefix, and has every `/`-separated segment non-empty and neither `.` nor `..` — which refuses escape (`..`, a leading or trailing `/`) and aliasing (`a//b`, `./a`) alike. `a..b` and `default/app/Ledger` stay valid; nested human-named collection ids are the case the rule must keep working. `BlockId`'s stale "base64url encoded" comment now says what a block id actually is.

**`KvRawStorage` enforces it, in one place** — a private `checkedId`, named by all 18 driver forwards that take a block id, reads included. Every shipping backend and the read cache `extends` that kernel, so no node path reaches a driver around it. The check sits above the write group on purpose: a throw from inside a commit would latch the whole store failed, which is precisely what a peer naming a bad id must not be able to do.

**Two guards remain below it, neither a second owner of the rule.** `FileBatchBackend.blockPath` stays as a backstop for the recursive `deleteBlock`. `FileWriteLog.applyBatch` resolves every recorded path through a new `containedTarget` before applying any of a record, so a record naming a path outside the store applies none of itself and ends the replay where it sits — the one place a pre-fix block id survives an upgrade, and the only defence against a log forged on disk.

**Docs:** Invariant 7 of `packages/db-p2p/docs/storage.md` states the rule, where it is enforced, what breaks without it, and what it does not reach.

## Review findings

### What was checked

- **The implement diff first**, before the handoff summary (`ticket(implement): bug-a-block-id-is-used-as-a-file-path-without-validation`).
- **Both inspection greps the kernel's class comment documents.** `this\.driver\.[a-zA-Z]+\(blockId` over `packages/db-p2p/src` returns nothing; `implements\s+IRawStorage` over `packages` returns exactly the one line for `KvRawStorage`. Independently confirmed the six classes that `extends KvRawStorage` (memory, fs, sqlite, leveldb, indexeddb, and `CachedRawStorage`) — and that `CachedRawStorage` is a kernel over a caching *driver*, so a cache hit is validated too.
- **Every `this.driver.*` call in the kernel, by hand.** All 18 block-id forwards name `checkedId`; the four that do not take a block id key on a commit proof's message hash, which is re-derived from a verified proof and not attacker-chosen.
- **Where a refusal surfaces.** A contextless `StorageRepo.get` catches per block and answers `unavailable: 'unmaterializable'`, which sends the reader to the cohort; a context-carrying `get` rethrows through `settleAllPerBlock` and the request fails. Neither latches the store — `endGroup` flushes behind the fault and rethrows. That closes the handoff's first open question with no change needed: the refusal's shape on the wire is "this node cannot answer for that id", which is what refusing the request should look like.
- **What the check costs on a hot read**, since it is now on every read: 197 ns for a 43-character random id and 142 ns for `default/app/Ledger`, against 785 ns for the single `JSON.parse` of a metadata record that the same read already does (2M iterations each, warmed, this machine). A fifth to a quarter of one decode; not worth a note at the site.
- **The tests as code, not as a floor.** Four new ones, one behaviour each, nothing restating the implementation or verifying a mock: the boundary table lives only in db-core, the conformance case asserts the cross-backend consequence (refused, and the store still takes a later write), and the two fs cases assert what only that backend can — that nothing landed beside the store, and that a pre-fix record in a log opens and serves. None cut, none added; the defect I did find is a ticket, not a test, because no rule exists yet to pin.
- **The suites the implementer had not run.** `db-p2p-storage-ns`, `-rn` and `-web` all consume the changed shared conformance suite: 89, 85 and 85 passing. So the new case is green over sqlite, leveldb and indexeddb as well as memory and the filesystem.
- **The win32 claims at the validator**, against the code as written: the trailing-space NOTE (measured, `fs` does not alias `a ` and `a`) and the colon NOTE are both consistent with the rule as implemented. `commitProofRelativePath` is out of scope, as the handoff said.

### Found and fixed in this pass

- **A comment that was wrong.** `containedTarget`'s doc claimed "nothing this build writes can produce an escaping record". It can — see the ticket below. Corrected, with what actually reaches the guard and why a throw there is worse than a refusal above the driver.
- **`saveBlockProof` checked the id too late.** It wrote (and memoized) the shared proof body through `ensureCommitProof` *before* `saveProofEntry` validated the block id, so a refused id still cost the store a write — against the kernel's own class comment. The id is now checked first and the ordering rule between the body and the reference is untouched.
- **A stale paragraph in `packages/db-p2p/docs/storage.md`.** Invariant 2's *Deleting a block* still said "nothing upstream validates a block id at all, which is the backlog ticket …" — false the moment §7 landed, and pointing at this ticket. It now names the kernel's refusal and calls the backend guard what it is.
- **§7's "What this does NOT address"** now names the action-id gap below, so the invariant does not read as covering every name a backend turns into a path.
- **DRY in the conformance suite.** The new `rejection` helper now also replaces the hand-rolled try/catch in the promote-missing case, the one place that idiom was already duplicated.
- **A test name** that used a backtick where an apostrophe was meant.

### Found and filed

**`tickets/fix/bug-an-action-id-is-used-as-a-file-path-without-validation.md`** — the same defect class in the sibling identifier, and the one real hole this ticket's scope left open. An **action id** is also chosen by whoever originates a write, is never re-derived or format-checked (deliberately, and documented), reaches the node through a bare `JSON.parse(...) as RepoMessage`, and is used by the filesystem backend as a path segment with only colons percent-encoded. Measured on this build: a pend with a legitimate block id and the action id `../../../escaped` fails as `store failed: … write-ahead log record names "held/pend/../../../escaped.json", which is not inside <store>; every later write and flush is refused until the store is reopened` — and the next ordinary write on that store fails the same way. So one request from a peer stops a node's storage until it is restarted, and reopening ends the log's replay at that record, discarding the legitimate records appended after it. The new containment guard is what keeps the bytes inside the store; before it, the same request wrote a file beside the store instead.

Filed in `fix/` rather than `backlog/` because it is reachable now, by one unprivileged request. Filed as one ticket at the invariant, not at the instance: the fix is the same enforcement point this ticket built (`checkedId`'s sibling) and the same statement widened from "a block id reaching a backend names a location inside the store" to every wire-supplied name a backend turns into a path. Two further arms ride along as evidence, both read-only findings rather than run: `listPendingActionIds`' read-side filename filter silently skips an action id carrying a dot, so such a pending record is written and then never enumerated for conflict detection; and a revision number is interpolated into a path from the same unchecked decode. The site-claim grep over `backlog/ fix/ plan/ implement/ review/` found nothing already open on these files.

### Conditional concerns (tripwires)

None newly recorded, and that is deliberate rather than an empty category: this change's two genuinely conditional concerns are the win32 NOTEs the implementer already left at the validator (a segment ending in a space or a dot, and a colon past the first character), both measured and both carrying their revisit condition. One more was considered and left unwritten — on POSIX a hand-made directory literally named `C:something` inside a store would be yielded by `listBlockIds` and then refused by the new rule, so a sweep reading that block would throw. It needs someone to create that directory by hand in a store, which is not a shape the system can reach on its own, and the validator's doc comment already says why the drive-prefix clause exists.

### Considered and declined

- The accepted-tradeoff NOTE in `packages/db-p2p/src/storage/released-block-ledger.ts` (no second containment check on the released-block key, because the kernel's assert makes an escaping id unstorable) carries its revisit condition and was left alone.
- The aliasing limits at `BLOCK_STORE_DIRS` and on `deleteBlock` — an id naming another block's store directory (`x/revs`) is inside the store and passes the rule — are untouched and named in §7 as out of reach of the validator. Retiring them means encoding block-id segments in the layout, which changes every store on disk.
- The sealed-segment cost the handoff flagged (a stopped-short sealed segment discards the current log with it) is left as the implementer chose it: it is the bargain `replay`'s existing NOTE already states for a damaged sealed segment, and a special case for this one stop reason would be a second set of stop semantics to keep straight.

### Validation

Full suites, once, after the fixes above were in: `db-core` 2128 passing; `db-p2p` 3934 passing / 84 pending; `db-p2p-storage-fs` 145 passing / 1 pending; `db-p2p-storage-ns` 89; `db-p2p-storage-rn` 85; `db-p2p-storage-web` 85; `upgrade-check` 341; `quereus-plugin-optimystic` 1458 passing / 16 pending plus its smoke script. Root `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` (49 documents, all citations resolve), `yarn lint:deps` and `yarn check:rn` (Metro 19.4 s, hermesc 12.1 s) all clean. `test:integration` was not run: the change touches storage only, not networking, cohort assembly, reactivity or matchmaking. No pre-existing failure surfaced, so `tickets/.pre-existing-error.md` was not written.
