description: Give Optimystic real large-value (blob) support, so files and other large values are stored and moved outside ordinary transactions instead of being packed as base64 into rows, which today limits a transaction to about 2 MB of file data and costs about 1.7 seconds per megabyte.
architecture: docs/internals.md#a-transactions-size-limit
files: packages/db-core/src/network/transaction-size.ts, packages/db-core/src/network/block-size.ts, packages/db-core/src/log/struct.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts (BLOB columns base64 under the `json` encoding), packages/db-p2p/src/cluster/block-transfer-service.ts, ../sereus-chat/docs/blobs.md and ../sereus-chat/packages/core/src/sereus/blob-store.ts (read-only: the application-level workaround), gotchoices/quereus#40 (native large values in Quereus)
difficulty: hard
tradeoffs: A new storage primitive with its own transfer, lifetime and garbage-collection rules is a large design surface, and Quereus's native large-value support (gotchoices/quereus#40) may settle part of the SQL-facing shape first.
----

Maintainer decision, 2026-11-17: large values get actual blob support rather than a change to the log format. Reported as GitHub #63 (Sereus Chat attachments), and replaces the question of whether a log entry should stop repeating the values its blocks carry. A maintainer will assign a stronger agent to plan it.

## The problem

A large value written through SQL travels as a base64 string inside a row, inside a transaction. Each value is carried two to three times (once in the blocks it changes and once in the log entry recording the action, plus base64's third), so a transaction holds only about 2 MB of file data under the 7.5 MiB limit, and a commit costs about 1.7 seconds per MB on loopback, almost all of it JSON encoding, canonicalization, hashing and cloning of the whole value (profile in `plan/0.6-a-large-write-costs-time-and-space-per-byte`). On a slow link a multi-megabyte transaction never commits, because each attempt resends everything within a fixed time budget.

## Prior art to draw on

`../sereus-chat/docs/blobs.md` describes the workaround Sereus Chat built: an opaque, self-describing `BlobRef` (scheme-prefixed, so a native store can take over new data without migrating old), content-addressed chunks hashed with the platform's native SHA-256, two content-keyed tables (`BlobChunk`, `Blob` with an ordered chunk list), a few chunks written per transaction, and a `BlobStore` interface (`put`, `locality`, `read`) with host-supplied file access. Its limits section shows what Optimystic limits it had to design around. A native design should make that workaround unnecessary while letting its refs keep reading.

## What the design must settle

- **Representation and addressing**: how a blob is named (content address of a chunk list is the precedent), chunk size relative to `BLOCK_TARGET_BYTES` and the frame cap, and whether chunks are blocks, a separate store, or both.
- **Transactions**: a row refers to a blob; the bytes do not ride in the transaction that commits the reference. What a commit guarantees about the blob's availability when the reference lands (write bytes first, then commit the reference, as the workaround does), and what a reader sees for a reference whose bytes have not reached it (a typed "not yet here" rather than a missing-block error).
- **Transfer**: how bytes move between machines outside consensus — streamed, resumable, verified against the content address, and paced for slow links.
- **Placement and durability**: which machines hold a blob (its referencing collection's cohort, or its own placement), how replication and repair treat it, and how the durability classes a writer is told apply.
- **Lifetime**: when a blob no longer referenced is reclaimed, given that references live in several machines' histories.
- **SQL surface**: how the Quereus plugin exposes it, coordinated with gotchoices/quereus#40 so the engine and module agree on one large-value type.
- **Platforms**: browser, Node, React Native and NativeScript, including native hashing and file access supplied by the host.
- **Upgrade**: existing base64 BLOB columns keep reading; the persisted format changes only additively, with `upgrade-check` fixtures to match.
