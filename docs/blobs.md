# Blobs: large values outside transactions

**Status: proposed design. Nothing in this document is implemented yet.** It is the design of record for native large-value support (GitHub #63, and the Quereus side of the same request, gotchoices/quereus#40). Each section says what is to be built; the tickets that build it cite the section they serve.

A **blob** is an immutable sequence of bytes, such as a photo, a video or a document. A row holds a short **reference** to it. The bytes are stored and moved by their own subsystem: they are never encoded as JSON, never enter a transaction, a log entry or a consensus record, and are copied between machines in small pieces that can be resumed and checked one at a time.

In one sentence: **blobs are stored the way IPFS stores files, placed by FRET instead of provider records, fetched only by members of the network, and kept alive by the database** — a machine holds a blob for others exactly as long as a committed row references it.

## Why

A large value written through SQL today is a base64 string inside a row inside a transaction (`RowCodec` in `packages/quereus-plugin-optimystic/src/schema/row-codec.ts`). Measured in GitHub #63:

- **Time.** About 1.7 s per MB on loopback with no network in the way, nearly all of it JSON encoding, canonicalization, hashing and cloning of the whole value on every hop. Removing the repeated passes brought it to about 0.2 to 0.3 s per MiB on an in-process two-node mesh over memory storage; what remains is the encoding, hashing and storing the format needs on each machine ([internals.md §A transaction's size limit](internals.md#a-transactions-size-limit), *What a large value costs*).
- **Space.** Each value travels 2.75 to 3.4 times its size: base64, then once in the block it changes and again in the log entry that records the action. A transaction limited to `MAX_TRANSACTION_BYTES` (`packages/db-core/src/network/transaction-size.ts`) therefore holds about 2 MB of file data.
- **Slow links.** A transaction has one time budget whatever its size, and a retry resends all of it. On a cellular link through a relay, a 3 MB transaction never committed, and everything queued behind it waited.
- **Memory.** The whole value is materialized to read or write any part of it.

Sereus Chat works around this in the application (two content-keyed tables of chunk rows, one chunk per transaction). The workaround still pays the per-byte cost and the encoding, and cannot reclaim anything.

What this design does **not** change: an ordinary transaction is still limited to one frame ([internals.md §A transaction's size limit](internals.md#a-transactions-size-limit)), and its deadlines are still fixed (backlog `feat-link-deadlines-stretch-to-measured-response-time`). Blobs remove large content from transactions; they do not make large transactions work.

## Design principles

- **Content addressing, in IPFS's formats.** A reference is a content identifier (CID). Everything received is checked against it, so no signature, commit proof or trusted sender is needed to accept a piece, equal content is stored once, and what a node stores are ordinary IPFS blocks that IPFS tools can read.
- **Bytes stay bytes.** No base64, no JSON, no canonicalization and no cloning of content, in storage or on the wire. Content is hashed once when written and once when received.
- **Small, independent pieces.** A piece is the unit of storage, transfer, verification and retry. A transfer that stops loses at most the piece in flight.
- **Outside consensus.** The cohort agrees on the reference, which is an ordinary column value. No member votes on whether the bytes have arrived.
- **The database decides what is alive.** A machine stores a blob on another machine's behalf only when committed state references it, and stops when committed state no longer does. There is no lease to renew and no expiry clock.
- **Known but not here is an ordinary state.** A reference whose bytes are not on this machine is reported as such, with a reason, and can be fetched. It is never a missing-block error.
- **One placement rule.** The machines responsible for a blob are chosen the way a block's are: the key network's cohort at the blob's coordinate.
- **db-core stays network-free.** Formats, verification, reference trees and planning are pure logic in `db-core` behind ports; storage and transport bind in `db-p2p`, the split the cohort-topic subsystem uses (`packages/db-core/test/no-fret-import.spec.ts`).

## References and pieces

A blob is stored as an IPFS file is, with the parameters current IPFS tools use by default:

- **Pieces.** The content is cut into pieces of 256 KiB (the last one shorter). Each is a raw IPFS block, named by the SHA-256 of its bytes. 256 KiB is also the size Sereus Chat found workable on a cellular link through a relay.
- **List pieces.** A blob of more than one piece has a tree above its pieces: UnixFS file nodes (the `dag-pb` codec), each listing up to 174 children with their sizes, balanced, built until one node remains. A list piece is a few kilobytes and is stored and moved like any other piece.
- **The reference** is the CID of the root: version 1, SHA-256, written in lowercase base32. A blob of one piece is referenced by that piece's CID directly. A reference has exactly one accepted spelling, so references compare as strings.

```
600 KiB file                       bafybei…   (the reference: CID of the list piece)
                                      │
                         list: [bafkrei…a 256K, bafkrei…b 256K, bafkrei…c 88K]
                                   │           │           │
                                  256K        256K        88K     raw pieces
```

One list piece covers about 44 MiB at these parameters, two levels about 7.4 GiB, three about 1.3 TiB.

Choosing IPFS's formats over a private one costs a little (a list piece is protobuf rather than bare hashes, and the size is in the root piece rather than in the reference) and buys three things: the formats and their edge cases are already specified and tested elsewhere; the libraries exist and are small (`multiformats`, already a dependency of `db-core`, plus the dag-pb and UnixFS codecs); and a node's pieces are valid IPFS blocks, so content can be exported to or imported from IPFS, and an IPFS transport could be added later without touching what is stored. A file put here has the same CID `ipfs add --cid-version 1` gives it: checked while planning with kubo 0.43.1 for files of 0, 1000, 262144, 262145, 174 × 262144 and 175 × 262144 + 1 bytes, and pinned by test vectors in the work that builds the format.

What is **not** taken from IPFS is its network: no public DHT, no provider records, no bitswap. Those have no notion of membership, which is the question a private database has to answer first ([Who may fetch and who may store](#who-may-fetch-and-who-may-store)).

**Verification.** A reader checks each piece against the CID that named it, top down from the reference. Because a list piece is written by whoever made the blob, a reader also bounds what it will follow: a piece of at most 1 MiB, at most 1024 children per list piece and 8 levels of them, child sizes that add up to what the parent declares, only the two codecs above, and a list piece that carries links and no content of its own. Anything else is a malformed blob, reported as corrupt and never partially served. One consequence: a file imported by an older IPFS tool without raw leaves, whose data sits inside dag-pb nodes, cannot be read here. A byte range needs only the pieces on its path. A writer builds the tree bottom up from a stream, holding one piece and one partial list piece per level.

**Hashing** goes through one injected port (bytes in, 32 bytes out, asynchronous). The default uses the platform's native digest (`crypto.subtle`) where there is one and falls back to JavaScript. A host may supply its own (React Native), and a supplied digest is checked against known answers once when installed. Pure JavaScript hashing measured 19 s per MB on an older phone, so the port is not optional in practice.

## The local store

Each node keeps two things.

**A piece store.** A map from piece hash to bytes, immutable once written, behind a small interface of its own (`IPieceStore`): has, get, put, delete, list, bytes used, flush. It is deliberately not another logical store of `RawStoreDriver` (`packages/db-p2p/src/storage/raw-store-driver.ts`): that kernel JSON-encodes every value and stages writes in an in-memory overlay and a journal, which is right for small versioned records and wrong for megabytes of immutable bytes that need no cross-key atomicity. Each storage package supplies an implementation beside its block store (files, a SQLite table, an IndexedDB object store, a LevelDB key range read as bytes), and one conformance suite runs against all of them. A host passes it to the node as it passes block storage; the default is in memory. A piece is written only after its hash has been checked, and a put of a hash already present writes nothing. A piece is durable once the store's flush has resolved; a store whose engine cannot make earlier writes durable with one later call (IndexedDB, LevelDB) makes each put durable itself.

**Blob records.** One small record per blob this node has a reason to hold, in the node's key-value store: the reference, its size once known, whether every piece is present, when it was last read, and its **holds** (below). Records are what make the node's set of blobs enumerable after a restart.

Piece bytes count toward the node's reported storage use, so capacity-driven decisions see them. They are counted once: a block store that already measures the whole directory or database it shares with the piece store has counted them, and the piece store's own figure is added only where it has not.

### Holds

A node keeps a blob only while some hold names it. There are four kinds:

| Hold | Meaning | Released when |
|---|---|---|
| **pin** (with an owner label) | The application, or the SQL layer on behalf of an open or queued transaction, needs it here. | The owner unpins it. |
| **owed** | This node announced it and its cohort does not fully hold it yet. | Every cohort member that accepts blobs confirms it holds it. |
| **responsible** | This node is in the blob's cohort, accepts blobs, and found the blob referenced by committed state. | The node leaves the cohort and enough others hold it, or the blob is no longer referenced ([Lifetime](#lifetime)). |
| **cached** | It was fetched for a read. | Evicted, least recently read first, to stay within a cache budget. |

Pieces are shared between blobs. A piece is deleted only by a sweep that finds it in no held blob's tree.

## The node's blob service

A node exposes one handle, `node.blobs`, declared on `OptimysticNodeAttachments` (`packages/db-p2p/src/optimystic-node.ts`). Its interface is defined in `db-core`:

```ts
interface BlobService {
	/** Store a stream as a blob, pinned for `owner`. Resolves once every piece is durable on this node. */
	put(source: AsyncIterable<Uint8Array>, options?: BlobPutOptions): Promise<BlobPutResult>;
	/** What this node knows about a blob, without fetching content. */
	stat(ref: BlobRef, options?: { probe?: boolean }): Promise<BlobStat>;
	/** The bytes, or a range of them, in order; fetches what is not here unless told not to. */
	read(ref: BlobRef, options?: BlobReadOptions): AsyncIterable<Uint8Array>;
	/** Bring the whole blob here ahead of a read. */
	fetch(ref: BlobRef, options?: BlobFetchOptions): Promise<void>;
	pin(ref: BlobRef, owner: string): Promise<void>;
	unpin(ref: BlobRef, owner: string): Promise<void>;
	/** Tell the blob's cohort that committed state now references it, and where. */
	announce(ref: BlobRef, scope: BlobScope): Promise<void>;
	onProgress(listener: (event: BlobProgressEvent) => void): () => void;
	onDurability(listener: (event: BlobDurabilityEvent) => void): () => void;
}

interface BlobPutOptions { owner?: string; signal?: AbortSignal }
interface BlobPutResult { ref: BlobRef; size: number }
interface BlobReadOptions { offset?: number; length?: number; from?: 'anywhere' | 'here'; waitMs?: number; signal?: AbortSignal }
interface BlobStat { ref: BlobRef; size?: number; locality: 'here' | 'partial' | 'elsewhere' | 'unknown'; heldBytes: number; durability?: BlobDurability }
/** The id of the reference tree that lists the blob (see Registering references). */
type BlobScope = string;
```

- **`put`** reads the source one piece at a time, hashes and stores each, and never holds more than a piece and its list pieces in memory. It resolves when the blob is durable *here*, pinned for its owner (the label `default` when none is given, so a blob put without one is still held until it is unpinned). Nothing leaves the machine yet: no other machine can know the reference before a row carrying it commits, so there is nothing to gain by sending the bytes sooner.
- **`announce`** is what starts copying, once the reference is committed. The SQL layer calls it; an application writing collections directly calls it after its own commit.
- **`stat`** answers from local records. With `probe` it also asks the blob's cohort, which is what distinguishes `elsewhere` (someone reachable holds it) from `unknown`. The size is known once the root piece is here.
- **`read`** yields verified bytes. Pieces not held are fetched from other holders as the read reaches them, and kept under a `cached` hold. `waitMs` keeps a read trying while the bytes are still arriving somewhere; without it a read fails at the first piece nobody reachable holds.
- **Failures are typed.** `BlobUnavailableError` carries the reference and a reason: `not-here` (the read said `from: 'here'`), `not-held` (every holder asked answered that it does not have it), `peers-unreachable` (some of them did not answer), `cohort-unreachable` (none could be asked). All four mean "not yet", and are the blob counterpart of `BlockUnavailableReason` in `packages/db-core/src/network/struct.ts`. `BlobCorruptError` means the blob is malformed, or a holder served bytes that fail verification and no other holder could supply them. `BlobRefError` means the string is not a reference.

Optimystic owns no file access. A host turns a picked file into a stream for `put` and writes the stream from `read` where it wants it.

## Registering references

Liveness is a question about the database — "does any committed row reference this blob?" — so the database has to be able to answer it cheaply, for any blob, on a machine that knows nothing about the application's schema. Two ordinary tree collections make that possible.

**A reference tree** lists the blobs one collection references. Its entries are keyed by reference, then by whatever names the referrer (for a SQL table: primary key, then column), so "is this blob referenced here?" is a short range read, and many blobs are checked in one ordered pass. An entry is written and removed **in the same transaction** as the row that holds or drops the reference. `db-core` provides the helper that stages these entries; the SQL plugin uses it for every table with a blob column, and an application writing collections directly uses it itself.

**The scope registry** is one small tree per network, at a well-known id, listing the ids of the network's reference trees. A reference tree is added to it once, when it is created, and removed when the collection that held the references is dropped, which makes the blobs it listed unreferenced there. It is how a storage node enumerates every place a reference could be without reading a schema catalog.

So a blob is not registered anywhere on its own. What is registered is the *reference*, as a side effect of the transaction that commits it, and a blob is alive while any registered reference tree lists it.

**Under transaction validation** these entries are derived, not asserted. A validating member re-executes the transaction's statements, and the plugin derives the reference-tree entries from the rows the statements change, as it derives index entries. A writer therefore cannot commit a row without its entry, or remove an entry while keeping the row: the operations would not match what the members compute. Members never check whether the bytes exist; that is not a deterministic function of the transaction. Where no member re-validates (no deployment does at pend today — backlog `feat-no-deployment-validates-transactions-at-pend`), a reference tree is exactly as trustworthy as an index tree: a writer the cohort accepts could falsify either.

## Moving pieces between machines

One new protocol, `<prefix>/db-p2p/blob/1.0.0`, registered like the node's other services. It is the first protocol here that carries more than one frame per stream and the first that carries raw bytes, so it does not go through `ProtocolClient` (`packages/db-p2p/src/protocol-client.ts`), whose single reply and one-time resend assume a small request and answer. Frames are length-prefixed. The first frame in each direction is a small JSON header; a piece is one frame of raw bytes.

| Request | Answer |
|---|---|
| `stat` — references | For each: `whole`, `partial` or `none`. |
| `get` — up to 16 piece CIDs | A header saying which are held, then one raw frame per held piece, in the order asked. |
| `announce` — a reference and its scope | `whole` (already held), `fetching` (will pull it), `declined` (does not take blobs), `not-responsible` (its own view of the blob's cohort does not include it) or `unreferenced` (it did not find the reference: the scope is not registered, does not list the blob, or could not be read). |
| `held` — a reference | Empty. Sent to a peer that announced, when the pull completes. |

**Content moves by `get` only, and the receiver always pulls.** A node that wants a blob copied to another machine announces it; the other machine decides whether to take it and then fetches at its own pace. There is no push of content, so a node never has to accept, buffer or verify bytes it did not ask for, and there is one code path that receives and checks pieces.

**Resumption** follows from the pieces: each one is verified and stored as it arrives, so a fetch that is interrupted asks only for what is still missing, from the same peer or another.

**Deadlines follow progress, not size.** A `get` has no total time limit. It is abandoned when no bytes have arrived for one response timeout of the declared link (`LinkDeadlines` in `packages/db-p2p/src/rpc-deadline.ts`), measured between any two chunks of bytes, not between whole pieces. The sender applies the same limit to a stream it cannot write to, and waits for the stream to drain when the transport reports its buffer full. A dead path still fails within one timeout; a slow one finishes.

**Other traffic is not held up.** Background copying uses at most one `get` stream per peer and a small number per node, 16 pieces at most per stream, so the stream multiplexer can interleave transaction and read traffic between pieces. A read the application is waiting on goes ahead of background copying.

**Relays.** A circuit relay with stock limits resets a relayed stream after 128 KiB. A blob cannot cross such a relay; the fetch fails, keeps what it stored, and resumes when a direct or unlimited path exists.

## Who may fetch and who may store

IPFS answers neither question: anyone may fetch a block from anyone who has it, and a node stores what its operator pins. Here both have answers.

**Fetching is limited to the network's members.** The blob protocol is gated by `authorizeInboundStream` like the four database protocols (`createInboundStreamAuthorization` in `packages/db-p2p/src/inbound-authorization.ts`), and a node fetches from, and announces to, only peers its network membership predicate admits. The protocol id carries the network's prefix, so two networks sharing a machine or a relay do not see each other's requests. Inside a network, any member can fetch any piece whose CID it knows, which is the same reach a member has over blocks. A network with no predicate is open, as it is for blocks.

**Storing is authorized by a committed transaction, not by who asks.** A node takes a blob on another's behalf only after reading committed state and finding the reference in the scope the announcement names, and only when that scope is in the registry and the node is in the blob's cohort. An announcement is a hint about where to look; it grants nothing. One from a peer the membership predicate refuses, or from a peer over its allowance, is answered `unreferenced` without any read. The right to make a network store bytes is therefore exactly the right to commit a row, which the network already governs.

There is no access control finer than membership: a reference is not a secret within a network, and a member that knows a CID can learn whether the content exists. An application that needs more than that encrypts before `put`.

## Placement, copying and durability

**Who is responsible.** A blob's routing key is the digest in its reference; the key network turns it into a coordinate and a cohort exactly as it does for a block (`routingKeyForBlock` in `packages/db-core/src/network/routing-key.ts` gains a sibling for blobs). A node may be configured not to take blobs it is merely responsible for (`blobs.hold: 'on-demand'`, against the default `'eager'`): such a node declines announcements, and holds only what it wrote, pinned or read. This is how a phone joins a group without storing every file in it.

**Copying.** `announce` records a durable **owed entry**: the reference, its scope, and the members known to hold the blob. Who is still owed is worked out from the cohort on each pass. A drain announces the blob to each owed member that is connected, on start, when a peer connects or is identified, and on a timer while anything is owed, skipping passes during a detected partition. It is the same schedule, give-up rule and membership filter as `UnderReplicationDrain` (`packages/db-p2p/src/repo/under-replication-drain.ts`), and the two share that scheduling code rather than repeating it. So the entry follows the cohort. A member is taken off the entry when it reports `whole` or sends `held`. A member that answers `declined` is remembered as declining until it next connects, and is not owed. A member that answers `not-responsible` or `unreferenced` is asked again on a later pass, under the give-up rule: the first means the two machines' views of the cohort differ for now, the second that the member has not seen the commit or could not read it.

**Durability** is reported in the classes a commit uses (`DurabilityQuorum` in `packages/db-core/src/network/struct.ts`), counted over the cohort members that accept blobs, with the count beside the class:

- `unrouted` — the cohort could not be resolved.
- `local` — this node alone holds it, or fewer than a strict majority of the accepting members do. This is wider than a commit's `local`, because a commit is not acknowledged below a majority and a blob is usable from its first copy.
- `majority` — a strict majority of the accepting members hold it.
- `full` — every accepting member holds it, and at least one of them is not this node.

Each change is an `onDurability` event, and reaching `full` removes the owed entry and its hold. In a group where no other member accepts blobs the class stays `local` and the writer keeps the blob; readers fetch it from the writer on demand.

**When the cohort changes.** A node's held blobs are enumerable from its records, so the cohort comparison `RebalanceMonitor` (`packages/db-p2p/src/cluster/rebalance-monitor.ts`) makes for blocks is made for blobs too, by giving it the routing key rule rather than a second copy of its logic. A member that joins a held blob's cohort is announced to. A node that leaves a blob's cohort drops its `responsible` hold only after confirming that enough current members hold the blob.

**Readers repair.** A node that is responsible for a blob, accepts blobs, finds it referenced and fetches it for a read keeps it under a `responsible` hold.

## Committing a reference

The transaction that commits a row carries the reference and its reference-tree entry, and nothing else. Its relation to the bytes is:

- **The reference lands before the bytes move.** No member checks availability when it votes. Checking would tie consensus to bulk transfer, would make an offline commit impossible, and is not something every member can compute alike.
- **The writer keeps what it wrote.** While a transaction that references a blob is open or queued, the blob is pinned on the writer. When the transaction commits, the writer announces the blob and holds it as `owed` until its cohort fully holds it. So a committed reference is always backed by at least the writer's copy, and a reader that cannot reach it sees "not yet", not a broken file.
- **A transaction that rolls back** leaves nothing behind anywhere else: its bytes never left the writer, and unpinning lets the writer's sweep remove them.
- **A reader decides how long to wait.** `stat`, `read` with `waitMs`, and the typed reasons give an application what it needs to show "still arriving".
- **An application that wants the bytes on the network before anyone sees the reference** commits twice. It first commits a row that only holds the reference (an attachment row), which is what authorizes the cohort to store the blob. It waits for `onDurability` to report `majority` or `full`. Then it commits the row people act on (the message that shows the attachment). The second commit cannot land before the bytes are held by others, and no machine ever stored bytes that no committed row referenced.

## SQL

The plugin adds a logical type, **`blobref`**: text whose value must be a well-formed reference. A column of that type is an ordinary value to the engine, to conflict resolution and to the wire.

```sql
create table Attachment (
	Id text primary key,
	Name text,
	ByteSize integer,
	Content blobref null
);
```

```ts
const { ref, size } = await plugin.blobs.put(fileStream);
await db.exec('insert into Attachment (Id, Name, ByteSize, Content) values (?, ?, ?, ?)', [id, name, size, ref]);
for await (const bytes of plugin.blobs.read(ref)) { /* … */ }
```

- **`plugin.blobs`** is the node's blob service for the plugin's default network, and `plugin.blobsFor(table)` the service of the network a given table uses. A reference means something only in the network whose machines hold the bytes.
- **A put outside a transaction** (as in the example above) is pinned as `unstaged`. The first statement that stages the reference moves the pin to its transaction; a blob no statement has staged after a holding period (24 hours by default) is unpinned.
- **A reference tree per table.** For a table with a `blobref` column the plugin maintains the table's reference tree, `<table>/blobrefs`, beside its index trees and staged the way `IndexManager` (`packages/quereus-plugin-optimystic/src/schema/index-manager.ts`) stages index entries, and adds it to the scope registry when the table is created or gains its first such column. Dropping the table removes it from the registry.
- **Pins follow the transaction.** A reference staged by a statement is pinned under the transaction's identity. The pin is released when the transaction commits (after announcing the blob with the table's reference tree as its scope), rolls back, or, for a queued offline transaction, settles. Pins are stored in the blob records and reconciled against the offline queue on restore.
- **SQL functions.** `BlobLocality(ref)` and `BlobSize(ref)`, both answered from the local `stat`. Content does not pass through SQL.

Existing `blob` columns are untouched: values stay inline, base64 in the row, and keep reading. Two further steps build on the explicit type and are separate work:

- **Out-of-line storage of plain `blob` values.** A `blob` value over a threshold is stored as a blob and its reference kept in the row, invisibly to SQL. This removes the size limit and most of the cost for existing schemas, but a row read then depends on a fetch.
- **Streaming through the engine.** Reading or writing a range of a column value by table, key and column needs an interface Quereus does not have (gotchoices/quereus#40).

## Lifetime

Nothing reclaims block storage today, so a blob that is never reclaimed is no worse than a base64 value in a row. Reclaiming is still designed in, because blobs are where the bytes are.

- **Referenced blobs are kept.** A `responsible` hold lasts while any registered reference tree lists the blob.
- **Unreferenced blobs are reclaimed by each holder on its own reading of committed state.** Every 6 hours a holder passes its held references against every registered reference tree. A blob listed nowhere at two passes a grace period apart (7 days by default) loses its `responsible` hold. No message from another peer deletes anything.
- **An owed blob follows the same rule.** A writer whose cohort never fully holds a blob would otherwise keep it for ever. The pass also covers owed entries: one whose scope has not listed the blob at two passes a grace period apart is dropped with its hold.
- **Only a certain answer counts.** A pass counts toward reclaiming only when every tree read was authoritative and confirmed current. A read that fails, is flagged unavailable or possibly stale, was answered with a block older than the log names it, or cannot reach the registry counts as "still referenced". So does a read that rested on asking nobody (the read path gains a marker saying a cohort confirmed an answer, since today it cannot be told apart), unless the node is alone by the test the offline queue's reachability gate applies (no known member missing, no bootstrap peer still awaited): a node that merely cannot see its cohort gets unflagged "absent" answers for collections it does not hold, and must not act on them. And a registry that reads as absent on a node holding blobs counts as "still referenced", since the registry existed when those holds were taken. A machine that is partitioned, starting cold, or being fed old state keeps what it has.
- **There is nothing to renew.** A design in which writers periodically extend a blob's lease was rejected: it costs a transaction per blob per period for ever, and it fails toward data loss whenever the renewing machine is a phone that stayed offline. Here the row is the lease, and it lasts as long as the row does.
- **Cached blobs** are evicted under a budget (256 MiB by default), least recently read first, never while a read of them is in progress. This is local and needs no agreement.
- **A reference that outlives its bytes** is possible only where no reference tree lists it any longer: an old revision of a row read from history. Such a read reports the blob as not held.
- **Accepted limits.** A reference copied from another row into a transaction that then stays queued offline for longer than the grace period, on a machine that never held the bytes, can commit after every holder has reclaimed the blob; it then reads as not held. Dropping a table leaves its reference tree in storage, so re-creating a table of the same name registers the old tree again and keeps the blobs its old rows listed. And the grace period is measured on each holder's own clock, so a clock set forward shortens it.
- **Re-referencing is safe.** A row that comes to reference a blob others have reclaimed, or are about to, is committed by a writer that either holds the bytes (it just `put` them, and announces) or copied the reference from another row. In the second case the blob was referenced when it was copied, the new entry is visible to the next pass, and the two-pass rule keeps the holder from having dropped it in between.

## Extending toward a file system

This design gives blobs, not a file system: no names, no directories, no editing in place. A file system is expected to be built on top, with rows as the directory entries (a table of name, parent and a `blobref`), which already gives atomic rename and move, liveness by row, and partial reads. The design keeps four properties so that going further stays an addition and never a rewrite. They are requirements on the implementation.

- **Below the format layer, a blob is only pieces and links.** Storage, transfer, holds, the sweep, copying and reclaiming never interpret a piece. They reach a blob's pieces through one walk in `db-core`, and one function there decodes a list piece. Admitting another kind of node, such as a UnixFS directory, changes that function and the walk; a directory's root would then be held, copied and reclaimed as a file's is.
- **The reader accepts more than the writer makes.** Any UnixFS file tree within the reader's bounds is readable, whatever its piece sizes and fan-out. So a second way of cutting pieces (boundaries chosen from the content, so that an insertion does not shift every later piece) needs a new writer and no change to readers, stores or the wire.
- **Building a tree is separate from cutting pieces.** The code that assembles list pieces from a sequence of leaf links is usable on its own. An append or an overwrite can then make a new blob from an existing blob's leaf links plus new pieces, without reading the unchanged content again. Because pieces are shared, the new blob costs only its new pieces and list pieces.
- **The reference grammar is not narrowed to this writer's output.** A reference is any version-1, SHA-256 CID of a raw or dag-pb piece. A directory root is a dag-pb piece, so it would need no new kind of reference.

What an extension would still have to decide: whether a directory is rows or a UnixFS node (rows give transactions and per-file placement; a node gives one reference for a whole tree and import from IPFS, but places the whole tree on one cohort unless child files are treated as blobs of their own); how an editor names the blob it is splicing from; and file-system semantics that have no counterpart here, such as permissions finer than membership and locks. Editing a range of a column value through SQL is the Quereus work described under [SQL](#sql).

## Threats

What a member that the network admits, or a stranger, can and cannot do.

| Attack | Outcome |
|---|---|
| Fill other machines' storage by announcing blobs | Refused. A holder pulls only what a registered reference tree lists, so the attacker must commit rows, which is the network's existing write authority and leaves attributable rows that can be deleted. |
| Aim storage at one victim by choosing content whose hash lands in its cohort | Possible in principle (as it is for block ids), and bounded the same way: each blob needs a committed reference. |
| Flood announcements to make holders read reference trees | Bounded per peer; an announcement naming an unregistered scope is refused before any read. |
| Make a live blob expire | Requires committing the removal of its references, which is deleting the rows. Feeding a holder stale or empty reads does not work: only certain answers count, twice, a grace period apart. |
| Serve wrong bytes | Detected at the piece. The peer is penalized (`PenaltyReason` in `packages/db-p2p/src/reputation/types.ts`, the reason existing repair paths use for unverifiable content): the stream is authenticated and the fault attributable. The reader asks another holder. |
| Craft a malformed tree to exhaust a reader | Bounded by the limits a reader applies before following any link. |
| Exhaust a holder's bandwidth with `get` | Bounded per peer and per node; pieces are small and a holder may refuse a peer that is over its allowance. |
| Learn whether known content exists in the network | A member can. Not treated as a secret; encrypt before `put` if it must be. |
| Fetch content without being a member | Refused at the stream, before any request is read. |

## Platforms and limits

- A piece this design writes (256 KiB) is below every per-value limit the storage backends are known to have, including NativeScript's 512 KiB threshold for large JNI results. A reader accepts pieces of up to 1 MiB from blobs made by other IPFS tools, so every piece store must also store and return a piece of that size.
- React Native's LevelDB store reads values as text for the block store; its piece store reads bytes.
- Browsers store pieces in IndexedDB; adding the object store is a database version change.
- Blob records, owed entries and pieces survive a restart only when the host supplies a persistent key-value store and piece store. With the in-memory defaults, pins and unsent copies are lost when the process ends.
- The dag-pb and UnixFS codecs are new dependencies of `db-core`, and must pass the React Native bundle check.

## Compatibility

The change is additive. A node on an older build does not register the blob protocol; peers see that from its protocol list and treat it as a member that does not accept blobs. Stored data gains a piece store and new key-value namespaces, and loses nothing, so an older build's data opens unchanged. A table that declares a `blobref` column cannot be opened by a plugin that predates the type; adopting the type is a schema change an application rolls out like any other. An application with references of its own (Sereus Chat's `chunks:1:` references) tells them from these by their prefix and keeps reading the old ones.

## What this answers in GitHub #63

| Ask | Answer |
|---|---|
| Skip the canonicalize, hash and clone passes for large values | A blob is hashed once per machine and never encoded, canonicalized or cloned. |
| Carry a value once, not two to three times | A piece travels once, as raw bytes; the row and its log entry carry a reference of about 60 characters. |
| Deadline by progress, not a fixed total | True of blob transfer. Transaction deadlines are unchanged. |
| Retries that resume | A fetch resumes at the missing piece. |
| A write of any size should work without the application cutting it up | True of content. A transaction of ordinary rows is still limited to one frame. |

The expected cost is one hash and one store write per piece on the writer, the same on each receiver, and a wire size of the content plus a few kilobytes of list pieces per 45 MiB. The work that builds the transfer measures time per MB and bytes on the wire against the #63 script's shape and states the result here.
