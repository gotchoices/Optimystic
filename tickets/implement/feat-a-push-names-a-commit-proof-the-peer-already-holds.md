description: When a machine copies many blocks to another machine, it re-sends the same signed commit receipt with every single block, and that receipt lists every block of the commit — so copying a big commit wastes bandwidth that grows with the square of its size. Make a push name a receipt the other machine already has instead of sending it again.
architecture: docs/internals.md#durable-commit-proof-blockcommitproof
files: packages/db-p2p/src/cluster/block-transfer-service.ts (`BlockTransferRequest`, `BlockTransferResponse`, `IBlockReplicaStore`, `PushCertification`, `handlePush`, `BlockTransferClient.pushBlocks`, `pushBlockToPeers`), packages/db-p2p/src/cluster/peer-proof-memory.ts (new), packages/db-p2p/src/storage/storage-repo.ts (`StorageRepo.getCommitProof`), packages/db-p2p/src/storage/i-raw-storage.ts (`getCommitProof`, already present), packages/db-p2p/test/block-transfer-roundtrip.spec.ts, docs/internals.md
difficulty: medium
----
# A push names a commit proof the peer already holds

Split out of `a-commit-proof-is-stored-once-not-once-per-block` (GitHub #60), which fixed the same quadratic in storage and left the wire as it was. This ticket is the block-transfer (push) half; `feat-a-consult-answer-carries-each-proof-once` is the repair-answer half.

## What happens today

Every replication push carries ONE block and attaches that block's `BlockCommitProof` inline, in `BlockTransferRequest.blockProofs`. All four senders go through the one push loop, `pushBlockToPeers` in `packages/db-p2p/src/cluster/block-transfer-service.ts`: the rebalance lost-block confirm and growth arm (`BlockTransferCoordinator`), spread-on-churn, and the under-replication drain. The proof carries its consensus message verbatim, and that message's commit operation lists every block id and declared digest of the commit — so a proof's size is linear in the commit's block count N, and copying all N blocks of one commit to one peer puts N copies of it on the wire. From the reporter's numbers (not measured on the wire): one 528 KB proof covered 3,383 blocks, so pushing that commit to one new peer sends about 1.7 GB of proof beside the blocks. The obvious trigger is the cohort-growth push — a solo node that bulk-imported, then gains a second machine, pushes every block it holds.

Storage already solved its half of this, and the fix below reuses the mechanism: a proof is stored once per node under its `messageHash` in a commit-proofs store (`IRawStorage.getCommitProof` / `saveCommitProof`, `RawStoreDriver.getCommitProof`), and each revision that the proof covers holds a `ProofRef` naming that hash (`KvRawStorage.saveBlockProof`). So a receiver that has accepted any block of commit H already holds H's proof, resolvable by hash alone, durably and across restarts.

## What cannot be done

Trimming the proof down to the one block being claimed. The promise and commit signatures cover the whole consensus message (`computeClusterMessageHash`, `computeClusterCommitHash` in `packages/db-core/src/cluster/membership.ts`), so signing a per-block structure instead — a Merkle root over the commit's `blockDigests`, say — changes the signed preimage, invalidating every stored proof and breaking any cohort running two builds.

## The design

**Shape chosen: reference, with the proof sent on demand.** The push request gains a per-block *reference* to the proof by message hash, as an alternative to carrying the proof; the response gains the list of references the receiver could not resolve; and the sender remembers, per peer, which proofs that peer has been shown. The first block of a commit pushed to a peer carries the proof; the rest carry an eight-byte-ish hash. One proof per (peer, commit), and no extra round trip in the common case.

The other candidate — grouping a sender's pushes by `messageHash` into multi-block requests under the frame limit — is deliberately rejected. It would restructure the per-block retry, per-block `missing` accounting and per-block confirmation that rebalance release, ring-shift handoff and the drain all read off `pushBlockToPeers`, and each of the four senders is driven by a different source (a rebalance event, a tracked-block set, a ledger walk) so none of them naturally holds "all the blocks of one commit" at once. Reference-first leaves every one of those accounting rules untouched: one block per request, one certification decision per block, one `missing` verdict per block.

### Wire shape

`BlockTransferRequest` keeps `blockProofs` exactly as it is (per block, the proof inline) and gains a sibling:

```ts
/**
 * Per block, the `messageHash` of the proof that certifies it — a reference the receiver resolves
 * out of its own commit-proofs store, used instead of carrying the proof in {@link blockProofs}
 * when the sender has already shown this peer that proof. A reference the receiver cannot resolve is
 * answered in {@link BlockTransferResponse.unresolvedProofs}, and the sender re-pushes the block
 * with the proof inline.
 *
 * A reference says nothing on its own: the resolved proof is verified against the declared
 * `(rev, actionId)` and the pushed bytes by the same `certifyContent` call an inline proof goes
 * through, so a reference extends the sender no trust it did not already have.
 */
proofRefs?: Record<BlockId, string>;
```

Keyed by block id, like `blockProofs`, because a reference is a per-block statement ("the proof for THIS block is the one you filed under H"). A block id present in both maps takes the inline proof.

`BlockTransferResponse` gains:

```ts
/**
 * Message hashes this request REFERENCED ({@link BlockTransferRequest.proofRefs}) that this receiver
 * could not resolve. Its presence is the sender's cue to re-push the affected block with the proof
 * inline; absence of a referenced hash from this list means the receiver resolved it.
 *
 * Distinct from {@link missing}, which lists BLOCK ids. A block can be accepted and its reference
 * still unresolved (a receiver running `requirePushCertificate: false` takes the block uncertified),
 * so a sender must read this list independently of `missing`.
 */
unresolvedProofs?: string[];
```

`PushCertification` gains the matching optional `proofRefs?: Record<BlockId, string>`, and `BlockTransferClient.pushBlocks` forwards it the way it forwards `blockMeta` and `blockProofs`. `sourceBlockCertification` is unchanged — it still builds the inline form from one unpinned read; the reference is a per-peer *projection* of that, made inside `pushBlockToPeers`.

### Receiver

`handlePush` resolves a block's proof as: the inline `blockProofs[blockId]`, else — when `proofRefs[blockId]` is a plausible hash — `repo.getCommitProof(hash)`. An unresolvable reference adds the hash to `unresolvedProofs` and leaves the block on exactly the path it is on today with no proof: refused (`push:reject-uncertified … reason=no-proof`) under the default `requirePushCertificate`, accepted uncertified under the migration flag. The resolution happens BEFORE the existing `proof-without-meta` guard, so a reference without `blockMeta` is refused for the same reason an inline proof without meta is.

Everything after resolution is untouched: one `certifyContent` call covers the signatures and thresholds, the claim matching the declared `(rev, actionId)`, and the declared digest matching the pushed bytes. The claim and digest steps are never memoized (`verifyBlockCommitProofClaim`), so a resolved proof presented for a block or revision it does not certify still fails `claim-not-in-message`, and nothing about what the receiver verifies or stores changes. The *votes* half IS memoized by the proof's JSON text, so resolving the same proof repeatedly costs a store read and the claim step, not a signature round.

`IBlockReplicaStore` gains the accessor, OPTIONAL:

```ts
/**
 * The proof stored under a consensus message's hash (`BlockCommitProof.messageHash`) — how a push
 * that NAMED a proof instead of carrying it is resolved.
 *
 * Optional so existing test doubles and a plain embedder keep compiling. Absent, every reference is
 * answered `unresolvedProofs` and the sender re-pushes with the proof inline, which is exactly the
 * behaviour before references existed, plus one round trip per block — logged distinctly
 * (`push:proof-ref-no-store`) so the misconfiguration is diagnosable rather than merely slow.
 */
getCommitProof?(messageHash: string): Promise<BlockCommitProof | undefined>;
```

`StorageRepo` implements it as a one-line delegate to its `IRawStorage` (which already has `getCommitProof`); `libp2p-node-base` already wires `serving.storageRepo` as the service's repo, so production gets it with no wiring change.

### Sender

In `pushBlockToPeers`, per peer:

- Let `hash = certification.blockProofs?.[blockId]?.messageHash`. No retained proof means no hash and nothing changes (the push is uncertified exactly as today, and `PushBlockOutcome.certified` keeps its current meaning: a proof existed locally).
- If the memory says this peer holds `hash`, send `{ blockMeta, proofRefs: { [blockId]: hash } }`; otherwise send `{ blockMeta, blockProofs }` as today.
- If a reference was sent and the response's `unresolvedProofs` names `hash`: forget the memory entry and push the SAME block once more with the proof inline, and read that second response as the peer's answer. At most one such retry per peer per block.
- On a response that does not list the block in `missing`, and that carried the proof inline, record (peer, hash) in the memory.

The retry keys off `unresolvedProofs`, never off `missing`, so a lenient receiver that accepted the block uncertified still gets the proof on the retry — where `saveReplicatedBlock`'s non-advancing branch back-fills it onto the revision it just landed.

### The sender's memory

New file, `packages/db-p2p/src/cluster/peer-proof-memory.ts`: a bounded set of `(peerId, messageHash)` pairs a sender has shown a peer, in one `LruMap` (`@optimystic/db-core`) keyed `` `${peerId}|${messageHash}` `` with a fixed cap in the low thousands. Two operations — "does this peer hold H" and "record / forget that it does".

It is **module-level, held in a `WeakMap` keyed on the `repo` argument of `pushBlockToPeers`**, not threaded through options. The reasoning, which the file must state:

- Every sender of one node passes the same object as `repo` — the node's own `storageRepo` (`BlockTransferCoordinator`'s constructor arg, `SpreadOnChurnDeps.repo`, and the drain's `pushBlock` closure in `libp2p-node-base`), and `pushBlockToPeers` is already documented as taking "the node's OWN store". So that object IS the node's identity at this seam, and two nodes in one process (the in-process test mesh) never share a memory — unlike the process-wide `proofVotesMemo`, which is shared precisely because its verdict is a pure function of its key, and this is not.
- The alternative, an explicit `PushBlockOptions.proofMemory` threaded through, would add a field to `BlockTransferConfig` and `SpreadOnChurnDeps`, a ninth positional parameter to `NetworkManagerService.initSpreadOnChurnMonitor`, and a wiring step a fifth sender can forget — the same silent-degradation failure mode `ProofRetainingRepo` exists to prevent, except here forgetting it costs bandwidth, not correctness.

Being wrong in either direction is safe: "believed held" and not held costs one extra round trip and self-corrects via `unresolvedProofs`; "not known held" when it is costs one proof on the wire, which is today's behaviour. Nothing expires, because nothing deletes a stored commit proof (`RawStoreDriver.getCommitProof`'s no-delete note); eviction at the cap just re-sends a proof.

## Edge cases & interactions

- **First block of a commit to a cold peer** → proof inline; **every later block of that commit to that peer** → reference only, no proof bytes. *Verified by a test* (the round-trip spec below) — this is the whole specification of the change.
- **A reference the receiver cannot resolve** (restarted, LRU-evicted mid-save, never retained) → block refused under the strict flag, hash in `unresolvedProofs`, sender re-pushes once with the proof inline and the block lands. *Verified by a test.*
- **A reference unresolved on a receiver with `requirePushCertificate: false`** → the block is ACCEPTED uncertified and the hash is still reported, so the retry fires on `unresolvedProofs` alone and the second push back-fills the proof onto the revision just landed. *Verified by inspection* of the retry condition plus the existing back-fill path in `StorageRepo.saveReplicatedBlock`.
- **A reference with no `blockMeta`** → refused `proof-without-meta`, like an inline proof without meta; the resolution must run before that guard. *Verified by inspection.*
- **A reference naming a proof the receiver holds that does not cover this block or revision** → `certifyContent` fails `claim-not-in-message`, the block is refused, and the hash is NOT in `unresolvedProofs` (it resolved). The sender does not retry, which is right: resending the same proof would fail the same way. *Verified by inspection* — the claim step is unmemoized by construction.
- **Hostile or garbage reference**: a non-string, an over-long string, one naming nothing. Cap the reference's length (a `messageHash` is a short base58btc multihash; a cap in the low hundreds of characters is generous) and ignore a non-string, BEFORE any store read, so a peer cannot make this node key a store read on an arbitrarily large value. At most one store read per block id per request, and one block per request today. *Verified by an assertion at the seam* plus inspection.
- **Concurrent pushes of different blocks of one commit to one peer**: the coordinator runs up to `maxConcurrency` (default 4) block pushes in parallel, so with a cold memory up to that many inline copies of one proof go out before the memory warms. Bounded and accepted — against the N copies this ticket removes it is noise. *NOTE at the site*, with the hint that joining an in-flight push per (peer, hash) the way `KvRawStorage.ensureCommitProof` joins an in-flight save would make it exactly one, at the cost of serializing concurrent pushes behind the first.
- **A receiver that accepted a block but retained no proof for it** — a diverged holder whose own materialization does not match the declared digest, reached through `saveReplicatedBlock`'s monotonic no-op. The sender records "held", every later reference for that commit comes back unresolved, and each of that commit's blocks costs two pushes to that peer. Bounded, abnormal, and strictly better than today only in proof bytes. *NOTE at the site*, with the hint that an exact answer needs the receiver to report what it retained, which `saveReplicatedBlock` does not currently return.
- **A block whose bytes plus its proof exceed `MAX_BLOCK_MESSAGE_BYTES`** (8 MiB; a block may be up to 7.5 MiB and a large commit's proof over the 512 KiB envelope reserve): the inline push fails locally in `ProtocolClient.processMessage`, by name, exactly as it does today — but now only for the first block per (peer, commit) rather than for every one. No behaviour change; *NOTE at the site* recording that the reference path is what makes the rest of that commit placeable at all.
- **A block whose proof this node never retained** (pre-proof history, a diverged local commit) → no hash, no reference, meta-only push, refused by a default-configured receiver. Unchanged.
- **`unresolvedProofs` absent from the response** — a peer on an older build, or a request this receiver faulted on and answered "every block missing". No retry; the block is refused as it is today. Covered by the existing accepted-tradeoff NOTE on `BlockTransferRequest` (builds either side of the push-shape change already cannot copy blocks to each other).
- **The memory must not leak between nodes in one process.** *Verified by construction* (the `WeakMap` key is the sender's own store) and exercised incidentally by any in-process mesh spec that pushes between nodes.
- **`PushBlockOutcome.certified`** keeps meaning "a proof was available locally for this block", so the drain's `push:rejected … (no retained proof — cannot place)` line stays accurate when a reference was sent instead of the proof.

## Tests

One spec file's worth, added to `packages/db-p2p/test/block-transfer-roundtrip.spec.ts` (which already drives a real `BlockTransferService` over a wired network with real certification), pinning the new wire contract — branching logic the whole ticket is about:

- Pushing two blocks of ONE commit to one peer through `pushBlockToPeers`: both are accepted, and the second request carries `proofRefs` and no `blockProofs`. Assert on the request the service actually received, not on a log line.
- A reference the receiver cannot resolve: the response names the hash in `unresolvedProofs`, and the sender's retry lands the block.

Nothing else earns a test: `PeerProofMemory` is an `LruMap` wrapper, `StorageRepo.getCommitProof` is a delegate, and the certification rules it feeds are already pinned in `block-transfer-push-persist.spec.ts` and `source-block-certification.spec.ts`.

Per `tickets/rules/testing.md`, run no package suite here — the review stage runs it once.

## TODO

- Add `BlockTransferRequest.proofRefs` and `BlockTransferResponse.unresolvedProofs` with the doc comments above; extend `PushCertification` with `proofRefs` and forward it from `BlockTransferClient.pushBlocks`.
- Add the optional `getCommitProof` to `IBlockReplicaStore` with its degradation note; implement it on `StorageRepo` as a delegate to `IRawStorage.getCommitProof`.
- Resolve references in `handlePush`: bound and validate the reference, read it from the store, collect unresolvable hashes into `unresolvedProofs`, and keep the resolution ahead of the `proof-without-meta` guard. Log `push:proof-ref-unknown` and `push:proof-ref-no-store` as distinct lines.
- Add `packages/db-p2p/src/cluster/peer-proof-memory.ts`: the bounded `(peerId, messageHash)` set, the `WeakMap`-on-repo accessor, and the rationale for both (per-node identity, safe in both directions of being wrong, no expiry needed).
- Teach `pushBlockToPeers` the per-peer projection, the single `unresolvedProofs` retry, and the memory update on a confirming response; add the three NOTEs (concurrent cold pushes, the non-retaining receiver, the oversized inline retry).
- Extend `block-transfer-roundtrip.spec.ts` with the two cases above.
- Add a paragraph to `docs/internals.md` § "Durable commit proof (`BlockCommitProof`)" on how a proof crosses the push wire once per (peer, commit) and what the receiver still verifies. Keep it next to the storage-side "stored once per message" statement, not inside it.
