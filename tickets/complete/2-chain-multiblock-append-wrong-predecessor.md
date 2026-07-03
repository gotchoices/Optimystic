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
`JSON.stringify`. At hash time the predecessor's `nextId` is still `undefined` (assigned one line
later, in `Chain.add`), so `JSON.stringify` omitted it; the *stored* block then serializes *with* a
real `nextId`. A verifier re-hashing a stored block would get a different digest than recorded. No
verifier existed yet, so this was latent, and the covered-field set was entirely undocumented.

## What was changed (implement stage — commit 39ee2f6)

- **`chain.ts`** (~line 126): pass the loop-local `tail` (running predecessor) to `newBlock`, not
  `oldTail`. `newTail.priorId = tail.header.id` was already correct and is unchanged.
- **`log.ts`**: added exported `logBlockHashPayload(block)` — the single canonical hash-payload
  definition. Strips the mutable structural links (`nextId`, `priorId`); keeps `header`, `entries`,
  `priorHash`. The `newBlock` hook now hashes `logBlockHashPayload(oldTail)`. `Log.getChainOptions`
  widened `private static` → `static` so tests can drive a raw `Chain` through the exact hook.
- **`docs/logs.md`**: new *Canonical `priorHash` payload* subsection — covered/excluded field table +
  the verifier rule.
- **Tests**: `chain.spec.ts` and `log.spec.ts` regression tests (multi-block single `add`).

## Review-stage change

- **`log.ts:13`** (minor, fixed inline): the `LogBlock.priorHash` doc comment read "Base64url encoded
  Sha256 hash of the **next** block". `priorHash` is the hash of the **prior** (predecessor) block —
  the comment directly contradicted the type's name, the `newBlock` hook, and the new docs section.
  Corrected to "prior (predecessor) block". Comment-only; no rebuild/retest needed.

## Validation

From `packages/db-core`:

```
yarn build                                    # tsc, exits 0 (silent)
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min
```

Result at review: **1071 passing, 0 failing**; build clean. (Re-run after the review, not just quoted
from the handoff.)

## Review findings

Adversarial pass over the implement diff (read diff first, then handoff). Scope: `chain.ts` append
loop, `log.ts` hook + payload helper, `docs/logs.md`, both new tests.

- **Correctness of the fix — CONFIRMED correct.** `newBlock(newTail, tail)` passes the running
  predecessor; verified by the `chain.spec.ts` regression (2nd new block's predecessor is the first
  new block, not the original tail) and by re-running the suite green. No regression for `Log`:
  it appends one entry per `add`, so the while-loop runs ≤ once and `tail === oldTail` on that
  iteration — behaviour identical to before for single-block appends.
- **Single source of truth — CONFIRMED.** Grepped all block-hash sites in `packages/db-core/src`:
  `sha256.digest` over a block appears only in the `log.ts` `newBlock` hook, and `priorHash` is
  written only there. `logBlockHashPayload` is the sole payload definition; no second hasher can
  drift out of sync. Only one `newBlock` consumer exists (Log); the Chain hook has no other
  implementer.
- **Test coverage — adequate for the surface.** The chain test exercises the hook argument across a
  ≥3-block append (the exact broken contract); the log test drives a raw `Chain` through the Log's
  real `getChainOptions` hook and re-derives every `priorHash` from `logBlockHashPayload` of its
  predecessor. `Log`'s public `addActions`/`addCheckpoint` never span multiple new blocks per call,
  so there is no additional multi-block public-API path to cover. Not filed as a gap.
- **Byte-definition change vs. previously-written data — noted, no action.** Defect-2's fix removes
  `priorId` from the hashed payload (the old raw-`JSON.stringify(oldTail)` included `priorId`), so a
  `priorHash` computed by this code differs from one the old code would have produced. Benign now:
  there is no `priorHash` verifier anywhere in the tree and no persisted-log format-compat guarantee,
  and every existing test asserts only existence/`undefined`, not digest values (so nothing breaks).
  Recorded here as an index entry, not a ticket — it only becomes work if a cross-version verifier is
  built against logs written by the pre-fix code, which does not exist.
- **Tripwire (carried from implement, verified in place).** `logBlockHashPayload` is hashed via
  `JSON.stringify` — key-order dependent, drops `undefined`s. Parked as a `NOTE:` at the
  `logBlockHashPayload` site in `log.ts`; only becomes work if a store/codec ever re-serializes blocks
  with a different key order (then switch to sorted-keys / dag-cbor). Correctly a tripwire, not a
  ticket — the original code already relied on `JSON.stringify`.
- **`getChainOptions` visibility — accepted.** Widened to `static` so tests use the real hook. The
  factory is pure and stateless; public exposure is acceptable and avoids a parallel test-only hook
  that could drift from production. No change.
- **Docs — CONFIRMED current.** Read `docs/logs.md` *Block Integrity* section in full; the new
  covered/excluded table matches `logBlockHashPayload` exactly and the "hash of previous block"
  wording is consistent (the one stale source comment was the `log.ts:13` fix above).
- **No verifier exists (design note, not a defect).** `priorHash` is written but never re-checked in
  production. Building one is out of scope for this ticket; if warranted it is a new `feat-`/`debt-`
  ticket. Not filed here — no one requested it and the contract is now documented for whoever does.

**Major findings: none** (no new tickets spawned). **Minor: one** (`log.ts:13` comment, fixed inline).
**Tripwires: one** (JSON.stringify canonicality, already parked at its code site).
