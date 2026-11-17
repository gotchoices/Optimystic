# Blobs: large values outside transactions

**Status: proposed design. Nothing in this document is implemented yet.** It is the design of record for native large-value support (GitHub #63, and the Quereus side of the same request, gotchoices/quereus#40). Each section says what is to be built; the tickets that build it cite the section they serve.

A **blob** is an immutable sequence of bytes of known size, such as a photo, a video or a document. A row holds a short **reference** to it. The bytes are stored and moved by their own subsystem: they are never encoded as JSON, never enter a transaction, a log entry or a consensus record, and are copied between machines in small pieces that can be resumed and checked one at a time.

## Why

A large value written through SQL today is a base64 string inside a row inside a transaction (`RowCodec` in `packages/quereus-plugin-optimystic/src/schema/row-codec.ts`). Measured in GitHub #63:

- **Time.** About 1.7 s per MB on loopback with no network in the way, nearly all of it JSON encoding, canonicalization, hashing and cloning of the whole value on every hop.
- **Space.** Each value travels 2.75 to 3.4 times its size: base64, then once in the block it changes and again in the log entry that records the action. A transaction limited to `MAX_TRANSACTION_BYTES` (`packages/db-core/src/network/transaction-size.ts`) therefore holds about 2 MB of file data.
- **Slow links.** A transaction has one time budget whatever its size, and a retry resends all of it. On a cellular link through a relay, a 3 MB transaction never committed, and everything queued behind it waited.
- **Memory.** The whole value is materialized to read or write any part of it.

Sereus Chat works around this in the application (two content-keyed tables of chunk rows, one chunk per transaction). The workaround still pays the per-byte cost and the encoding, and cannot reclaim anything.

What this design does **not** change: an ordinary transaction is still limited to one frame ([internals.md §A transaction's size limit](internals.md#a-transactions-size-limit)), and its deadlines are still fixed (backlog `feat-link-deadlines-stretch-to-measured-response-time`). Blobs remove large content from transactions; they do not make large transactions work.

## Design principles

- **Content addressing.** A reference names bytes, not a place. Everything received is checked against the reference, so no signature, commit proof or trusted sender is needed to accept a piece, and equal content is stored once.
- **Bytes stay bytes.** No base64, no JSON, no canonicalization and no cloning of content, in storage or on the wire. Content is hashed once when written and once when received.
- **Small, independent pieces.** A piece is the unit of storage, transfer, verification and retry. A transfer that stops loses at most the piece in flight.
- **Outside consensus.** The cohort agrees on the reference, which is an ordinary column value. No member votes on whether the bytes have arrived.
- **Known but not here is an ordinary state.** A reference whose bytes are not on this machine is reported as such, with a reason, and can be fetched. It is never a missing-block error.
- **One placement rule.** The machines responsible for a blob are chosen the way a block's are: the key network's cohort at the blob's coordinate.
- **db-core stays network-free.** Reference format, tree shape, verification and planning are pure logic in `db-core` behind ports; storage and transport bind in `db-p2p`, the split the cohort-topic subsystem uses (`packages/db-core/test/no-fret-import.spec.ts`).

## References and pieces

A **piece** is up to `P` bytes, where `P = 2^pieceBits`. A piece is named by the SHA-256 of its bytes. `pieceBits` is 18 by default (256 KiB, the size Sereus Chat found workable on a cellular link through a relay) and may be 16 through 20.

A blob's pieces form a tree whose shape is fixed by the blob's size and `pieceBits`:

- **Data pieces** hold the content in order: every one exactly `P` bytes except the last, which holds the remainder. A blob of zero bytes has one empty data piece.
- **List pieces** hold the concatenated 32-byte hashes of their children, up to `P / 32` children each (8192 at the default), so a list piece is never larger than a data piece and is stored and moved the same way.
- Levels are built until one piece remains. Its hash is the **root**. A blob of at most `P` bytes has no list piece: its root is the hash of its one data piece.

```
size = 600 KiB, pieceBits = 18          root = sha256(list)
                                              │
                                   list: h0 ‖ h1 ‖ h2   (96 bytes)
                                     │      │      │
                                   256K   256K    88K    data pieces
```

At the default, one list piece covers 2 GiB and two levels cover 16 TiB.

A **blob reference** is a string:

```
oblob:1:<pieceBits>:<size>:<root>
```

`1` is the format version (it fixes SHA-256 and the tree rule), `pieceBits` and `size` are canonical decimal, and `root` is base64url without padding. A reference has exactly one spelling, so references compare as strings. The prefix names this store: an application that already holds references of its own (Sereus Chat's `chunks:1:` references) dispatches on the prefix and keeps reading the old ones.

The reference carries the size and the piece size because the tree's shape, and so what every piece must look like, follows from them. A reader knows for each hash whether it names a data piece or a list piece and exactly how long that piece must be, so a piece of the wrong kind or length is refused even though its hash matches. The same bytes written with two different `pieceBits` are two different references; writers use the default unless they have a reason.

**Verification.** A reader checks the root piece against the reference, each list piece's length against the shape, and each child against the hash its parent lists, top down. A byte range needs only the pieces on its path. A writer builds the tree bottom up from a stream, holding one piece and one partial list piece per level.

**Hashing** goes through one injected port (bytes in, 32 bytes out, asynchronous). The default uses the platform's native digest (`crypto.subtle`) where there is one and falls back to JavaScript. A host may supply its own (React Native), and a supplied digest is checked against known answers once when installed. Pure JavaScript hashing measured 19 s per MB on an older phone, so the port is not optional in practice.

## The local store

Each node keeps two things.

**A piece store.** A map from piece hash to bytes, immutable once written, behind a small interface of its own (`IPieceStore`): has, get, put, delete, list, bytes used, flush. It is deliberately not another logical store of `RawStoreDriver` (`packages/db-p2p/src/storage/raw-store-driver.ts`): that kernel JSON-encodes every value and stages writes in an in-memory overlay and a journal, which is right for small versioned records and wrong for megabytes of immutable bytes that need no cross-key atomicity. Each storage package supplies an implementation beside its block store (files, a SQLite table, an IndexedDB object store, a LevelDB key range read as bytes), and one conformance suite runs against all of them. A host passes it to the node as it passes block storage; the default is in memory. A piece is written only after its hash has been checked, and a put of a hash already present writes nothing.

**Blob records.** One small record per blob this node has a reason to hold, in the node's key-value store: the reference, whether every piece is present, when it was last read, and its **holds** (below). Records are what make the node's set of blobs enumerable after a restart.

Piece bytes count toward the node's reported storage use, so capacity-driven decisions see them.

### Holds

A node keeps a blob only while some hold names it. There are four kinds:

| Hold | Meaning | Released when |
|---|---|---|
| **pin** (with an owner label) | The application, or the SQL layer on behalf of an open or queued transaction, needs it here. | The owner unpins it. |
| **owed** | This node wrote or announced it and its cohort does not fully hold it yet. | Every cohort member that accepts blobs confirms it holds it. |
| **responsible** | This node is in the blob's cohort and accepts blobs. | The node leaves the cohort and enough others hold it, or the blob is reclaimed ([Lifetime](#lifetime)). |
| **cached** | It was fetched for a read. | Evicted, least recently read first, to stay within a cache budget. |

Pieces are shared between blobs. A piece is deleted only by a sweep that finds it in no held blob's tree.

## The node's blob service

A node exposes one handle, `node.blobs`, declared on `OptimysticNodeAttachments` (`packages/db-p2p/src/optimystic-node.ts`). Its interface is defined in `db-core`:

```ts
interface BlobService {
	/** Store a stream as a blob. Resolves once every piece is durable on this node. */
	put(source: AsyncIterable<Uint8Array>, options?: BlobPutOptions): Promise<BlobPutResult>;
	/** What this node knows about a blob, without fetching content. */
	stat(ref: BlobRef, options?: { probe?: boolean }): Promise<BlobStat>;
	/** The bytes, or a range of them, in order; fetches what is not here unless told not to. */
	read(ref: BlobRef, options?: BlobReadOptions): AsyncIterable<Uint8Array>;
	/** Bring the whole blob here ahead of a read. */
	fetch(ref: BlobRef, options?: BlobFetchOptions): Promise<void>;
	pin(ref: BlobRef, owner: string): Promise<void>;
	unpin(ref: BlobRef, owner: string): Promise<void>;
	/** Tell the blob's cohort about it, optionally naming what keeps it alive. */
	announce(ref: BlobRef, retention?: BlobRetention): Promise<void>;
	onProgress(listener: (event: BlobProgressEvent) => void): () => void;
	onDurability(listener: (event: BlobDurabilityEvent) => void): () => void;
}

interface BlobPutOptions { pieceBits?: number; owner?: string; retention?: BlobRetention; replicate?: boolean; signal?: AbortSignal }
interface BlobPutResult { ref: BlobRef; size: number }
interface BlobReadOptions { offset?: number; length?: number; from?: 'anywhere' | 'here'; waitMs?: number; signal?: AbortSignal }
interface BlobStat { ref: BlobRef; size: number; locality: 'here' | 'partial' | 'elsewhere' | 'unknown'; heldBytes: number; durability?: BlobDurability }
type BlobRetention = { scope: string } | { keep: true } | undefined;
```

- **`put`** reads the source one piece at a time, hashes and stores each, and never holds more than a piece and its list pieces in memory. It resolves when the blob is durable *here*, which is the same promise an offline commit makes. Copying to other machines happens afterwards in the background and is reported through `onDurability`; a caller that wants to wait for it can.
- **`stat`** answers from local records. With `probe` it also asks the blob's cohort, which is what distinguishes `elsewhere` (someone reachable holds it) from `unknown`.
- **`read`** yields verified bytes. Pieces not held are fetched from other holders as the read reaches them, and kept under a `cached` hold. `waitMs` keeps a read trying while the bytes are still arriving somewhere; without it a read fails at the first piece nobody reachable holds.
- **Failures are typed.** `BlobUnavailableError` carries the reference and a reason: `not-here` (the read said `from: 'here'`), `not-held` (every holder asked answered that it does not have it), `peers-unreachable` (some of them did not answer), `cohort-unreachable` (none could be asked). All four mean "not yet", and are the blob counterpart of `BlockUnavailableReason` in `packages/db-core/src/network/struct.ts`. `BlobCorruptError` means a holder served bytes that fail verification and no other holder could supply them. `BlobRefError` means the string is not a reference.

Optimystic owns no file access. A host turns a picked file into a stream for `put` and writes the stream from `read` where it wants it.

## Moving pieces between machines

One new protocol, `<prefix>/db-p2p/blob/1.0.0`, registered like the node's other services. It is the first protocol here that carries more than one frame per stream and the first that carries raw bytes, so it does not go through `ProtocolClient` (`packages/db-p2p/src/protocol-client.ts`), whose single reply and one-time resend assume a small request and answer. Frames are length-prefixed. The first frame in each direction is a small JSON header; a piece is one frame of raw bytes.

| Request | Answer |
|---|---|
| `stat` — references | For each: `whole`, `partial` or `none`. |
| `get` — up to 16 piece hashes | A header saying which are held, then one raw frame per held piece, in the order asked. |
| `announce` — a reference and its retention | `whole` (already held), `fetching` (will pull it) or `declined`. |
| `held` — a reference | Empty. Sent to a peer that announced, when the pull completes. |

**Content moves by `get` only, and the receiver always pulls.** A node that wants a blob copied to another machine announces it; the other machine decides whether to take it and then fetches at its own pace. There is no push of content, so a node never has to accept, buffer or verify bytes it did not ask for, and there is one code path that receives and checks pieces.

**Resumption** follows from the pieces: each one is verified and stored as it arrives, so a fetch that is interrupted asks only for what is still missing, from the same peer or another.

**Deadlines follow progress, not size.** A `get` has no total time limit. It is abandoned when no bytes have arrived for one response timeout of the declared link (`LinkDeadlines` in `packages/db-p2p/src/rpc-deadline.ts`), measured between any two chunks of bytes, not between whole pieces. The sender applies the same limit to a stream it cannot write to, and waits for the stream to drain when the transport reports its buffer full. A dead path still fails within one timeout; a slow one finishes.

**Other traffic is not held up.** Background copying uses at most one `get` stream per peer and a small number per node, 16 pieces at most per stream, so the stream multiplexer can interleave transaction and read traffic between pieces. A read the application is waiting on goes ahead of background copying.

**Trust.** The protocol is gated by `authorizeInboundStream` like the four database protocols (`createInboundStreamAuthorization` in `packages/db-p2p/src/inbound-authorization.ts`), and a node announces to, and fetches from, only peers its network membership predicate admits. Within those bounds any member can fetch any piece whose hash it knows. A peer that serves bytes failing the requested hash is penalized (`PenaltyReason` in `packages/db-p2p/src/reputation/types.ts`, the reason existing repair paths use for unverifiable content): the stream is authenticated and the fault is attributable.

**Relays.** A circuit relay with stock limits resets a relayed stream after 128 KiB. A blob cannot cross such a relay; the fetch fails, keeps what it stored, and resumes when a direct or unlimited path exists.

## Placement, copying and durability

**Who is responsible.** A blob's routing key is the bytes of its root hash; the key network turns it into a coordinate and a cohort exactly as it does for a block (`routingKeyForBlock` in `packages/db-core/src/network/routing-key.ts` gains a sibling for blobs). A node may be configured not to take blobs it is merely responsible for (`blobs.hold: 'on-demand'`, against the default `'eager'`): such a node declines announcements, and holds only what it wrote, pinned or read. This is how a phone joins a group without storing every file in it.

**Copying.** When a blob is put (unless `replicate: false`) or announced, the node records a durable **owed entry**: the reference, its retention, and the cohort members not yet known to hold it. A drain announces the blob to each owed member that is connected, on start, when a peer connects or is identified, and on a timer while anything is owed, skipping passes during a detected partition. It is the same schedule, give-up rule and membership filter as `UnderReplicationDrain` (`packages/db-p2p/src/repo/under-replication-drain.ts`), and the two share that scheduling code rather than repeating it. A member is taken off the entry when it reports `whole` or sends `held`. A member that declines is remembered as declining and is not owed.

**Durability** is reported in the classes a commit uses (`DurabilityQuorum` in `packages/db-core/src/network/struct.ts`), counted over the cohort members that accept blobs: `full` when every one holds it, `majority`, `local` when only this node does, `unrouted` when the cohort could not be resolved. Each change is an `onDurability` event, and reaching `full` removes the owed entry and its hold. In a group where no other member accepts blobs the class stays `local` and the writer keeps the blob; readers fetch it from the writer on demand.

**When the cohort changes.** A node's held blobs are enumerable from its records, so the cohort comparison `RebalanceMonitor` (`packages/db-p2p/src/cluster/rebalance-monitor.ts`) makes for blocks is made for blobs too, by giving it the routing key rule rather than a second copy of its logic. A member that joins a held blob's cohort is announced to. A node that leaves a blob's cohort drops its `responsible` hold only after confirming that enough current members hold the blob.

**Readers repair.** A node that is responsible for a blob, accepts blobs, and fetches it for a read keeps it under a `responsible` hold.

## Committing a reference

The transaction that commits a row carries only the reference. Its relation to the bytes is:

- **The reference can land before the bytes.** No member checks availability when it votes. Checking would tie consensus to bulk transfer and would make an offline commit impossible.
- **The writer keeps what it wrote.** From `put` until its cohort fully holds the blob, the writer holds it under `owed`; while a transaction that references it is open or queued, the SQL layer also holds it under a pin. So a committed reference is always backed by at least the writer's copy, and a reader that cannot reach it sees "not yet", not a broken file.
- **A reader decides how long to wait.** `stat`, `read` with `waitMs`, and the typed reasons give an application what it needs to show "still arriving".

## SQL

The plugin adds a logical type, **`blobref`**: text whose value must be a well-formed reference. A column of that type is an ordinary value to the engine, to conflict resolution and to the wire.

```sql
create table Attachment (
	Id text primary key,
	Name text,
	Content blobref null
);
```

```ts
const { ref } = await plugin.blobs.put(fileStream);
await db.exec('insert into Attachment (Id, Name, Content) values (?, ?, ?)', [id, name, ref]);
for await (const bytes of plugin.blobs.read(ref)) { /* … */ }
```

- **`plugin.blobs`** is the node's blob service for the plugin's network, with `put` pinning on behalf of the current transaction.
- **A reference tree per table.** For a table with a `blobref` column the plugin maintains one more tree collection beside the table's index trees, `<table>/blobrefs`, keyed by reference then primary key then column. It is staged in the same transaction as the row, the way `IndexManager` (`packages/quereus-plugin-optimystic/src/schema/index-manager.ts`) stages index entries, so "which rows reference this blob" is a range read of committed state. It exists for [Lifetime](#lifetime).
- **Pins follow the transaction.** A reference staged by a statement is pinned under the transaction's identity. The pin is released when the transaction commits (after announcing the blob with the reference tree as its scope), rolls back, or, for a queued offline transaction, settles. Pins are stored in the blob records and reconciled against the offline queue on restore.
- **SQL functions.** `BlobSize(ref)` (read from the reference) and `BlobLocality(ref)` (the local `stat`). Content does not pass through SQL.

Existing `blob` columns are untouched: values stay inline, base64 in the row, and keep reading. Two further steps build on the explicit type and are separate work:

- **Out-of-line storage of plain `blob` values.** A `blob` value over a threshold is stored as a blob and its reference kept in the row, invisibly to SQL. This removes the size limit and most of the cost for existing schemas, but a row read then depends on a fetch.
- **Streaming through the engine.** Reading or writing a range of a column value by table, key and column needs an interface Quereus does not have (gotchoices/quereus#40).

## Lifetime

Nothing reclaims block storage today, so a blob that is never reclaimed is no worse than a base64 value in a row. Reclaiming is still designed in, because blobs are where the bytes are.

- **Cached blobs** are evicted under a budget, least recently read first. This is local and needs no agreement.
- **Retention** is what an announcement says keeps a blob alive at its responsible holders: a **scope** (the id of a reference tree), **keep** (held until the holder leaves the cohort; for applications that manage references themselves), or neither, which makes the blob **provisional**.
- **Provisional blobs** are kept for a grace period after the last announcement (7 days by default) and then reclaimed. This covers a transaction that put a blob and rolled back.
- **Scoped blobs** are reclaimed by each holder on its own reading of committed state: when the reference tree has held no entry for the blob at two checks a grace period apart, the holder drops its `responsible` hold. No message from another peer deletes anything. A blob named under several scopes is kept while any of them references it.
- **A reference that outlives its bytes** is possible only where the reference tree no longer lists it: an old revision of a row read from history. Such a read reports the blob as not held.
- **Late commits are safe.** A transaction queued longer than the grace period still has the writer's pinned copy, and its commit announces the blob again with its scope.

## Platforms and limits

- A piece at the default size is below every per-value limit the storage backends are known to have, including NativeScript's 512 KiB threshold for large JNI results.
- React Native's LevelDB store reads values as text for the block store; its piece store reads bytes.
- Browsers store pieces in IndexedDB; adding the object store is a database version change.
- A blob's size is limited only by a JavaScript safe integer.

## Compatibility

The change is additive. A node on an older build does not register the blob protocol; peers see that from its protocol list and treat it as a member that does not accept blobs. Stored data gains a piece store and new key-value namespaces, and loses nothing, so an older build's data opens unchanged. A table that declares a `blobref` column cannot be opened by a plugin that predates the type; adopting the type is a schema change an application rolls out like any other.

## What this answers in GitHub #63

| Ask | Answer |
|---|---|
| Skip the canonicalize, hash and clone passes for large values | A blob is hashed once per machine and never encoded, canonicalized or cloned. |
| Carry a value once, not two to three times | A piece travels once, as raw bytes; the row and its log entry carry a reference of about 70 characters. |
| Deadline by progress, not a fixed total | True of blob transfer. Transaction deadlines are unchanged. |
| Retries that resume | A fetch resumes at the missing piece. |
| A write of any size should work without the application cutting it up | True of content. A transaction of ordinary rows is still limited to one frame. |

The expected cost is one hash and one store write per piece on the writer, the same on each receiver, and a wire size of the content plus 32 bytes per piece. The work that builds the transfer measures time per MB and bytes on the wire against the #63 script's shape and states the result here.
