description: Three places in the node keep a small list of things to do later, each stored as one small record per item in the node's key-value store. All three were written separately and repeat the same scaffolding, so a bug fixed in one does not reach the other two and a fourth such list will be copied again.
files: packages/db-p2p/src/blob/owed-blob-ledger.ts, packages/db-p2p/src/repo/kv-under-replication-ledger.ts, packages/db-p2p/src/storage/released-block-ledger.ts, packages/db-p2p/src/keyed-serial-queue.ts, packages/db-p2p/src/storage/node-kv-namespaces.ts
tradeoffs: Three similar classes that each read straightforwardly may be easier to work on than one generic base with three sets of entry rules threaded through it, and a shared base invites the next ledger to inherit behaviour it does not want.
----

# Three key-value ledgers repeat the same record shape

## What these three are

The node keeps three separate "things I still owe" lists, each as one JSON record per item under its own key prefix in the node's key-value store:

- `OwedBlobLedger` (`packages/db-p2p/src/blob/owed-blob-ledger.ts`, 317 lines) — blobs this node owes a copy of.
- `KvUnderReplicationLedger` (`packages/db-p2p/src/repo/kv-under-replication-ledger.ts`, 337 lines) — blocks known to be held by too few machines.
- `ReleasedBlockLedger` (`packages/db-p2p/src/storage/released-block-ledger.ts`, 280 lines) — blocks this node handed over and may delete.

Measured with `wc -l` at the commit that added the third (`ticket(implement): a-node-deletes-what-it-released`): 934 lines across the three files.

## What is duplicated

Each of the three independently carries the same six constructs, in the same order, with the item's id as the only varying part:

- a `KeyedSerialQueue` so each read-modify-write of one item's record is atomic against another caller's,
- a module-level `keyFor(id)` that concatenates the prefix,
- a `private read(id)` that gets the key and hands the bytes to a parser,
- a `parseEntry(id, raw)` that `JSON.parse`s, validates, and treats anything malformed as absent with a log line,
- an `isEntryFor(id, value)` type guard checking the id matches and each field has the right primitive type,
- a `list()` that scans the prefix, strips it back off each key, re-reads each record one at a time, and
- a `flushWrites()` that is `this.kv.flush?.()` and the per-method decision of whether to call it.

They have already drifted in ways that are accidental rather than chosen. The newest one refuses a key that is the bare prefix and logs it; the older two would try to parse it as a record. Two of the three carry the same note about `list()` being a full scan. Each decides separately which of its writes are flushed before returning and which are deliberately not.

## What resolving this should establish

One place that owns "a JSON record per id under one key prefix in the node's key-value store", with each ledger supplying only its prefix, its entry type and its validation — so that the scan, the id/key round-trip, the malformed-record rule, the serialisation guard and the flush contract are decided once and a fix to any of them reaches all three. The fourth such list should then be a type and a validator, not another 300-line file.

Worth settling at the same time, because they are the parts that have drifted: whether the bare-prefix key guard belongs to all three (it does), and whether "durable before it returns, except where the record is only a retry counter" is a rule the shared layer states rather than three files each arguing it locally.

No behaviour change is wanted. The existing specs for the two older ledgers are what should keep it honest.
