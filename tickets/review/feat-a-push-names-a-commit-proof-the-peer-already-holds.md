description: A machine copying many blocks to another machine used to re-send the same signed commit receipt with every block; now the first block of a commit carries the receipt and every later one just names it, and the other machine says so if it cannot find the one being named.
architecture: docs/internals.md#durable-commit-proof-blockcommitproof
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/peer-proof-memory.ts (new), packages/db-p2p/src/storage/storage-repo.ts (`StorageRepo.getCommitProof`), packages/db-p2p/test/block-transfer-roundtrip.spec.ts, docs/internals.md, docs/debugging.md
difficulty: medium
----
# A push names a commit proof the peer already holds — review

The push half of the split out of `a-commit-proof-is-stored-once-not-once-per-block` (GitHub #60). The repair-answer half is `feat-a-consult-answer-carries-each-commit-proof-once`, still in `implement/`, and its `docs/internals.md` paragraph follows the one added here.

## What landed

**The wire** (`packages/db-p2p/src/cluster/block-transfer-service.ts`). `BlockTransferRequest` keeps `blockProofs` exactly as it was and gains a sibling `proofRefs?: Record<BlockId, string>` — per block, the `messageHash` of the proof that certifies it, as an alternative to carrying the proof. `BlockTransferResponse` gains `unresolvedProofs?: string[]`, the message hashes a request *referenced* that the receiver could not resolve (hashes, not block ids — a block can be accepted and its reference still unresolved). `PushCertification` gains the matching optional `proofRefs`, and `BlockTransferClient.pushBlocks` forwards it the way it forwards `blockMeta` and `blockProofs`. `sourceBlockCertification` is untouched: it still builds only the inline form from one unpinned read, and the reference is a per-peer projection made inside `pushBlockToPeers`.

**The receiver.** `handlePush` now resolves a block's proof through a new private `resolveProof`: the inline `blockProofs[blockId]`, else — when `proofRefs[blockId]` is a plausible hash — `repo.getCommitProof(hash)`. The resolution runs *before* the `proof-without-meta` guard, so a reference without `blockMeta` is refused for the same reason an inline proof without meta is, and everything after it is unchanged: one `certifyContent` call covers the signatures and thresholds, the claim matching the declared `(rev, actionId)`, and the declared digest matching the pushed bytes. An unresolvable reference puts the hash in `unresolvedProofs` and leaves the block on exactly the path it is on today with no proof — refused under the default `requirePushCertificate`, accepted uncertified under the migration flag. `IBlockReplicaStore` gains `getCommitProof?` (optional, so existing doubles and a plain embedder keep compiling); `StorageRepo` implements it as a one-line delegate to `IRawStorage.getCommitProof`, and `libp2p-node-base` already wires `serving.storageRepo` as the service's repo, so production needed no wiring change.

**The sender** (`pushBlockToPeers`, the one push loop all four senders go through). Per peer: if the memory says this peer holds the proof's hash, push `{ blockMeta, proofRefs }`; otherwise push `{ blockMeta, blockProofs }` as before. If a reference was sent and the answer names that hash in `unresolvedProofs`, forget the memory entry and push the same block once more with the proof inline — at most one such retry per peer per block, and the retry's answer is the peer's answer. On a confirming answer that carried the proof inline, remember `(peer, hash)`. The retry keys off `unresolvedProofs` and never off `missing`, so a lenient receiver that took the block uncertified still gets the proof, which `StorageRepo.saveReplicatedBlock`'s non-advancing branch back-fills onto the revision it just landed. `PushBlockOutcome.certified` keeps its meaning — a proof existed *locally* for this block — so the drain's "no retained proof — cannot place" line stays accurate.

**The sender's memory** (`packages/db-p2p/src/cluster/peer-proof-memory.ts`, new). A bounded set of `(peerId, messageHash)` pairs in one `LruMap` keyed `` `${peerId}|${messageHash}` ``, cap 4096, held in a module-level `WeakMap` keyed on the `repo` argument of `pushBlockToPeers` — which is the node's own `storageRepo` for every sender, so that object is the node's identity at this seam and two nodes in one process never share a memory. The file states the reasoning for both the keying and for not threading an explicit option. `holds` reads through `LruMap.get` rather than `has`, so the pair for the commit being copied right now is the last to be evicted. Nothing expires, because nothing deletes a stored commit proof.

**Docs.** A new paragraph in `docs/internals.md` § "Durable commit proof (`BlockCommitProof`)", next to the storage-side "stored once per node" statement: how a proof crosses the push wire once per (peer, commit), what the receiver still verifies, where the sender's memory lives, and why being wrong in either direction is cheap. The stale "On the wire nothing changed … still sends N copies" sentence in the preceding paragraph was corrected, and now points at the sibling ticket for the repair-answer half that *is* still per-block.

## How to validate

Commands run (per `tickets/rules/testing.md` — no package suite here):

- `yarn workspace @optimystic/db-p2p build` — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/block-transfer-roundtrip.spec.ts` — 8 passing (the 2 new ones below plus the 6 that were there).
- `… mocha.js test/block-transfer.spec.ts test/block-transfer-push-persist.spec.ts test/source-block-certification.spec.ts test/block-archive-proof.spec.ts test/spread-on-churn.spec.ts test/under-replication-drain.spec.ts` — 144 passing.
- `… mocha.js test/storage-repo.spec.ts` — 160 passing. `… mocha.js test/logger.spec.ts` — 30 passing.
- `yarn lint:docs`, `yarn lint:deps`, `npx eslint` on the four changed/added files — all clean.

No pre-existing failure surfaced, so nothing was written to `tickets/.pre-existing-error.md`.

Use cases worth exercising by hand or by eye:

- **The case the ticket exists for:** a solo node that bulk-imported gains a second machine, and the cohort-growth push copies every block it holds. Every block of one commit after the first now puts a ~50-character hash on the wire instead of the whole proof.
- **A cold peer, then a warm one.** First block of a commit → proof inline. Every later block of that commit to that peer → reference only.
- **A peer that restarts mid-copy**, or whose store resolves no references at all: it answers `unresolvedProofs`, the sender re-pushes inline, the block lands one round trip later. Distinguishable in the log by `push:proof-ref-unknown` versus `push:proof-ref-no-store`.
- **A reference naming a proof the receiver holds that does not cover this block or revision**: refused `claim-not-in-message`, and the hash is *not* in `unresolvedProofs` (it resolved), so the sender does not retry — resending the same proof would fail identically. Worth re-checking by eye that the claim step really is unmemoized (it is, by construction in `verifyBlockCommitProofClaim`).
- **A hostile reference**: a non-string, an over-long string, one naming nothing. The guard in `resolveProof` runs before any store read, so at most one store read per block id per request and no read keyed on an arbitrarily large value.

## Tests added

- `block-transfer-roundtrip.spec.ts` — "a second block of one commit names the proof the peer already holds instead of carrying it": pushes two blocks of ONE commit to one peer through the real `pushBlockToPeers` against a real `BlockTransferService` on the strict default, and asserts on the frames the service actually received — request 1 carries `blockProofs` and no `proofRefs`, request 2 carries `proofRefs` naming the proof's `messageHash` and no `blockProofs` at all, there are exactly two requests (so the reference cost no extra round trip), and both revisions landed *certified* on the receiver. This is the whole specification of the change.
- `block-transfer-roundtrip.spec.ts` — "a reference the receiver cannot resolve is reported back, and the retry carries the proof inline": same harness with a receiver that persists normally but resolves no reference. Asserts the answer named the hash in `unresolvedProofs`, that the strict-default receiver refused the block on that attempt, that a third request followed carrying the proof inline, and that the block ended up certified on the receiver.

Supporting test helpers added to that spec: `certifiedCommitSource` (a source repo holding every block of one commit under that commit's single proof — the only shape in which a per-(peer, commit) reference is observable), and frame capture in `makeWiredNetwork` (`received.requests()` / `received.responses()`), which tees and copies the length-prefixed frames each side read so a wire-shape test asserts on frames rather than on log lines.

Nothing else earned a test, and the reviewer should push back if any of these calls look wrong: `PeerProofMemory` is an `LruMap` wrapper, `StorageRepo.getCommitProof` is a one-line delegate, and the certification rules the resolved proof feeds are already pinned in `block-transfer-push-persist.spec.ts` and `source-block-certification.spec.ts`.

## Known gaps and judgement calls

- **The hostile-reference guard has no test.** The ticket called for "an assertion at the seam plus inspection" and that is what shipped (`MAX_PROOF_REF_CHARS`, the `typeof`/length check in `resolveProof`, both ahead of any store read). A reviewer who wants the guard pinned would be adding a test, not fixing a defect.
- **An invalid reference is not echoed back in `unresolvedProofs`.** A non-string or over-long value is logged `push:proof-ref-invalid` and treated as no reference at all, so the sender gets no retry signal for it and the block is refused like any proof-less push. Deliberate: no honest sender produces one, and echoing would hand a peer back its own junk at its own chosen size. The cost is that a *buggy* honest sender sees a refusal rather than a retry, diagnosable only from the receiver's log.
- **`unresolvedProofs` is absent from the two whole-request answers** — the `!request.blocks` early return and the fault path in `handleRequest` that answers every block `missing`. No retry fires in either case and the block is refused as it is today; this is covered by the existing accepted-tradeoff `NOTE:` on `BlockTransferRequest` about builds either side of a push-shape change.
- **`docs/debugging.md` was touched beyond the ticket's docs TODO** — six words added to the `block-transfer-service` row naming the two new reference-diagnostic lines, so the operator-facing index for that namespace stays true. Say so if that is unwanted scope.
- **No full package suite was run** (project rules put that here, in review): `yarn workspace @optimystic/db-p2p test` is the one that matters, plus whatever covers `IBlockReplicaStore` doubles outside the specs listed above.

## Tripwires parked at their sites

Three `NOTE:` comments in `pushBlockToPeers`, all conditional-and-fine-now rather than latent defects:

- **Concurrent cold pushes.** `BlockTransferCoordinator` runs up to `maxConcurrency` (default 4) block pushes in parallel, so against a cold memory up to that many inline copies of one commit's proof can be in flight to one peer before the first answer warms it. Noise against the per-block copies removed; joining an in-flight push per (peer, hash) — the way `KvRawStorage.ensureCommitProof` joins an in-flight save — would make it exactly one, at the cost of serializing a commit's pushes behind its first block.
- **A receiver that accepts a block and retains no proof for it** (a diverged holder reached through `saveReplicatedBlock`'s monotonic no-op) is remembered as holding the proof anyway, so every later reference for that commit comes back unresolved and each of that commit's blocks costs that peer two pushes. Bounded, abnormal, still strictly fewer proof bytes than before; an exact answer needs the receiver to report what it *retained*, which `saveReplicatedBlock` does not return today.
- **A block whose bytes plus its proof exceed `MAX_BLOCK_MESSAGE_BYTES`** still fails locally in `ProtocolClient.processMessage`, by name, surfacing as `unreachable` — but now only for the first block per (peer, commit) rather than every one, so the reference path is what makes the rest of such a commit placeable at all.
