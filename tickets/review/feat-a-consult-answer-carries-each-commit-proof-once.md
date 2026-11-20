description: When one machine asks another about several blocks at once, the answer used to repeat the same signed commit receipt for every block — and a receipt lists every block of its commit, so an answer about blocks of one big commit could be too large to send at all. Now each receipt travels once per answer.
architecture: docs/internals.md#durable-commit-proof-blockcommitproof
files: packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/test/block-archive-proof.spec.ts, packages/db-p2p/test/support/sync-wire.ts, packages/db-p2p/test/sync-lineage-question.spec.ts, docs/internals.md
----
# A consult answer carries each commit proof once — review

The repair-answer half of the split out of `a-commit-proof-is-stored-once-not-once-per-block` (GitHub #60). The push half (`feat-a-push-names-a-commit-proof-the-peer-already-holds`) landed first and is complete; nothing here depends on it at runtime, only its `docs/internals.md` paragraph, which this one's paragraph now follows.

## What shipped

**The wire.** A revision entry of an archive may now NAME its commit proof instead of carrying it: `ArchiveRevisions` gains `proofRef?: string` (the proof's `messageHash`) beside the existing `proof?`, and `SyncResponse` gains `proofs?: Record<string, BlockCommitProof>` — the proofs this response's archives reference, one entry however many answered blocks that commit covers.

**Two passes, both in `storage/block-archive.ts` beside the archive shape.** `dedupeResponseProofs(response, budgetBytes)` walks the response's own archive and every `answers[*].archive`, moving each inline proof into the table and leaving a reference. The table is built FROM the entries it rewrites, so the server cannot mis-pair a proof with a revision it does not certify. `hydrateResponseProofs(response)` is the inverse, total on hostile input: it resolves each reference out of the table, uses a table entry only when it is filed under its own `messageHash`, drops the reference either way, and drops the table. Both are shared helpers (`mapResponseArchives`, `mapRevisions`) that walk every revision entry rather than assuming the single-revision shape.

**Where they run.** `SyncService.answerConsult` dedupes the batched consult (after `fitConsultContent`) and `answerArchive` dedupes the single-archive repair fetch, so there is one response shape. `SyncClient.requestBlock` hydrates — the one seam a sync response crosses into this process, covering `RestorationCoordinator` and all four `requestBlock` call sites in `libp2p-node-base.ts`.

**The budget.** `CONSULT_RESPONSE_PROOF_BUDGET_BYTES` (a quarter of `MAX_BLOCK_MESSAGE_BYTES`, i.e. 2 MiB) bounds what one response spends on proofs. Proofs are admitted in answer order while their JSON sizes fit; the first is always admitted, so a one-block answer is unchanged. **A proof that is not admitted is dropped, and the entries that would have named it are served proof-less** — not left inline, which would put back the bytes the budget exists to keep out. Same treatment for a proof with no usable `messageHash` to be keyed by (locally impossible; such a proof could never verify either, since verification recomputes that hash and compares it).

**Docs.** Two paragraphs in `docs/internals.md` § "Durable commit proof (`BlockCommitProof`)", after the push paragraph: how a proof crosses the repair wire once per response with the measurements, and what replaces the structural guarantee a reference gives up. The stale "a repair answer still repeats the whole proof per block" sentence in the preceding paragraph was corrected, and the "On the repair wires" bullet now mentions the reference. `ArchiveRevisions.proof`'s "impossible … by construction of the wire shape alone" claim was rewritten to say what actually holds now. The proof-size NOTE on `serveBlockArchive` was corrected: a proof's size is dominated by its commit's block count (linear, via the message's `blockDigests`), not by its signer count, and the per-response total is now bounded by the proof budget.

## Measurements

Taken on this tree, not estimated:

- One proof over a commit touching 7,000 blocks: **953,651 bytes** serialized.
- Ten claim-only answers, each about a block of a *different* such commit (the worst case for deduping — nothing is shared): **9,538,747 bytes** inline, against the 8,388,608-byte frame cap — i.e. unsendable today. After the pass: **1,909,677 bytes**, with 2 of the 10 proofs admitted and 8 answers served proof-less.
- Unchanged: a proof-carrying single-revision archive is still 4,801 bytes at a 10-peer cohort and 8,851 at 20 (the existing size test prints both).

## Use cases to exercise when validating

- **An ordinary batched read across one commit.** Several blocks of one commit, consulted in one request: the response should carry that commit's proof once and every answer should read back with the proof in its revision entry. This is the common case — a read over a few blocks the same transaction wrote.
- **A read across blocks of many large commits.** The liveness case: before this change the response could not be encoded or decoded at all and the whole consult failed. Now it fits, with the answers past the budget degrading to proof-less claims that the asker corroborates instead.
- **A one-block consult and a single-archive repair fetch** (`RestorationCoordinator`, `fetchArchiveFromPeer`): byte count and behaviour should be indistinguishable from before, the proof merely relocated and restored.
- **Mixed builds.** An older server sends inline proofs and no table; hydration must leave such a response exactly as it is (the `sync-lineage-question` spec's uncertified repo exercises the no-proof shape over the real wire). An older *asker* sent references reads proof-less archives and falls back to corroboration — see the accepted tradeoff below.
- **A hostile response.** A reference naming nothing, a table entry filed under someone else's hash, an entry carrying both forms, a non-object answer or revision entry, a response that is not an object: every one must degrade to proof-less and never to a mis-paired artifact or a throw. Hydration does no cryptography.

## Tests

Added to `packages/db-p2p/test/block-archive-proof.spec.ts`, in a new `describe('a commit proof crosses the repair wire once per response')`:

- **`carries one commit's proof once however many of its blocks the response answers about`** — pins the shape and the round trip. Three answers of one commit in the three shapes a consult produces (bytes carried, bytes omitted as `'held'`, an archive beside a `lineage` answer); asserts one table entry keyed by the proof's own hash, every entry naming it, **one copy of a proof signature in the encoded response against three inline**, and that hydration through JSON restores the response byte-identically to the pre-dedupe form. Also re-verifies the restored proof of the *last* block — whose own copy never crossed the wire — against its claim.
- **`leaves out the proofs past its budget, keeping a response that could not be sent at all under the frame cap`** — the liveness case, with the fixture self-checking: it asserts the inline response exceeds `MAX_BLOCK_MESSAGE_BYTES` before asserting the deduped one is under it, so the test fails loudly rather than silently weakening if proof sizes change. Asserts which proofs are admitted (in answer order), that admitted ones hydrate, that the rest leave their answers proof-less with the claim intact, and that no reference reaches a consumer. Runs in ~0.5 s.
- **`is relocated by the real service and restored by the real client, on both answer shapes`** — **one test beyond what the plan called for.** The plan judged the service and client call sites to be wiring; they are not observable as such. Both passes run on opposite sides of the wire and a caller holding a response cannot tell whether either ran, so if the server stopped deduping or the client stopped hydrating, every repair answer would quietly lose its proof and decay to corroboration with nothing failing. Nothing else in the suite crosses the real sync wire with a proof: the mesh harness short-circuits to `serveConsultAnswer` with no wire in between, and the existing round-trip test does `JSON.parse(JSON.stringify(...))` by hand. This drives a real `SyncService` and `SyncClient` over a linked duplex pair and asserts the proof arrives inside the revision entry, with neither the reference nor the table visible, for both the batched consult and the single-archive fetch.

Nothing else earned a test. No test was added for the mixed-build directions, the hostile-table bounds or the storage-never-sees-a-reference claim — those are verified by inspection, as the plan asked.

**One supporting move:** the real-wire harness was extracted from `test/sync-lineage-question.spec.ts` into `test/support/sync-wire.ts` (`syncWire`) and that spec now imports it. A pure move — no behaviour change, both its cases still pass — done rather than hand-rolling a second wire harness, for the reason `commit-proof-fixtures.ts` is shared.

## Deliberate decisions a reviewer should weigh

- **Accepted tradeoff recorded at `answerArchive`.** Deduping the single-archive answer saves no bytes (it carries at most one proof) and costs an asker on a build that reads a revision entry's `proof` but not its `proofRef`: it sees a proof-less archive and falls back to corroboration. A narrow window — reading a proof off the repair wire at all is recent — and the plan asked for one response shape rather than two. Weighed and kept, with a `NOTE:` at the site naming the revisit condition. If the reviewer disagrees, confining the dedupe to `answerConsult` is a two-line change.
- **The dedupe runs AFTER `fitConsultContent`,** as the plan specified, so the content budget measures each archive with its proof still inside and a response carrying a large proof fits less content than it strictly could. `NOTE:` at the call site: a block answered without its bytes is simply asked for again, whereas an over-full frame loses everything.
- **Tripwire at `admit`:** a `messageHash` already admitted serves every later entry naming it, so two proofs of one message differing in which votes they carry would both be served as the first one's. Fine today — storage keeps one proof per `messageHash`, so every entry of a response reads the same object. `NOTE:` at the site says to compare before collapsing if that ever changes.
- **`hydrateResponseProofs` returns a non-object response untouched** rather than throwing, so "total on hostile input" holds for a peer that frames `null`. Its callers already read such a response as a failed request.

## Known gaps

- No package suite was run here: per `tickets/rules/testing.md` the review stage runs it once. The commands run are listed below.
- `buildBlockCommitProof`'s NOTE in `packages/db-p2p/src/cluster/commit-proof.ts` still says "a batch's proof — and every block's stored copy of it — grows with the number of collections the record commits". The storage half of #60 made "every block's stored copy" stale (each revision now holds a reference). Left alone as outside this ticket's diff; flagged rather than fixed so the reviewer can decide whether it is worth a line.
- Cross-request dedup is explicitly out of scope and unchanged: `feat-a-consult-answer-omits-a-proof-the-asker-already-holds` is parked in `tickets/backlog/`.

## Validation run

From `packages/db-p2p`:

- `yarn build` — clean.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/block-archive-proof.spec.ts test/sync-lineage-question.spec.ts` — 29 passing.
- `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/coordinator-repo-read-repair-content.spec.ts test/coordinator-repo-single-holder.spec.ts test/coordinator-repo-solo-self-bypass.spec.ts test/reconcile-block.spec.ts test/consult-round.spec.ts test/cohort-growth-heals-single-holder.spec.ts test/restoration-coordinator.spec.ts test/served-repo-proxy.spec.ts test/inbound-message-caps.spec.ts test/rpc-response-deadline.spec.ts test/quorum-restore-certified.spec.ts` — 141 passing (every spec that reaches the consult, repair, sync-wire or certified-claim paths this diff touches).

From the repo root:

- `yarn lint:docs` — 49 documents, 850 anchored citations, 910 file mentions, 818 links, all resolve.
- `yarn lint:deps` — every import declared.
- `npx eslint` over the six changed sources and three changed test files — clean.
