description: A chained log's tamper-evident block links were computed against the wrong neighbor when many entries were appended at once; this fixes the linkage and pins down exactly which fields the link hash covers.
files: packages/db-core/src/chain/chain.ts, packages/db-core/src/log/log.ts, packages/db-core/docs/logs.md, packages/db-core/test/chain.spec.ts, packages/db-core/test/log.spec.ts
difficulty: medium
----

## What this ticket was

Two defects in the append path of the block-`Chain` / `Log` layer, both confirmed by reproducing tests.

**Defect 1 (the real bug).** `Chain.add` fills the current tail block, then loops creating one new
block per remaining batch of 32 entries. Each iteration calls the caller's `newBlock(newTail, predecessor)`
hook. It passed `oldTail` (the tail as it was *before* the loop) as the predecessor every iteration,
instead of the running `tail` (the immediately preceding block). So a single `add(...)` spanning ≥3
blocks told the 2nd, 3rd, … new block their predecessor was the *original* tail. The `Log` layer's
`newBlock` hook hashes that predecessor to produce each block's `priorHash`, so a multi-block single
append silently linked the tamper-evident hash chain to the wrong block.

Latent in production only because `Log` appends one entry per `Chain.add`, so no single call spanned
multiple new blocks — but the general `Chain.add` contract was broken for any multi-block batch.

**Defect 2 (hashed bytes ≠ stored bytes).** The `Log` hook hashed the whole predecessor block via
`JSON.stringify`. At hash time the predecessor's `nextId` is still `undefined` (it is assigned one
line later, in `Chain.add`), so `JSON.stringify` omitted it; the *stored* block then serializes *with*
a real `nextId`. A verifier re-hashing a stored block would get a different digest than recorded. No
verifier existed yet, so this was latent, and the covered-field set was entirely undocumented.

## What was changed

- **`packages/db-core/src/chain/chain.ts`** (~line 124): pass the loop-local `tail` (running
  predecessor) to `newBlock`, not `oldTail`. `newTail.priorId = tail.header.id` was already correct
  and is unchanged.
- **`packages/db-core/src/log/log.ts`**: added exported `logBlockHashPayload(block)` — the single
  canonical hash-payload definition. It strips the mutable structural links (`nextId`, `priorId`) and
  keeps the content-bearing fields (`header`, `entries`, `priorHash`). The `newBlock` hook now hashes
  `logBlockHashPayload(oldTail)` instead of the raw block. Also made `Log.getChainOptions` public
  (was `private static`) so tests can drive a raw `Chain` through the Log's exact `newBlock` hook.
- **`packages/db-core/docs/logs.md`**: new *Canonical `priorHash` payload* subsection under *Block
  Integrity* — a covered/excluded field table and the rule that any future verifier MUST re-hash
  `logBlockHashPayload(predecessor)` and compare to the successor's stored `priorHash`.
- **Tests** (`chain.spec.ts`, `log.spec.ts`): two regression tests, described below.

## How to validate

From `packages/db-core`:

```
yarn build
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min
```

Full suite result after the fix: **1071 passing, 0 failing**; `yarn build` (tsc) exits 0.

### The two new regression tests (and proof they bite)

- `chain.spec.ts` → *"should pass the running predecessor to newBlock across multiple new blocks"*:
  a chain with a recording `newBlock` hook; one `add()` of `EntriesPerBlock * 3` entries (32 fill the
  tail, 64 → two new blocks → two hook calls). Asserts the 2nd new block's predecessor is the *first
  new block*, not the original tail, and that `priorId` links stay correct end to end.
- `log.spec.ts` → *"should link the priorHash chain end to end across a single multi-block Chain.add"*:
  drives a raw `Chain` through `Log.getChainOptions(...)`, does one multi-block `add()`, walks
  head→tail, and recomputes every block's `priorHash` from `logBlockHashPayload` of its predecessor,
  comparing to the stored value.

Both were verified to **fail on the pre-fix code and pass after** by temporarily reintroducing each
defect: with the bug present the suite reported `2 failing`, and the chain test reproduced the exact
ticket symptom `AssertionError: expected 'block-1' to equal 'block-3'`. The fixes were then restored
and the suite re-run green.

Existing `log.spec.ts` / `log-invalidation.spec.ts` `priorHash` assertions (existence / `undefined`
checks) still pass — they don't recompute the digest, so the canonical-payload change is invisible to
them.

## Known gaps / things for the reviewer to probe

- **`JSON.stringify` is not a canonical encoding.** `logBlockHashPayload` is hashed via
  `JSON.stringify`, which is key-order dependent and drops `undefined`s. Correct today (blocks are
  built with a stable key order; the in-process test store preserves it via `structuredClone`), but a
  real network store/codec that reorders keys would break re-hash equality. Parked as a `NOTE:` at the
  `logBlockHashPayload` site in `log.ts` (suggesting sorted-keys / dag-cbor if it ever trips). Not
  filed as a ticket — it's conditional, and the original code already relied on `JSON.stringify`.
- **No production `priorHash` verifier exists.** `priorHash` is written but never re-checked anywhere
  in the tree. This ticket documents and tests the canonical payload so a future verifier has an exact
  contract, but the verifier itself is out of scope. If the reviewer thinks a verifier is warranted,
  that's a new `feat-`/`debt-` ticket, not a fix here.
- **Excluded-field set is defined against the `Chain` contract, not just current `Log` usage.**
  `priorId`/`nextId` are excluded because `Chain.pop`/`dequeue` rewrite them, even though `Log` itself
  never pops/dequeues today. If a future caller pops/dequeues a hashed chain, surviving blocks' hashes
  still hold because those fields aren't covered — worth a sanity check if that path is ever added.
- **`getChainOptions` visibility.** Widened from `private static` to `static` purely to let tests use
  the real hook. If the reviewer prefers stronger encapsulation, an alternative is a test-only export;
  I judged the public factory acceptable since it's pure and stateless.

## Review findings

- Tripwire: `priorHash` is hashed via `JSON.stringify` (key-order dependent, drops `undefined`).
  Parked as a `NOTE:` at `logBlockHashPayload` in `packages/db-core/src/log/log.ts`; only becomes work
  if a store/codec ever re-serializes blocks with different key order.
