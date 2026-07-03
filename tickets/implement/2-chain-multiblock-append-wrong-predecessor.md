----
description: When several entries are appended to a chained log in a single call, each new block is linked to the wrong previous block, breaking the tamper-evident hash links between blocks.
files: packages/db-core/src/chain/chain.ts, packages/db-core/src/log/log.ts, packages/db-core/src/chain/chain-nodes.ts, packages/db-core/docs/logs.md, packages/db-core/test/chain.spec.ts, packages/db-core/test/log.spec.ts
difficulty: medium
----

## Summary

Two defects in the append path, both confirmed by a reproducing test (see *Reproduction* below).

### Defect 1 — wrong predecessor passed to `newBlock` (the actual bug)

`Chain.add` (`packages/db-core/src/chain/chain.ts:117-128`) fills the current tail, then loops creating one new block per remaining batch of `EntriesPerBlock` entries. Inside the loop it calls the caller's `newBlock` hook:

```ts
while (entries.length > 0) {
    const newTail = { ..., priorId: tail.header.id, nextId: undefined } as ChainDataNode<TEntry>;
    await this.options?.newBlock?.(newTail, oldTail);   // <-- BUG: oldTail is the ORIGINAL tail
    trx.insert(newTail);
    apply(trx, tail, [nextId$, 0, 0, newTail.header.id]);
    tail = newTail;                                      // running predecessor advances here
}
```

The predecessor argument is always `oldTail` (the tail as it was before the loop), not the running predecessor `tail`. So when a single `add(...entries)` spans three or more blocks, the 2nd, 3rd, … new block are all told their predecessor is the *original* tail.

`ChainDataNode.priorId` is set correctly (`tail.header.id`), so the raw block-pointer chain is fine — this test passes. The break is only in what the `newBlock` hook receives.

The Log layer's `newBlock` hook (`packages/db-core/src/log/log.ts:231-236`) hashes exactly that predecessor to produce `priorHash`. So a multi-block single append computes each block's `priorHash` against the wrong predecessor, silently corrupting the tamper-evident hash chain.

Latent today only because the Log appends one entry per `Chain.add` call (`log.ts:57`, `log.ts:66`, `log.ts:90`), so no single call spans multiple *new* blocks. The general `Chain.add` contract is nonetheless broken for any caller that appends a multi-block batch.

**Fix:** pass the loop-local `tail` (the running predecessor) instead of `oldTail`:

```ts
await this.options?.newBlock?.(newTail, tail);
```

### Defect 2 — hashed content ≠ stored content (canonical hash payload undocumented/undefined)

`Log`'s `newBlock` hashes the whole predecessor block:

```ts
const hash = await sha256.digest(new TextEncoder().encode(JSON.stringify(oldTail)));
```

At hash time the predecessor's `nextId` is still `undefined` (it is assigned one line later, at `chain.ts:126`). `JSON.stringify` omits `undefined` fields, so the hashed bytes contain **no** `nextId`. Immediately after, `apply(trx, tail, [nextId$, …, newTail.header.id])` sets `nextId` to a real id, so the **stored** block now serializes *with* a `nextId`.

Consequence: anyone who later re-hashes a stored block to verify `priorHash` gets a different digest than the one recorded — unless they first strip the mutable link field(s). No such verifier exists in the tree today (`priorHash` is written but never re-checked — grep confirms only writes and existence-assertions), so this is currently latent, but it is a real defect the moment a verifier is written, and the requirement is entirely undocumented.

`nextId` is not the only mutable link field: `priorId` is cleared by `Chain.dequeue` (`chain.ts:230`) and `nextId` by `Chain.pop` (`chain.ts:181`). The Log itself never pops/dequeues, but the hash payload should be defined against the *Chain* contract, not the Log's current usage.

**Fix:** define a single canonical hash-payload function that excludes the mutable structural link fields (`nextId`, `priorId`) and keeps the content-bearing fields (`header`, `entries`, `priorHash`). Hash *that* on write, and document it as the payload any future verifier must reproduce. Example shape:

```ts
// Canonical bytes covered by priorHash: everything EXCEPT the mutable structural
// links (nextId/priorId), which are rewritten by pop/dequeue/append after the hash
// is taken. A verifier MUST reproduce exactly this payload.
function logBlockHashPayload<TAction>(block: LogBlock<TAction>) {
    const { nextId, priorId, ...covered } = block;
    return covered;
}
```

Note the existing `nextId$` / `priorId$` name constants live in `packages/db-core/src/chain/chain-nodes.ts` if you prefer keying off those rather than a destructure.

## Reproduction (confirmed)

A temporary spec was run against `HEAD` and confirmed the bug, then removed. Re-create it as a permanent regression test. It creates a chain with a `newBlock` hook that records `(newTail.header.id, oldTail?.header.id)`, then appends `EntriesPerBlock * 3` entries in one `add(...)` call (32 fill the tail; two new blocks follow → two hook calls). On `HEAD`:

```
passes the running predecessor to newBlock across multiple new blocks:
    second new block should see block2 as predecessor, not original tail
    + expected - actual
    -block-1
    +block-3
```

i.e. the 2nd new block was told its predecessor is `block-1` (the original tail) when it should be `block-3` (the first new block). A companion assertion that walks `priorId` links passes (Defect 1 is isolated to the hook argument).

## Expected behavior

- Across a multi-block append, each new block's `newBlock` predecessor is the immediately preceding block in the chain, so the `priorHash` chain links block→block correctly end to end.
- The set of fields covered by `priorHash` is explicitly defined and excludes the mutable structural link fields (`nextId`, `priorId`), so stored bytes and hashed bytes agree and a verifier that re-hashes stored blocks matches the recorded `priorHash`.

## TODO

- In `packages/db-core/src/chain/chain.ts` (~line 124), pass the loop-local `tail` to `this.options?.newBlock?.(newTail, tail)` instead of `oldTail`. Leave `newTail.priorId = tail.header.id` as-is (already correct).
- In `packages/db-core/src/log/log.ts`, add a canonical hash-payload helper that excludes `nextId` and `priorId`, and hash that payload in the `newBlock` hook instead of the raw block. Add a comment stating the covered field set and that any verifier must reproduce it.
- Document the canonical `priorHash` payload (fields covered / excluded) in `packages/db-core/docs/logs.md` under *Block Integrity*.
- Add a regression test in `packages/db-core/test/chain.spec.ts`: single `add(...)` spanning ≥3 blocks; assert each new block's `newBlock` predecessor equals the previous new block (not the original tail), and that `priorId` links remain correct.
- Add a regression test in `packages/db-core/test/log.spec.ts` (or chain-level with the Log chain options): build a multi-block chain via a single `Chain.add` using `Log`'s chain options, then verify the `priorHash` chain end to end by recomputing each block's hash from the canonical payload of its predecessor and comparing to the stored `priorHash`. This must fail on the pre-fix code and pass after.
- Build (`yarn build` / `tsc`) and run the db-core suite: from `packages/db-core`, `node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min` (stream with `| tee`). Confirm existing `log.spec.ts` / `log-invalidation.spec.ts` priorHash assertions still pass.
