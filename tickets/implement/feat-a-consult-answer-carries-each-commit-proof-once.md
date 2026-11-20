description: When one machine asks another about several blocks at once, the answer repeats the same signed commit receipt for every block, and that receipt lists every block of the commit — so an answer about blocks from one large commit is enormous and can be too big to send at all. Carry each receipt once per answer.
prereq: feat-a-push-names-a-commit-proof-the-peer-already-holds
architecture: docs/internals.md#durable-commit-proof-blockcommitproof
files: packages/db-p2p/src/storage/struct.ts (`ArchiveRevisions`), packages/db-p2p/src/sync/protocol.ts (`SyncResponse`), packages/db-p2p/src/storage/block-archive.ts (`singleRevisionArchive`, `latestClaimFromArchive`, `fitConsultContent`, `serveBlockArchive`'s size NOTE), packages/db-p2p/src/sync/service.ts (`answerConsult`, `answerArchive`), packages/db-p2p/src/sync/client.ts (`requestBlock`), packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/test/block-archive-proof.spec.ts, docs/internals.md
difficulty: medium
----
# A consult answer carries each commit proof once

The repair-answer half of the split out of `a-commit-proof-is-stored-once-not-once-per-block` (GitHub #60); `feat-a-push-names-a-commit-proof-the-peer-already-holds` is the push half and lands first (both add a paragraph to the same section of `docs/internals.md`, and this one's paragraph refers to the shape that one introduces).

## What happens today

A block's `BlockCommitProof` rides INSIDE each revision entry of the archive that carries it (`ArchiveRevisions.proof` in `packages/db-p2p/src/storage/struct.ts`), and a proof carries its consensus message verbatim — whose commit operation lists every block id and declared digest of the commit. So a proof's size is linear in its commit's block count.

One latest-revision consult asks about up to `MAX_CONSULT_BATCH_BLOCKS` (32) blocks and is answered with one `SyncBlockAnswer` per block (`SyncService.answerConsult`, each built by `serveConsultAnswer`). Every answer carries the proof for the revision it serves — including an answer whose block bytes were left out, because `withoutContent` deliberately keeps the claim's proof. So an answer about 32 blocks of one commit repeats one proof 32 times.

Two consequences, not one:

- **Bandwidth.** 32 copies of a proof whose size grows with the commit. From the reporter's numbers (not measured on the wire): one 528 KB proof covered 3,383 blocks.
- **The response may not be sendable at all.** `fitConsultContent` budgets only the archives that carry block BYTES (`CONSULT_RESPONSE_CONTENT_BUDGET_BYTES`, 4 MiB). Proofs are outside every budget, so 32 answers each carrying a 528 KB proof come to about 17 MB against the 8 MiB frame both sides frame the response under (`MAX_BLOCK_MESSAGE_BYTES`) — the response cannot be encoded or decoded, and the whole consult fails. A read over several blocks of one large commit is an ordinary thing to do, so this is a liveness hole, not just waste.

The size NOTE on `serveBlockArchive` reasons about proof size as "two signatures plus a peer id per cohort member … reaching 8 MiB would take a cohort in the tens of thousands". That omits the commit message's `blockDigests` term entirely, which is the term that actually matters here. It must be corrected as part of this work.

## What cannot be done

Trimming a proof to the one block being claimed — the signatures cover the whole consensus message. See the same section of the push ticket.

## The design

**One proof table per response, named from the revision entries.**

`ArchiveRevisions`' entry gains a reference as the alternative to the inline proof:

```ts
/**
 * The `messageHash` of the proof for this revision, when the proof travels in the response's own
 * table ({@link SyncResponse.proofs}) instead of inside this entry — so a response answering several
 * blocks of one commit carries that commit's proof once rather than once per block.
 *
 * Resolved back into {@link proof} at ONE seam, as a response is read (`SyncClient.requestBlock`), so
 * no consumer of an archive ever sees a reference. Never stored: `BlockStorage.saveRestored` ignores a
 * revision entry's `proof`, and ignores this for the same reason.
 */
proofRef?: string;
```

`SyncResponse` gains:

```ts
/**
 * The proofs this response's archives reference, keyed by `BlockCommitProof.messageHash` — one entry
 * however many of the answered blocks that commit covers. Resolved into each referencing revision
 * entry as the response is read; an entry filed under a key that is not its own `messageHash`, and a
 * reference naming nothing here, are both dropped, leaving the archive proof-less — the pre-proof
 * shape every consumer already tolerates.
 */
proofs?: Record<string, BlockCommitProof>;
```

Two functions, both in `storage/block-archive.ts` beside the archive shape — the same "one place or the three sites drift" reasoning `singleRevisionArchive` already carries:

- `dedupeResponseProofs(response, budgetBytes)` — the server-side pass. Walks `response.archive` and every `response.answers[*].archive`, and for each revision entry holding a `proof`, moves it into the table and replaces it with `proofRef`. Because the table is built FROM the entries it rewrites, the server cannot mis-pair a proof with a revision it does not certify. Proofs are admitted to the table in answer order while the running total of their JSON size stays within `budgetBytes`; the FIRST proof is always admitted, so a one-block consult is answered as it is today with the proof merely relocated. A proof past the budget is not admitted and the references naming it are dropped, so those answers are proof-less — which every consumer must already handle (a pre-proof revision, a diverged member and an un-upgraded peer all legitimately answer without one).
- `hydrateResponseProofs(response)` — the client-side pass, total on hostile input. Replaces each `proofRef` with `response.proofs[ref]`, checks the carried proof's own `messageHash` equals the key it is filed under (so "the key is the proof's hash" is enforced at this one seam), and drops the reference either way. Called once in `SyncClient.requestBlock` before the response is returned, which is the only place a sync response crosses into this process (`RestorationCoordinator` and the four `requestBlock` call sites in `libp2p-node-base` all go through it).

`SyncService` applies the dedupe to both answer shapes — `answerConsult` and the single-archive `answerArchive` — so there is one response shape rather than two.

New limit in `protocol-limits.ts`:

```ts
/**
 * How many bytes one sync response may spend on the proofs its archives reference
 * ({@link SyncResponse.proofs}), measured as the JSON-encoded size of each proof admitted. Past it a
 * proof is left out and the answers naming it are served proof-less — the pre-proof shape. The first
 * proof is always admitted, so a one-block answer is unchanged.
 *
 * A quarter of {@link MAX_BLOCK_MESSAGE_BYTES}: with the content budget's half, that leaves a quarter
 * of the frame for the claims, the lineage answers and the framing. A proof is kilobytes in ordinary
 * use — the budget bites only on a commit touching thousands of blocks, which is exactly the case
 * that used to make the response unsendable.
 */
export const CONSULT_RESPONSE_PROOF_BUDGET_BYTES = MAX_BLOCK_MESSAGE_BYTES / 4;
```

**Ordering: dedupe runs AFTER `fitConsultContent`, not before.** That leaves `withoutContent` and `latestClaimFromArchive` untouched (they keep seeing inline proofs), at the cost of the content budget measuring each archive with its proof still inside — so a response carrying a large proof fits less content than it strictly could. That is the conservative direction: a block answered without its bytes is simply re-asked for (`'size'` is documented as a reason the asker must follow up on), whereas an over-full frame loses the whole response. Record the over-count as a NOTE on the dedupe call site.

### What this does not do

It dedupes WITHIN one response, not across consults. Cross-request dedup is mostly not available here: the asker wants the proof for a revision it does not hold, so it cannot name that proof's hash in advance. The one case where it could — a `contentOmitted: 'held'` answer, where the peer sends back a proof for the very revision the asker already holds — is parked as `feat-a-consult-answer-omits-a-proof-the-asker-already-holds` in `tickets/backlog/`, because it changes who supplies the evidence behind a certified claim and deserves its own argument.

## Edge cases & interactions

- **Several answers of one response sharing a commit** → one table entry, each entry carrying `proofRef`, and every consumer sees the proof restored after hydration. *Verified by a test.*
- **Distinct proofs past the proof budget** → the ones past it are left out and their references dropped; the response still encodes under the frame cap and those answers read as proof-less. *Verified by a test* — this is the case that is unsendable today.
- **A one-block consult, and the single-archive repair fetch** (`answerArchive`, which `RestorationCoordinator` and `fetchArchiveFromPeer` use) → one table entry, always admitted, hydrated back; byte count and behaviour otherwise unchanged. *Verified by inspection* plus the existing specs staying green.
- **`proofRef` naming nothing in the table**, and **a table entry filed under a key that is not its own `messageHash`** → both drop to no proof, never to a mis-paired artifact. *Verified by an assertion at the hydration seam.*
- **The structural guarantee weakens, deliberately.** `ArchiveRevisions.proof`'s doc currently claims that keying the proof inside the revision entry makes it impossible "by construction of the wire shape alone" for a serving bug or a hostile peer to pair a genuine proof with a different revision. With a reference, the wire shape no longer forbids it; what forbids it is that the only producer builds the table from the entries themselves, and that every consumer verifies the claim (`verifyBlockCommitProofClaim`'s unmemoized claim step) before the proof is evidence of anything. Presence was never evidence. **Update that doc comment to say so** rather than leaving a claim the shape no longer backs.
- **A hostile response with a huge table** → bounded by the frame cap the client decodes the response under, and each proof is still capped at `MAX_PROOF_SIGNERS` before any signature work (`certified-claims.ts`). Hydration itself does no cryptography. *Verified by inspection.*
- **A multi-revision archive** would need one reference per revision entry. `singleRevisionArchive` is the only producer of an archive that crosses a wire, so this cannot arise today; the dedupe and hydration passes must nonetheless walk every entry rather than assume one. *Verified by inspection* — and the existing compatibility NOTE on `singleRevisionArchive` already flags a second producer as the thing that would need new tests.
- **Storage never sees a reference.** `BlockStorage.saveRestored` ignores a revision entry's `proof` on purpose (a remote archive's proof must never be re-served as this node's own retained evidence) and ignores an unknown field the same way; hydration runs before any archive reaches storage regardless. *Verified by inspection.*
- **The node's self short-circuit** answers the consult about itself straight out of its own repo (`libp2p-node-base`, via `serveConsultAnswer`) with no wire in between — no table, no hydration, and nothing to change. *Verified by inspection.*
- **An answer whose lineage reply rides beside the archive** (`SyncBlockAnswer.lineage`) must survive both passes untouched — the same thing `withoutContent`'s spread-first comment protects. *Verified by inspection.*
- **A peer on an older build** sends inline proofs and no table; hydration leaves such a response exactly as it is. An older ASKER receiving references gets proof-less archives and falls back to corroboration — the degradation the pre-proof path already defines. *Verified by inspection.*

## Tests

Two cases in `packages/db-p2p/test/block-archive-proof.spec.ts`, which already builds real proofs and pins their serialized sizes against the frame cap:

- A batched consult answering several blocks of one commit carries that commit's proof once in `proofs`, each answer referencing it, and hydration restores an identical proof to every answer.
- A response whose proofs would exceed the proof budget: the admitted ones hydrate, the rest leave their answers proof-less, and the encoded response stays under `MAX_BLOCK_MESSAGE_BYTES`.

Both pin named pieces of the specification on real branching. Nothing else earns a test — the service and client call sites are wiring, and the existing archive, consult and lineage specs already cover the shapes around them.

Per `tickets/rules/testing.md`, run no package suite here — the review stage runs it once.

## TODO

- Add `ArchiveRevisions`' `proofRef` and `SyncResponse.proofs` with the doc comments above, and rewrite `ArchiveRevisions.proof`'s "by construction of the wire shape alone" paragraph to say what actually holds now.
- Add `CONSULT_RESPONSE_PROOF_BUDGET_BYTES` to `protocol-limits.ts` with its share-of-the-frame arithmetic.
- Add `dedupeResponseProofs` and `hydrateResponseProofs` to `storage/block-archive.ts`, both walking `archive` and every `answers[*].archive`, and both total on hostile input.
- Apply the dedupe in `SyncService.answerConsult` (after `fitConsultContent`, with the over-count NOTE) and in `answerArchive`; apply the hydration once in `SyncClient.requestBlock`.
- Correct the proof-size NOTE on `serveBlockArchive`: a proof's size is dominated by its commit message's `blockDigests` — linear in the commit's block count — not by its signer count, and a response's total is now bounded by the proof budget rather than unbounded.
- Add the two cases to `block-archive-proof.spec.ts`.
- Add a paragraph to `docs/internals.md` § "Durable commit proof (`BlockCommitProof`)" on how a proof crosses the repair wire once per response, next to (not inside) the push paragraph that ticket's predecessor added.
