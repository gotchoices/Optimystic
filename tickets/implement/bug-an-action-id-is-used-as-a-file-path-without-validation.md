description: A machine on the network picks the name of each write it sends, and the receiving machine turns that name straight into a file path — so a crafted name can stop the receiver's storage from accepting any write until it is restarted, or make it hand back the contents of a file outside its own storage area. The same gap also hides some perfectly ordinary writes from the receiver's own bookkeeping.
architecture: packages/db-p2p/docs/storage.md#7-a-block-id-reaching-a-backend-names-a-location-inside-the-store
files: packages/db-core/src/blocks/block-id.ts (the sibling rule, and where the shared length bound goes), packages/db-core/src/collection/action-id.ts (new), packages/db-core/src/blocks/revision.ts (new), packages/db-core/src/collection/index.ts and packages/db-core/src/blocks/index.ts (exports), packages/db-core/test/action-id.spec.ts (new), packages/db-p2p/src/storage/kv-raw-storage.ts (`checkedId`, and the new `checkedActionId` / `checkedRev` beside it), packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p-storage-fs/src/file-batch-backend.ts (`listPendingActionIds`, `encodeActionIdForFilename`), packages/db-p2p-storage-fs/src/file-write-log.ts (`containedTarget`'s doc comment), packages/db-p2p-storage-rn/src/keys.ts (`revScopedKey`'s `BigInt(rev)`), packages/db-p2p/docs/storage.md (Invariant 7)
repro: verified
----

# An action id is used as a file path without validation

## The one sentence

A **block id** — the name of a stored item — got a rule and a single enforcement point in the sibling ticket `bug-a-block-id-is-used-as-a-file-path-without-validation`: `isValidBlockId` in `packages/db-core/src/blocks/block-id.ts`, asserted by `KvRawStorage.checkedId` before any id reaches a storage backend. It is not the only wire-supplied name a backend turns into a path. The **action id** (the name of one write, chosen by whoever originates it) and the **revision number** are the other two, and neither is checked anywhere. This ticket widens that one enforcement point to cover all three, and widens Invariant 7 of `packages/db-p2p/docs/storage.md` to say so:

> An identifier that reaches a `RawStoreDriver` — block id, action id, revision number — names a location inside the store, and the node refuses the request before any driver is touched if it does not.

"Before any driver is touched" is the whole point and is what the existing lower guards cannot give. `FileWriteLog`'s containment guard (`containedTarget`) sits on the live commit path, where a throw is a storage fault and latches the store by contract (rule 5 of the flush contract at `RawStoreDriver.flush`): it keeps the bytes inside the store but converts one bad request into "this node accepts no further writes". A refusal above the driver rejects that one request and leaves the store serving, which is why the block id's check was placed there.

## What reaches the node unchecked

An inbound repo request is `JSON.parse`d and cast — `handleIncomingStream` in `packages/db-p2p/src/repo/service.ts` — and dispatched to `repo.pend` / `repo.commit` / `repo.cancel`. The only structural check on the way (`batchShapeFault` in `packages/db-p2p/src/cluster/record-operations.ts`) uses the action id as a set-equality key and never looks at its shape. A restore archive is a second inbound surface: `BlockStorage.saveRestored` writes `action.actionId` straight from a peer's archive into the revisions, transactions and materialized stores. Messages are capped at 8 MiB (`MAX_BLOCK_MESSAGE_BYTES`), so a name of tens of thousands of characters fits comfortably in a legitimate request.

The filesystem backend then uses the action id **as a filename** and the revision number **as a filename** (`relativeActionScopedPath` and `relativePath` in `packages/db-p2p-storage-fs/src/file-batch-backend.ts`). The only transformation is percent-encoding of colons for Windows (`encodeActionIdForFilename`); `/`, `\`, `..` and `%` pass through untouched.

## What goes wrong — eight arms, all measured

Every figure below was produced on this build by driving `FileRawStorage` (the real kernel over the real backend) directly, on Windows 10 / Node 25, except where marked. The scripts were temporary and are not left in the tree.

**1. A crafted action id latches the store (verified).** A pend of a legitimate block id `held` under the action id `../../../escaped`:

```
StoreFailedError: store failed: a commit of its writes rejected (write-ahead log record
names "held/pend/../../../escaped.json", which is not inside <store>); every later write
and flush is refused until the store is reopened
```

The next perfectly ordinary write on that store fails with the same error, and so does `close()`. One request from one peer, and the node accepts no further writes. Nothing lands outside the store — the containment guard is what stops that; before it existed the same request wrote a file beside the store instead.

**2. The latch is recoverable, not permanent (verified).** Reopening the directory works: the replay ends at the escaped record and the store then serves and takes new writes, and a second reopen does too. Records already applied to the tree survive (a flushed earlier pending was still readable, and later pendings listed normally afterwards). So the honest harm statement is "one request stops this node's storage until the process is restarted, losing the faulting batch and anything a concurrent store over the same directory appended after it" — not permanent corruption. Say it that way in the docs; the fix ticket's own wording overstated it.

**3. A crafted action id reads a file from outside the store and returns its contents (verified).** Reads never touch the write-ahead log, so the containment guard is not on that path at all: `actionScopedPath` is `blockPath(blockId)` (checked) joined with the unchecked name. With a file `OUTSIDE-SECRET.json` beside the store:

```
getPendingTransaction('held', '../../../OUTSIDE-SECRET')  -> {"secret":"not the store's"}
getMaterializedBlock('held', '../../../OUTSIDE-SECRET')   -> {"secret":"not the store's"}
getRevision('held', '../../../OUTSIDE-SECRET')            -> "{\"secret\":\"not the store's\"}"
getProofEntry('held', '../../../OUTSIDE-SECRET')          -> {"secret":"not the store's"}
```

Any `.json` file the process can read, anywhere on the machine, by relative path from the store. The commit path reads a pending record by the request's own action id, so this is reachable the same way arm 1 is. This is the arm that makes read-side enforcement non-negotiable — exactly as the block id's check covers reads.

**4. Two legitimate action ids are written and then never enumerated (verified).** `listPendingActionIds` filters the filenames it walks to `^(?:tx:|stamp:)?[A-Za-z0-9_-]+$`, logging and skipping anything else, so that junk in `pend/` cannot read as a phantom pending. That filter is **narrower than what the system actually uses**. Pending three ids and listing them back:

```
pend/ files: [ 'tx%3AAbC-_9.json', 'tx%3Acafé—🔒—Ω.json', '~proof%3A5.json' ]
listPendingTransactions -> ["tx:AbC-_9"]
```

`~proof:5` is documented as a legitimate action id in `KvRawStorage`'s own class comment and is exercised by the shared conformance suite and by `packages/db-p2p/test/proof-keyspace-isolation.spec.ts`; `tx:café—🔒—Ω` is exercised by `packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts`. Both are written by the filesystem backend and then invisible to it, so a later `pend` that should conflict with such a record does not see it. This is a plain correctness defect on the fs backend with no crafted input at all, and it is the arm that most wants fixing regardless of the security framing.

**5. An action id carrying a slash becomes a directory, and the pending vanishes (verified).** Action id `a/b` → `pend/a/` is created as a directory holding `b.json`; `listPendingTransactions` answers `[]`. Contained, but a hidden pending, and two ids (`a/b` and `a//b`) would share one location — the aliasing half of the block-id rule, which the action id does not have.

**6. The percent-encoding is not injective, so one action id clobbers another's record (verified).** `encodeActionIdForFilename` maps `:` → `%3A` and `decodeFilenameToActionId` maps `%3A` → `:`, but `%` itself is not encoded. So `tx%3Aa` and `tx:a` are two different action ids that share one file:

```
pend/ files: [ 'tx%3Aa.json' ]      (after pending tx:a, then tx%3Aa)
get("tx:a")   -> the transform written under tx%3Aa
get("tx%3Aa") -> the transform written under tx%3Aa
listPendingTransactions -> ["tx:a"]
```

A pending record is silently overwritten by a differently-named action, and the listing reports an action that was never pended. Same class as the block-id rule's aliasing clause (`a//b` aliasing `a/b`).

**7. A long name latches the store, and this already escapes the landed block-id rule (verified).** The write-ahead log's record format holds a path of at most 65535 bytes and `encodePayload` throws above it — on the commit path, so it latches. An action id of 70000 characters:

```
store failed: ... write-ahead log path is 70015 bytes, over the 65535 the record format holds
```

and the next ordinary write fails the same way. **The same is true of a block id of 70000 characters** (`write-ahead log path is 70016 bytes ...`), which passes `isValidBlockId` today because that rule has no length bound. So this arm is a hole in the rule that already landed, not only in the one being added, and it belongs to the shared length bound below.

**8. A non-numeric or negative revision number (verified at the storage API; wire reachability static).** `rev` is declared `number` and arrives from the same unchecked `JSON.parse`. `saveRevision('held', '../../../escapedrev', 'tx-ok')` latches the store with `write-ahead log record names "held/revs/../../../escapedrev.json"`, and the four reads in arm 3 include the rev-keyed stores. It is **not fs-only**: `revScopedKey` in `packages/db-p2p-storage-rn/src/keys.ts` does `setBigUint64(…, BigInt(rev))`, and `BigInt('../x')` throws `SyntaxError`, `BigInt(1.5)` throws `RangeError`, and a negative value throws `RangeError` out of `setBigUint64` — inside that backend's write path, so the LevelDB store faults on the same input. What is **not** verified is a wire path that delivers a bad `rev` all the way to `saveRevision`: on a block with no `latest` the commit path's `latest.rev >= request.rev` comparisons are skipped entirely and `request.rev` flows to `saveRevision`, which reads as reachable, but that was traced in the code and not run. The restore path is safe by accident and worth not breaking: `saveRestored` coerces with `Number(rev)`, so a hostile archive key becomes `NaN` and the path stays contained (`revs/NaN.json`).

## What should be true, and the rule to write

Three rules, each stated once beside its own type, all three reachable from Invariant 7, all three enforced in `KvRawStorage` and nowhere else.

**An action id is one filename, not a path.** Unlike a block id, whose `/`-separated nesting the layout depends on and must keep working, an action id is a single path segment. Recommended rule — `isValidActionId`, a containment-and-aliasing rule and deliberately *not* a charset:

- a non-empty string (the declared type is not evidence at a network boundary: `typeof` it);
- at most `MAX_STORED_ID_LENGTH` code units (below);
- no C0 control character and no `` (a NUL makes `fs` throw);
- no `/` and no `\` — both are path separators, and an action id must stay one segment;
- not `.` and not `..` — contained today only because of the `.json` suffix the layout happens to append, and the rule should not rest on that;
- no `%` — the aliasing clause, arm 6: with `%` out of the id, `encodeActionIdForFilename` / `decodeFilenameToActionId` are injective on valid ids and two ids can no longer share a file.

A colon stays legitimate — `tx:<base64url>` and `stamp:<base64url>` from `createTransactionId` in `packages/db-core/src/transaction/transaction.ts` are what real ids look like, plus legacy UUIDs and the bare alphanumerics the conformance suite uses — and the backend already percent-encodes it for Windows. Non-ASCII stays legitimate too: `tx:café—🔒—Ω` is an existing test id. **All 223 action-id literals in the repository were surveyed against this rule and every one passes**; the three outside `[A-Za-z0-9:_-]` are `~proof:5`, `tx:café—🔒—Ω`, and the lone-surrogate id `a\uD800b\uDC00c😀` in `packages/db-p2p/test/raw-store-codec.spec.ts`, which only ever reaches the codec directly and never the kernel. A charset rule would have broken the first two; this is why the rule is containment-shaped.

**A revision number is a non-negative safe integer.** `Number.isSafeInteger(rev) && rev >= 0`. Two things to settle while implementing rather than assume: whether any legitimate path passes `0` (`request.rev ?? 0` and `listRevisions(request.rev ?? 0, …)` appear in `storage-repo.ts`, so assume yes), and whether any passes a negative — `storage-repo.ts` has `getBlock(request.rev - 1)`, which is `-1` if a request ever carries `rev: 0`. If a legitimate caller does reach a negative rev, fix the caller rather than widening the rule, and say which in the handoff.

**One length bound, shared.** A single `MAX_STORED_ID_LENGTH` applied by all three validators, so arm 7 closes for the block id as well as the action id. 1024 UTF-16 code units is the recommendation: at most 4096 UTF-8 bytes per name, so even a path combining two of them plus the fixed segments stays far under the log's 65535-byte cap, while being orders of magnitude above anything real (a `tx:` id is about 50 characters; `default/app/Ledger` is 18). State the arithmetic in the constant's comment so the next person can see the headroom rather than re-measure it.

**What this does not change.** Nothing here re-derives an action id or constrains what a writer may call its write beyond "it must not name somewhere else on the disk, and must not alias another id". The documented stance that an action id is never re-derived or format-checked (the reason proofs keep their own keyspace rather than a reserved action-id prefix — `getProof` in `packages/db-p2p/src/storage/raw-store-driver.ts`, and the keyspace comment in `kv-raw-storage.ts`) stays exactly as it is, and `~proof:5` stays a legal action id. Make that explicit where those comments live, so a later reader does not read the new check as having retired that decision.

**Files already on disk stay readable.** The rule applies to a name arriving at the kernel, not to a filename already written by an older build. The raw-colon read fallback in `readActionScopedBytes` keeps working, and the fix must not rename anything on disk.

## The enforcement point

`KvRawStorage` gets `checkedActionId` and `checkedRev` beside the existing `checkedId`, with the same doc-comment reasoning (checked before the driver is touched, so a refusal costs one request rather than the store), and **every** forward that takes one names them — reads included, because of arm 3. The methods are: `getRevision` / `saveRevision` / `listRevisions` (rev; `saveRevision` also takes an action id *as its stored value*, which a later `getMaterializedBlock` turns into a path, so check it there too), `getPendingTransaction` / `savePendingTransaction` / `deletePendingTransaction`, `getTransaction` / `saveTransaction`, `getMaterializedBlock` / `saveMaterializedBlock`, `promotePendingTransaction`, and `getBlockProof` / `saveBlockProof` / `getProofEntry` / `saveProofEntry` (rev). `saveBlockProof` already checks its block id early, before `ensureCommitProof` writes anything; keep that ordering and give the rev the same treatment.

The three `messageHash` forwards need nothing: a hash is re-derived from a verified proof, and `commitProofRelativePath` percent-encodes every character outside `[A-Za-z0-9_-]`, so no hash can name a path outside the store.

Add an inspection grep to the class comment beside the two that are already there, so a future forward that hands the driver a bare `actionId` or `rev` shows up as a hit. The existing pair (`this\.driver\.[a-zA-Z]+\(blockId` must return nothing; `implements\s+IRawStorage` must return exactly one line) are the model.

## The backend's read-side filter follows the rule

`listPendingActionIds`' hand-rolled `^(?:tx:|stamp:)?[A-Za-z0-9_-]+$` is what arm 4 is: a second, narrower opinion about what an action id may be. Replace it with `isValidActionId` on the decoded name. That keeps the filter's actual purpose — junk in `pend/` (an orphan `*.tmp`, a decoded name with a stray `%`, a path-ish name, anything an older build left) must not read as a phantom pending — while admitting everything the write path accepts, so a record the backend wrote is a record the backend lists. Its comment should then say that the filter and the write rule are the same rule rather than restating a charset, and keep the note that the memory and database backends key on the raw id and never see a filename.

## Weighed and rejected

**Encode more characters in `encodeActionIdForFilename` instead of refusing an id.** It keeps every id a peer can name working and needs no new rejection, but it changes on-disk filenames, has to stay compatible with the files already there and with the listing filter, and leaves the other backends unprotected — arm 8's LevelDB fault is not an fs problem at all. The kernel refusal is one check covering all five backends, parallel to the block id's, and is what Invariant 7 already promises. Not adopted. The encoding question that remains is only about characters that are legal but awkward, which is the colon, and is already handled.

**A charset rule for action ids.** Rejected on evidence: it would refuse `~proof:5` and `tx:café—🔒—Ω`, both of which the system uses today. See the survey above.

## TODO

- Add `packages/db-core/src/collection/action-id.ts`: `isValidActionId`, `assertValidActionId`, `InvalidActionIdError`, documented clause by clause with the reason each clause is there — the model is `packages/db-core/src/blocks/block-id.ts`, which states its reasons and its two accepted win32 limits inline. Export from `packages/db-core/src/collection/index.ts`.
- Add the revision rule — `isValidRevision` / `assertValidRevision` / `InvalidRevisionError` — in `packages/db-core/src/blocks/revision.ts` (or beside the block-id rule if that reads better; what matters is that Invariant 7 can name all three in one breath). Export it.
- Add `MAX_STORED_ID_LENGTH` in `packages/db-core/src/blocks/block-id.ts` (no imports there, so no cycle with `collection/`), apply it in `isValidBlockId` as well as `isValidActionId`, and state the headroom arithmetic against the log's 65535-byte path cap in its comment.
- Name `checkedActionId` and `checkedRev` from every `KvRawStorage` forward listed under *The enforcement point*, reads included, and extend the class comment: why the check sits above the write group, and the new inspection grep.
- Replace `listPendingActionIds`' charset filter in `packages/db-p2p-storage-fs/src/file-batch-backend.ts` with `isValidActionId`, and rewrite its comment to say the filter is the write rule rather than a second opinion.
- Note the injectivity that the `%` clause buys at `encodeActionIdForFilename` / `decodeFilenameToActionId`, where the colon encoding is explained.
- Correct `containedTarget`'s doc comment in `packages/db-p2p-storage-fs/src/file-write-log.ts`: it currently cites this ticket as open and names the action-id gap as live. It stays as the guard for a pre-fix store's log and for a log forged on disk; say what it is now for.
- Reconcile the "never re-derived or format-checked" wording where it appears (`raw-store-driver.ts`'s `getProof`, the commit-proofs keyspace comment in `kv-raw-storage.ts`) so the keyspace-separation decision reads as intact and `~proof:5` reads as still legal.
- Widen Invariant 7 in `packages/db-p2p/docs/storage.md`: the statement over all three identifiers, the single enforcement point, the guards that remain below it and why, what breaks without it (arms 1, 3 and 4 are the three distinct harms: a remote write-stop, an arbitrary `.json` read, and a legitimate pending the fs backend cannot see), and what it still does not reach. Retire the "What this does NOT address" paragraph that names this ticket. Rename the heading to match the widened statement. Also fix the recoverability wording wherever a latched fs store is described — arm 2 measured it.
- Settle the rev edges while implementing: whether `0` is legitimately passed (assume yes) and whether anything legitimately reaches a negative rev; fix the caller rather than widen the rule, and say which in the handoff.
- Tests, one behaviour each, nothing more: a boundary table for `isValidActionId` in `packages/db-core/test/action-id.spec.ts` (the accept/reject tables with a reason per row, as `block-id.spec.ts` does — this is the one place the edges are pinned, including the `%` alias and the length bound), and one case in `packages/db-p2p/src/testing/raw-storage-conformance.ts` asserting the cross-backend consequence: a write under an escaping action id is refused, a *read* under one is refused, and the store still takes an ordinary write afterwards. Do not restate the boundary table in the backend suites. Add an fs-only case only if the read refusal genuinely cannot be asserted from the shared suite.
- Per `tickets/rules/testing.md`, run only what reproduces this: the new db-core spec, and the fs and memory conformance runs. The full suites belong to review — but note in the handoff that `db-p2p-storage-ns`, `-rn` and `-web` all consume the changed shared conformance suite and that `-ns` and `-rn` carry the two action ids from arm 4 and arm 8's `BigInt(rev)` respectively, so review should run all three.
