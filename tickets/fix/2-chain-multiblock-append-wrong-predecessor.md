----
description: When several entries are appended to a chained log in a single call, each new block records the wrong previous block, breaking the tamper-evident links between blocks.
files: packages/db-core/src/chain/chain.ts, packages/db-core/src/log/log.ts
difficulty: medium
----
In `Chain.add`'s append loop (around chain.ts:124), every newly created block is passed `newBlock?.(newTail, oldTail)` where the predecessor argument is always the *original* tail, rather than the running predecessor for that iteration. A single variadic `add(...entries)` that spans two or more blocks therefore hashes each block against the wrong predecessor, silently breaking the hash chain.

This is latent today because the Log layer appends one entry at a time (see log.ts:231-236), so a single call never spans multiple new blocks — but the general `Chain.add` contract is broken and any multi-block append corrupts the links.

Separately, the block hash is computed before `nextId` is applied to the predecessor, so the stored bytes never match the hashed content unless a verifier strips the mutable link fields first — and that requirement is currently undocumented.

Expected behavior: across a multi-block append, each block's recorded predecessor is the immediately preceding block in the chain, and the hash chain verifies end to end. The set of fields covered by the hash (excluding mutable link fields such as the forward/next pointer) should be specified so stored content and hashed content agree.

Suggested fix (from review, treat as a hint): pass the loop-local `tail` as the predecessor, and define a canonical hash payload that excludes the mutable link fields.

A reproduction should append enough entries in one `Chain.add` call to span multiple blocks and then verify predecessor links / the hash chain.
