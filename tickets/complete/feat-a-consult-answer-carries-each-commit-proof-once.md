description: When one machine asks another about several blocks at once, the answer used to repeat the same signed commit receipt for every block — and a receipt lists every block of its commit, so an answer about blocks of one big commit could be too large to send at all. Now each receipt travels once per answer.
architecture: docs/internals.md#durable-commit-proof-blockcommitproof
files: packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/sync/client.ts, packages/db-p2p/src/protocol-limits.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/test/block-archive-proof.spec.ts, packages/db-p2p/test/support/sync-wire.ts, packages/db-p2p/test/sync-lineage-question.spec.ts, docs/internals.md
----
# A consult answer carries each commit proof once — complete

The repair-answer half of the split out of `a-commit-proof-is-stored-once-not-once-per-block` (GitHub #60). The push half (`feat-a-push-names-a-commit-proof-the-peer-already-holds`) landed first; nothing here depends on it at runtime, only its `docs/internals.md` paragraph, which this one's paragraphs follow.

## What shipped

**The wire.** A revision entry of an archive may now NAME its commit proof instead of carrying it: `ArchiveRevisions` gains `proofRef?: string` (the proof's `messageHash`) beside the existing `proof?`, and `SyncResponse` gains `proofs?: Record<string, BlockCommitProof>` — the proofs this response's archives reference, one entry however many answered blocks that commit covers.

**Two passes, both in `storage/block-archive.ts` beside the archive shape.** `dedupeResponseProofs` walks the response's own archive and every `answers[*].archive`, moving each inline proof into the table and leaving a reference. The table is built FROM the entries it rewrites, so the server cannot mis-pair a proof with a revision it does not certify. `hydrateResponseProofs` is the inverse, total on hostile input: it resolves each reference out of the table, uses a table entry only when it is filed under its own `messageHash`, drops the reference either way, and drops the table. Both are shared helpers (`mapResponseArchives`, `mapRevisions`) that walk every revision entry rather than assuming the single-revision shape.

**Where they run.** `SyncService.answerConsult` dedupes the batched consult (after `fitConsultContent`) and `answerArchive` dedupes the single-archive repair fetch, so there is one response shape. `SyncClient.requestBlock` hydrates — the one seam a sync response crosses into this process, covering `RestorationCoordinator` and all four `requestBlock` call sites in `libp2p-node-base.ts`.

**The budget.** `CONSULT_RESPONSE_PROOF_BUDGET_BYTES` (a quarter of `MAX_BLOCK_MESSAGE_BYTES`, i.e. 2 MiB) bounds what one response spends on proofs. Proofs are weighed in answer order and admitted while their JSON sizes fit what is left; the first is always admitted, so a one-block answer is unchanged. A proof that is not admitted is dropped, and the entries that would have named it are served proof-less — not left inline, which would put back the bytes the budget exists to keep out.

**Docs.** Two paragraphs in `docs/internals.md` § "Durable commit proof (`BlockCommitProof`)", after the push paragraph: how a proof crosses the repair wire once per response with the measurements, and what replaces the structural guarantee a reference gives up. The stale "a repair answer still repeats the whole proof per block" sentence in the preceding paragraph was corrected, the "On the repair wires" bullet now mentions the reference, `ArchiveRevisions.proof`'s "impossible … by construction of the wire shape alone" claim was rewritten to say what actually holds now, and the proof-size NOTE on `serveBlockArchive` was corrected to name the commit's block count rather than its signer count as the term that dominates.

## Measurements

- One proof over a commit touching 7,000 blocks: 953,651 bytes serialized (~136 bytes per block).
- Ten claim-only answers, each about a block of a *different* such commit (the worst case for deduping — nothing is shared): 9,538,747 bytes inline, against the 8,388,608-byte frame cap — i.e. unsendable. After the pass: 1,909,677 bytes, with 2 of the 10 proofs admitted and 8 answers served proof-less.
- Unchanged: a proof-carrying single-revision archive is still 4,801 bytes at a 10-peer cohort and 8,851 at 20.
- Added in review: a 32-answer consult whose later answers all name one refused 861 KB proof now costs 11.2 ms in `dedupeResponseProofs`, against 162.7 ms before the fix below.

## Review findings

**Read first, handoff second.** The implement diff (`ticket(implement): feat-a-consult-answer-carries-each-commit-proof-once`) was read before its summary. The claims the handoff said were "verified by inspection" were instead verified by running: a throwaway probe spec drove `hydrateResponseProofs` against a table entry filed under someone else's hash, a reference naming nothing, an entry carrying both forms, a non-object answer, a non-object archive, a non-object revision entry, a `null` and an `undefined` response, and references spelled `__proto__` and `constructor`; and `dedupeResponseProofs` against a proof with no `messageHash` and a proof whose `messageHash` *was* `__proto__`. Every one degrades to proof-less with the claim intact, none throws, none mis-pairs, and nothing is polluted. The probe was deleted after it had answered — it was a review instrument, not a test worth keeping, since the three shipped tests already pin the contract and the hostile shapes are structural rather than branch-rich.

Also checked by reading and running rather than taken from the summary: that the two `SyncResponse` producers (`answerArchive`, `answerConsult`) are the only ones, so no third response shape escapes the dedupe; that all five `SyncClient.requestBlock` call sites (four in `libp2p-node-base.ts`, one in `RestorationCoordinator`) are the only seam, so hydration cannot be bypassed; that `RestoredRevision` in `BlockStorage` copies `{rev, action, block}` field by field, so neither a proof nor a reference can reach storage; that the frame arithmetic closes (a 4 MiB content budget measured with proofs still inline, plus a 2 MiB proof budget, plus claims and framing, against an 8 MiB frame); and that the new internals paragraph's `MAX_PROOF_SIGNERS` claim is real (`exceedsSignerCap` runs before any signature work).

### Major — none filed

Nothing cleared the filing bar. The findings were all small enough to fix in this pass, and the one residual hole is conditional and parked as a tripwire. No `architecture:`-anchored invariant was missing: the reference's safety rests on three properties the diff already states and the code already enforces (the table built from the entries it rewrites, the reader's self-keying check, and verification never memoizing the claim step), and the probe above confirmed them rather than finding a gap to generalize.

### Fixed in this pass

- **A refused proof was re-encoded once per entry naming it, not once per response.** `admit` short-circuited on proofs it had *admitted* but not on ones it had refused, so each later entry naming a refused proof re-ran `JSON.stringify` over it to reach the same verdict — measured at 21 encodes for 2 distinct proofs, and 162.7 ms per response at the 861 KB a 7,000-block commit's proof encodes to, on the serving node's request path, for a response that then carries no copy of that proof at all. Refusals are now memoized, which is exactly equivalent (`spent` only grows, so a proof that did not fit cannot fit later): 2 encodes, 11.2 ms. No test — the behaviour is unchanged and already pinned by the budget test; a test counting encodes would test the implementation.
- **The proof table was an object accumulator keyed by a string that is peer-chosen at the other end.** `proofs['__proto__']` reads as truthy on lookup and is swallowed on assignment, so a hash spelled `__proto__` or `constructor` took a path no hex digest ever takes. Harmless as it stood (the probe confirms the hydrating side's self-keying check catches it, and no mis-pairing results), but it is a footgun one producer change away from mattering. Now a `Map`, converted with `Object.fromEntries` at the end.
- **A third copy of the JSON-size idiom.** `db-core` exports `jsonEncodedBytes`, documented as "the measure a frame cap is judged by"; `dedupeResponseProofs` hand-rolled it. Both it and `fitConsultContent` — the pre-existing copy two functions above, which would otherwise have been left reading differently from its neighbour — now call the shared helper.
- **The admission rule's prose did not match its code.** "Proofs are admitted in answer order while the running total … stays within `budgetBytes`" reads as a budget that closes at the first refusal; the code keeps weighing, so a small proof later in the response still rides after a large one was refused. The prose now says that. The behaviour is the better of the two and was kept.
- **A stale NOTE on `buildBlockCommitProof`** (`packages/db-p2p/src/cluster/commit-proof.ts`), flagged as a known gap by the handoff and in scope as a file this change should have touched: it still said a proof grows with "the number of collections" and that "every block's stored copy" grows with it, and concluded "well inside the 1 MiB message bound". All three are now wrong — the storage half of #60 made each revision entry hold a reference, the term that dominates is the commit's *block* count, and the measurements in this ticket (528 KB over 3,383 blocks, 953 KB over 7,000) are nowhere near inside 1 MiB, which is not the bound that applies anyway (the cluster protocol frames under the 8 MiB `MAX_BLOCK_MESSAGE_BYTES`). Rewritten with the measured per-block figure and pointers to the three places the repetition is now gone.

### Tripwires parked at their sites

- **A single proof larger than the whole frame still makes its response unsendable,** losing every answer in it rather than one — the cost of always admitting the first proof. `NOTE:` at `admit`, with the bound that makes it narrow: a proof is its consensus message plus at most `MAX_PROOF_SIGNERS` signatures (~100 KB), and that message had to cross the cluster protocol under the *same* 8 MiB frame to reach consensus, so only a commit in the last ~100 KB of the frame can produce a proof past it. Revisit if a proof grows a payload its message did not carry, or if the two protocols stop sharing one frame cap.

### Accepted tradeoffs left standing

- **The `answerArchive` dedupe.** The `NOTE:` at the site weighs saving no bytes on a single-archive answer against the cost to an asker that reads `proof` but not `proofRef`, and keeps one response shape. Reviewed and agreed: the real-wire test drives both shapes and they behave identically, and the alternative is two answer shapes for the hydration pass to keep in step. Not re-litigated.
- **The dedupe running after `fitConsultContent`.** The `NOTE:` at that call site states the consequence (a response carrying a large proof fits less content than it strictly could) and why the ordering errs the safe way (a block answered without its bytes is asked for again; an over-full frame loses everything). Verified against the code: `fitConsultContent` measures only answers that carry bytes, so the over-counting is confined to those, and the frame arithmetic above still closes. Left alone.

### Tests

All three tests the implement stage added were reviewed as code and kept; none was cut, and none was added.

- **`carries one commit's proof once however many of its blocks the response answers about`** — pins the shape, the byte-level claim (one signature copy encoded against three) and the round trip, and re-verifies the restored proof of the block whose own copy never crossed the wire. Earns its place.
- **`leaves out the proofs past its budget, keeping a response that could not be sent at all under the frame cap`** — the liveness case the whole ticket exists for, with a self-checking fixture that asserts the inline response really is unsendable before asserting the deduped one is not, so it fails loudly rather than silently weakening if proof sizes change. The most expensive test in the file at ~0.6 s; worth it.
- **`is relocated by the real service and restored by the real client, on both answer shapes`** — the handoff flagged this as one test beyond the plan, which judged the two call sites to be wiring. Agreed with the implementer against the plan: both passes run on opposite sides of the wire and are invisible to a caller holding a response, so a server that stopped deduping or a client that stopped hydrating would quietly decay every repair answer to corroboration with nothing failing. Nothing else in the suite crosses the real sync wire with a proof. It also happens to be the only coverage of the `answerArchive` dedupe.
- **One supporting move reviewed:** the real-wire harness extracted from `sync-lineage-question.spec.ts` into `test/support/sync-wire.ts`. A pure move with both original cases still passing, and the right call — a second hand-rolled wire harness is how one spec ends up asserting against a response no real client reads.

## Validation run

Per `tickets/rules/testing.md`, the full suites once, after the fixes above:

- `yarn workspace @optimystic/db-p2p test` — 3852 passing, 84 pending.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 1429 passing, 14 pending, plus its smoke script.
- `yarn workspace @optimystic/db-p2p test:integration` — 60 passing, 2 pending (the change touches the sync protocol, so networking).
- `yarn lint` (eslint over the repo), `yarn lint:docs` (49 documents, 850 anchored citations, 910 file mentions, 818 links, all resolve), `yarn lint:deps` — all clean.
- `yarn check:rn` — passes (the change adds a value import to `block-archive.ts`, which ships to React Native).
- `yarn build` in `packages/db-p2p` — clean.

No pre-existing failures surfaced.

## Follow-on work, unchanged

Cross-request dedup stays out of scope: `feat-a-consult-answer-omits-a-proof-the-asker-already-holds` is parked in `tickets/backlog/`.
