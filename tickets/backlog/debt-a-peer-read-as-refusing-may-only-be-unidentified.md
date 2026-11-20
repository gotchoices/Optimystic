description: A machine that has only just connected can be mistaken for one that is too old to store files, and then it is quietly left out of the count of who holds a file — so the machine that wrote the file can be told the group has it and stop keeping its own copy, leaving one copy fewer than promised.
architecture: docs/blobs.md#placement-copying-and-durability
files: packages/db-p2p/src/libp2p-key-network.ts (`protocolSupport`, `peerRecords`, `membershipOf`), packages/db-p2p/src/blob/accepts-blobs.ts (`blobAcceptanceOf`, `BlobAcceptance`), packages/db-p2p/src/blob/blob-copy-drain.ts (`accepts`, `cohortView`), tickets/implement/2.65-feat-the-blob-cohort-reaction.md (the second reader of the same verdict)
difficulty: medium
severity: wrong-result
likelihood: unusual
repro: static
tradeoffs: The window is the few milliseconds between a peer's first stream and its identify landing, and in practice identify lands well before the copy drain's five-second debounce — so a maintainer may reasonably judge this unreachable in any real deployment and keep the two NOTEs instead of changing a shared lookup that membership classification also reads.
----
# A peer read as refusing may only be unidentified

## What a peer's protocol list means today

When two machines connect, each tells the other which protocols it speaks, over libp2p's `identify` handshake. Until that handshake lands, the receiving machine's record of the peer may already hold *some* protocols — libp2p merges in the protocol of any stream the peer opened — so the record can be non-empty and incomplete at the same time.

`Libp2pKeyPeerNetwork.protocolSupport` (`packages/db-p2p/src/libp2p-key-network.ts`) reads that record and answers one of three things per peer: `listed` (the protocol is in the list), `unlisted` (the list is non-empty and the protocol is not in it), `unknown` (no record, or an empty list). `blobAcceptanceOf` (`packages/db-p2p/src/blob/accepts-blobs.ts`) renames those `accepts` / `refuses` / `unknown`.

The problem is that `unlisted` conflates two different facts:

- the peer has introduced itself and genuinely does not run this protocol — an older build, which is what the reading is for; and
- the peer's record is simply not finished yet.

A NOTE on `blobAcceptanceOf` has recorded that conflation for a while, with an explicit condition attached: harmless *while* a refusal only costs one skipped attempt.

## Why that condition no longer holds

`BlobCopyDrain` (`packages/db-p2p/src/blob/blob-copy-drain.ts`, landed by `feat-blob-owed-copies-are-drained`) uses the same verdict for a second, heavier purpose. A blob's durability is counted over "the cohort members that accept blobs" ([docs/blobs.md §Placement, copying and durability](../../docs/blobs.md#placement-copying-and-durability)), and `accepts` drops a `refuses` member from that set — out of the numerator *and the denominator*. So a member misread inside the identify window is not merely skipped for one round: it is not there to be missing.

The consequence, for a blob whose cohort is this writer plus members A and B, where A is inside that window and B confirms it holds the blob in the same pass:

- the view has `accepting = [writer, B]`, holders `{writer, B}`, so the class is `full`;
- `full` is what deletes the owed entry and releases the writer's `owed` hold, which may delete the writer's copy outright;
- A never received an announcement and holds nothing, and nothing re-announces to it: the cohort-reaction work (`feat-the-blob-cohort-reaction`) reacts to cohort *changes*, and A's membership never changed. The copy would arrive only if someone later reads the blob on A (reader repair).

The blob is not lost — `full` is unreachable without another member holding it — but the group is left one copy short of what `full` promises, and the writer was told otherwise. `feat-the-blob-cohort-reaction` makes the same verdict decide when a departing node may drop its `responsible` hold, so the class has a second reader coming.

## What should be true instead

A member is left out of a durability count only on evidence that the member has spoken for itself. Stated as the invariant: **"this peer does not run protocol X" is answerable only once the peer has introduced itself; before that the honest answer is "not known yet"** — which every current reader already handles, since `unknown` is the pre-identify answer they were written for.

That is one change at the source, `protocolSupport`, rather than a guard at each reader of it — and it also retires the sibling misread the same NOTE names, `membershipOf` reading such a peer `foreign`.

The discriminator is available: identify fills a peer record's `agentVersion` / `protocolVersion` alongside its protocol list, so a record carrying neither is one identify has not completed, however many protocols a merged stream put in it. Whether that is the right signal, whether it should be cached in `peerRecords` beside the protocol list, and what `peersServing` and `membershipOf` should do differently as a result are the design questions this ticket opens; it does not settle them.

## How it was found and what would confirm it

Read from the code during the review of `feat-blob-owed-copies-are-drained`; not reproduced. Confirming it means driving a cohort member into the partial-list state — connect a member, have it open one non-blob stream, hold identify off, and run a copy drain pass while another member confirms — and watching the blob reach `full` with that member holding nothing. The two NOTEs now at the sites (`blobAcceptanceOf`, and `BlobCopyDrain.accepts`) point here.
