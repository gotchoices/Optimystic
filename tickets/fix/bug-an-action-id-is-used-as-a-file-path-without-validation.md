description: A machine on the network gets to choose the name of the write it sends, and the receiving machine uses that name as part of a file path — so a crafted name makes the receiver's storage refuse every further write until it is restarted, and lose the writes it had not yet filed away.
architecture: packages/db-p2p/docs/storage.md#7-a-block-id-reaching-a-backend-names-a-location-inside-the-store
files: packages/db-core/src/blocks/block-id.ts (where the sibling rule for block ids lives), packages/db-core/src/collection/action.ts (`ActionId`), packages/db-p2p/src/storage/kv-raw-storage.ts (`checkedId` — the one enforcement point), packages/db-p2p-storage-fs/src/file-batch-backend.ts (`relativeActionScopedPath`, `encodeActionIdForFilename`, `listPendingActionIds`), packages/db-p2p-storage-fs/src/file-write-log.ts (`containedTarget`), packages/db-p2p/src/repo/service.ts (the inbound decode that checks nothing), packages/db-p2p/docs/storage.md (Invariant 7)
repro: verified
----

# An action id is used as a file path without validation

## What an action id is, and who picks it

Every write carries an **action id** — the name of that one write, so a machine can say "the write called `tx:AbC…`". The writer picks it; the machine that stores the write never re-derives or checks it. That is deliberate and documented (`getProof` in `packages/db-p2p/src/storage/raw-store-driver.ts` explains that proofs keep their own keyspace precisely *because* an action id can be anything a peer says). Nothing on the inbound path narrows it either: the request is `JSON.parse`d and cast (`handleIncomingStream` in `packages/db-p2p/src/repo/service.ts`), and the only structural check (`batchShapeFault` in `packages/db-p2p/src/cluster/record-operations.ts`) uses the action id purely as a set-equality key.

The filesystem backend then uses that name **as a path segment**: a pending record for block `held` under action `tx-ok` is the file `held/pend/tx-ok.json` (`relativeActionScopedPath` in `packages/db-p2p-storage-fs/src/file-batch-backend.ts`). The only transformation applied is percent-encoding of colons, for Windows (`encodeActionIdForFilename`); `/`, `\` and `..` pass through untouched.

So the filesystem backend has two wire-supplied names in every record's path, and only one of them has a rule. The sibling ticket `bug-a-block-id-is-used-as-a-file-path-without-validation` gave **block ids** a rule (`isValidBlockId` in `packages/db-core/src/blocks/block-id.ts`) and one enforcement point (`checkedId` in `packages/db-p2p/src/storage/kv-raw-storage.ts`, which every shipping backend sits under). Action ids were out of its scope and have no rule at all.

## What goes wrong

**Measured, on this build.** Driving `FileRawStorage` — the real kernel over the real backend — with a legitimate block id and the action id `../../../escaped`:

```
store failed: a commit of its writes rejected (write-ahead log record names
"held/pend/../../../escaped.json", which is not inside <store>); every later write
and flush is refused until the store is reopened
```

The next perfectly ordinary write on that store fails with the same error. That is a **remote denial of service against one node's storage**: one request, and the node stops accepting writes until a human restarts it. The record is already in the write-ahead log by then, so reopening gets the store back but ends the log's replay at that record — every legitimate record appended after it is discarded.

What stopped the write from landing outside the store is the write-ahead log's containment guard (`containedTarget` in `packages/db-p2p-storage-fs/src/file-write-log.ts`), which the sibling ticket added for pre-fix stores and forged logs. It sits on the live commit path, where a throw is a storage fault and latches the store by contract (rule 5 of the flush contract, `RawStoreDriver.flush`) — which is exactly why the block-id check was placed *above* the driver rather than left to a path guard. Before that guard existed, the same request wrote a file outside the store instead (a sibling of the store directory, anywhere the process may write) — so the shape of the harm has changed from "writes where it pleases" to "stops the node", but the hole is the same hole.

**A second symptom of the same gap, not separately verified.** `listPendingActionIds` filters the filenames it enumerates to `[A-Za-z0-9_-]+` with an optional `tx:`/`stamp:` prefix, logging and skipping anything else, because junk in `pend/` must not read as a phantom pending. An action id outside that class (one carrying a dot, say) is therefore **written and then never enumerated** — so a `pend` that should conflict with it does not see it. Reached by reading the code, not by running it.

**A third, same class, unverified.** `relativePath` also interpolates a revision number into the path (`${blockId}/revs/${rev}.json`). `rev` is declared `number` but arrives from the same unchecked `JSON.parse`. Whether a non-numeric `rev` survives the revision comparisons on the way down to storage was not traced; worth settling in the same pass, since the answer is the same rule in the same place.

## What should be true

One statement, extending Invariant 7 of `packages/db-p2p/docs/storage.md` from "a block id reaching a backend names a location inside the store" to every wire-supplied name a backend turns into a path:

> An identifier that reaches a `RawStoreDriver` — block id, action id — names a location inside the store, and the node refuses the request before any driver is touched if it does not.

"Before any driver is touched" is the part that matters and the part the write-ahead log's guard cannot provide: a refusal has to reject that one request and leave the store serving, not latch it.

Two things the rule must not break:

- **Colons are legitimate.** Real action ids are `tx:<base64url>` and `stamp:<base64url>` (`createTransactionId` in `packages/db-core/src/transaction/transaction.ts`), plus legacy UUIDs and the bare alphanumerics the cross-backend conformance suite uses. A containment rule, not a charset, is what is wanted — the backend already percent-encodes the colon for Windows.
- **Stores on disk already hold these names.** Whatever is decided applies to the write path; files already written under older builds must stay readable, as they do today through the raw-colon fallback in `readActionScopedBytes`.

An alternative worth weighing before implementing: instead of refusing an id, make `encodeActionIdForFilename` encode every path-unsafe character the way it already encodes the colon. That keeps every id a peer can name working and needs no new rejection, but it changes on-disk filenames, has to stay compatible with the files already there and with `listPendingActionIds`'s filter, and leaves other backends' keyspaces unprotected — whereas the kernel refusal is one check covering all five backends, parallel to the block id's, and is what Invariant 7 already promises. Recommend the kernel refusal; the encoding question is then only about the characters that are legal but awkward (the colon today).

Note also that a rule here does **not** contradict the documented "an action id is never re-derived or format-checked" stance: nothing proposed here re-derives an id or constrains what a writer may call its write beyond "it must not name somewhere else on the disk". The keyspace-separation decisions made on the strength of that stance stay as they are.
