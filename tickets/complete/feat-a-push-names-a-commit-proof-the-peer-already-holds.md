description: A machine copying many blocks to another machine used to re-send the same signed commit receipt with every block; now the first block of a commit carries the receipt and every later one just names it, and the other machine says so if it cannot find the one being named.
architecture: docs/internals.md#durable-commit-proof-blockcommitproof
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/peer-proof-memory.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/block-transfer-roundtrip.spec.ts, packages/db-p2p/test/peer-proof-memory.spec.ts, docs/internals.md, docs/debugging.md
----
# A push names a commit proof the peer already holds — complete

The push half of the split out of `a-commit-proof-is-stored-once-not-once-per-block` (GitHub #60). The repair-answer half is `feat-a-consult-answer-carries-each-commit-proof-once`, still in `implement/`, and its `docs/internals.md` paragraph follows the one added here.

## What shipped

A commit proof carries its whole consensus message, which lists every block id and declared digest of the commit — so a proof's size grows with the commit's block count, and copying all N blocks of one commit to one peer put N copies of the same proof on the wire. In the case GitHub #60 reported (one 528 KB proof over 3,383 blocks) that was about 1.7 GB of proof beside the blocks, by arithmetic on the stored sizes rather than a wire measurement.

**The wire.** `BlockTransferRequest` keeps `blockProofs` and gains a sibling `proofRefs?: Record<BlockId, string>` — per block, the `messageHash` of the proof that certifies it, as an alternative to carrying the proof. `BlockTransferResponse` gains `unresolvedProofs?: string[]`, the message hashes a request *referenced* that the receiver could not resolve (hashes, not block ids — a block can be accepted and its reference still unresolved). `PushCertification` gains the matching optional `proofRefs`, and `BlockTransferClient.pushBlocks` forwards it the way it forwards `blockMeta` and `blockProofs`. `sourceBlockCertification` is untouched: it still builds only the inline form from one unpinned read, and the reference is a per-peer projection made inside `pushBlockToPeers`.

**The receiver.** `handlePush` resolves a block's proof through a private `resolveProof`: the inline `blockProofs[blockId]`, else — when `proofRefs[blockId]` is a plausible hash — `repo.getCommitProof(hash)`. The resolution runs *before* the `proof-without-meta` guard, so a reference without `blockMeta` is refused for the same reason an inline proof without meta is, and everything after it is unchanged: one `certifyContent` call covers the signatures and thresholds, the claim matching the declared `(rev, actionId)`, and the declared digest matching the pushed bytes. An unresolvable reference puts the hash in `unresolvedProofs` and leaves the block on exactly the path it is on today with no proof. `IBlockReplicaStore` gains `getCommitProof?` (optional, so existing doubles and a plain embedder keep compiling); `StorageRepo` implements it as a one-line delegate to `IRawStorage.getCommitProof`, and `libp2p-node-base` already wires `serving.storageRepo` as the service's repo, so production needed no wiring change.

**The sender.** `pushBlockToPeers` — the one push loop all four senders go through — does the whole name-or-carry decision in one `pushToPeer` closure: if the memory says this peer holds the proof's hash, push `{ blockMeta, proofRefs }`; if the answer names that hash in `unresolvedProofs`, record that and push the same block once more with the proof inline, whose answer is then the peer's answer. On a confirming answer to a push that carried the proof, remember `(peer, hash)`. The retry keys off `unresolvedProofs` and never off `missing`, so a lenient receiver that took the block uncertified still gets the proof, which `StorageRepo.saveReplicatedBlock`'s non-advancing branch back-fills onto the revision it just landed. `PushBlockOutcome.certified` keeps its meaning — a proof existed *locally* for this block.

**The sender's memory** (`packages/db-p2p/src/cluster/peer-proof-memory.ts`). A bounded `(peerId, messageHash)` map in one `LruMap`, cap 4096, held in a module-level `WeakMap` keyed on the `repo` argument of `pushBlockToPeers` — which is the node's own `storageRepo` for every sender, so that object is the node's identity at this seam and two nodes in one process never share a memory. Each pair records whether the peer has been sent the proof and how often it has answered that it could not resolve it; two unresolved answers and the sender stops naming that proof to that peer, which bounds what a never-resolving store costs (see **Review findings**). Reads go through `LruMap.get`, so the pair for the commit being copied right now is the last to be evicted. Nothing expires, because nothing deletes a stored commit proof.

**Docs.** A new paragraph in `docs/internals.md` § "Durable commit proof (`BlockCommitProof`)": how a proof crosses the push wire once per (peer, commit), what the receiver still verifies, where the sender's memory lives, and what being wrong in either direction costs. The stale "On the wire nothing changed … still sends N copies" sentence in the preceding paragraph was corrected and now points at the sibling ticket for the repair-answer half that *is* still per-block. One row of `docs/debugging.md`'s `block-transfer-service` namespace names the two new reference-diagnostic log lines.

## Review findings

**Read first, handoff second.** The implement diff (`ticket(implement): feat-a-push-names-a-commit-proof-the-peer-already-holds`) was read before its summary, and the sender-identity claim the memory rests on was verified rather than taken: all four `pushBlockToPeers` call sites (`BlockTransferCoordinator`'s `this.repo`, `SpreadOnChurnDeps.repo`, the drain's `pushBlock` closure, and the spec harness) resolve to one `storageRepo` per node in `libp2p-node-base.ts`, and the block-transfer service's own repo is that same object — so references do resolve in production, and the `WeakMap` key really is per-node.

### Major — none filed

Nothing cleared the filing bar. The one defect found (below) was small enough to fix in this pass, so it needed no ticket.

### Fixed in this pass

- **A peer that resolves no reference cost two pushes per block, forever.** The sender re-remembered the pair after every inline retry, so against a replica store without `getCommitProof`, or a holder that accepts blocks and retains no proof, each block of the commit went out by reference, came back unresolved, and was re-pushed inline: the *same* proof bytes as before references existed plus a round trip each — not "strictly fewer proof bytes", as the tripwire comment at the site claimed. `PeerProofMemory` now counts unresolved answers per pair and stops naming after two (one failure is forgiven because a peer that restarted mid-copy re-files the proof from the retry and resolves the next one). The degradation is now the pre-reference behaviour plus two round trips, once per pair, and the comments and both docs that overstated the old bound were corrected. Pinned by `packages/db-p2p/test/peer-proof-memory.spec.ts`.
- **Three `proofHash!` non-null assertions** in the push loop, against AGENTS.md's "don't be type lazy". The hash and the push that names it are now one narrowed value from a `proofReference` helper, and the per-peer name-or-carry sequence moved into a `pushToPeer` closure — so the loop body is back to "push, read the answer", the memory is updated in one place next to the push that justifies it, and no assertion remains.
- **A 142-character line** left in `docs/internals.md` by the implement edit, inside a paragraph the rest of which wraps at ~97. Re-wrapped.

### Tripwires parked at their sites

- **`unresolvedProofs` is a residency oracle.** A resolvable reference is reported by its *absence* from the list, so any peer can ask "do you hold the proof for commit message H" at one structurally-valid block per probe. `NOTE:` at `resolveProof`: judged not worth hiding, because which commits a node holds blocks of is already answerable by pulling those blocks over this same protocol; revisit if block residency ever becomes confidential.
- **One store read per referenced block id, per request,** unbounded by the same reasoning as the existing per-request proof-count NOTE in `handlePush` — a frame may carry one reference per block id. Folded into that NOTE rather than given its own: a reference costs a store read where an inline proof costs a signature verification, so the per-request bound that NOTE already proposes covers both.
- **Three tripwires the implementer parked** were re-read and left standing, two unchanged (concurrent cold pushes can put up to `maxConcurrency` inline copies in flight before the first answer warms the memory; a block whose bytes plus proof exceed `MAX_BLOCK_MESSAGE_BYTES` still fails locally, but now only for the commit's first block per peer) and one rewritten to match the new bound (a receiver that accepts a block and retains no proof is still remembered, because `saveReplicatedBlock` does not report what it retained).

### Checked and found sound

- **A reference extends the sender no trust.** Verified by reading `certifyContent` → `verifyBlockCommitProofClaim`: the votes half is memoized, the claim half is not, and the votes verifier recomputes `computeClusterMessageHash` against the proof's self-reported `messageHash`. So a proof the receiver genuinely holds, presented for a block or revision it does not certify, fails `claim-not-in-message`; and because that hash is recomputed, a proof filed under some other key still cannot certify anything it does not cover.
- **The hostile-reference guard.** `typeof`, non-empty and `MAX_PROOF_REF_CHARS` all run before any store read and before the log line that echoes the value, so at most one bounded store read per block id and no log keyed on an arbitrarily large string.
- **Two whole-request answers omit `unresolvedProofs`** (the `!request.blocks` early return and `handleRequest`'s fault path, which answers every block `missing`). No retry fires and the block is refused as it is today — correct, and covered by the accepted-tradeoff `NOTE:` on `BlockTransferRequest` about builds either side of a push-shape change.
- **An invalid reference is not echoed back.** Deliberate and left alone: echoing would hand a peer its own junk at its own chosen size, and a buggy honest sender still gets a diagnosable receiver log (`push:proof-ref-invalid`).
- **File sizes.** `block-transfer-service.ts` 872 lines, `peer-proof-memory.ts` 123, the roundtrip spec 474 (`wc -l`). No split earned.

### Tests

Both of the implementer's new tests were kept: they drive the real `pushBlockToPeers` against a real `BlockTransferService` on the strict default and assert on the frames that crossed, which is the whole specification of the change — request 1 carries the proof and names nothing, request 2 names it and carries no proof, exactly two requests (so the reference cost no extra round trip), both revisions certified on the receiver; and, against a receiver that resolves no reference, the hash coming back in `unresolvedProofs`, the strict receiver's refusal, the third request carrying the proof inline, and the block certified. Their supporting harness (`certifiedCommitSource`, frame capture in `makeWiredNetwork`) is the only way to observe a per-(peer, commit) reference at all, so it earns its place. Nothing was cut: no test here restates the implementation or verifies a mock.

One test was added — `packages/db-p2p/test/peer-proof-memory.spec.ts`, two cases — for the defect fixed above. It pins the degradation policy only (a pair is named after a carrying push is confirmed; two unresolved answers stop it being named), because the wire shape and the retry it drives are already end-to-end in the roundtrip spec. `StorageRepo.getCommitProof` (a one-line delegate) and the certification rules a resolved proof feeds (already pinned in `block-transfer-push-persist.spec.ts` and `source-block-certification.spec.ts`) got none, deliberately.

The hostile-reference guard still has no test, and that is the right call rather than a gap: `MAX_PROOF_REF_CHARS` and the `typeof`/length check are a seam assertion verified by inspection, as the plan asked.

## Validation

All run from a clean tree after the review's own fixes, per `tickets/rules/testing.md`:

- `yarn workspace @optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/db-p2p test` — **3849 passing**, 84 pending, 0 failing.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` (the dependent package) — **1429 passing**, 14 pending, plus `smoke ok quereus@5.6.1`.
- `yarn workspace @optimystic/db-p2p test:integration` (the change touches networking) — **60 passing**, 2 pending.
- `yarn lint` (eslint + `lint:docs` + `lint:deps`) — exit 0.
- `yarn check:rn` — passed (Metro bundle, Hermes compile).
- `db-p2p-storage-fs` / `-ns` / `-web` / `-rn` suites — 131 / 86 / 80 / 82 passing.

No pre-existing failure surfaced, so nothing was written to `tickets/.pre-existing-error.md`.
