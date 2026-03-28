----
description: Derive block IDs from collection history + validated nonce to prevent DHT address targeting
dependencies: ChipCode (https://github.com/gotchoices/ChipCode), block allocation in transactor-source.ts, Collection class
files: packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/blocks/structs.ts
----

## Problem

Block IDs are currently 256-bit cryptographically random values with no derivation constraints. Since block IDs determine DHT coordinator assignment (via `blockIdToBytes` → SHA256 → FRET routing), a malicious node can grind block IDs to target a specific coordinator — e.g., one it controls or colludes with — and then lie about block state.

## Proposed Approach

Replace pure-random block IDs with derived IDs:

```
blockId = hash(allocationSeed || chipCode)
```

Where:
- **allocationSeed** is a running hash maintained on the Collection, advanced with each block write by folding in the block's contents. This binds each new block ID to the cumulative history of all prior allocations in that collection.
- **chipCode** is a high-entropy expiring nonce generated via ChipCode, which provides NIST-validated randomness and built-in expiration. Stored in the BlockHeader for validator re-derivation.

Validators replay the deterministic transaction, maintain their own running seed, and verify each block ID matches the expected derivation.

## Why This Works

- The allocation seed incorporates prior block *contents*, which include other users' data — an attacker can't predict or control it.
- ChipCode ensures the nonce is genuinely random (frequency + runs tests) and time-bound (expiring), preventing pre-computation.
- Even with full knowledge of the seed, grinding nonces is limited by ChipCode's entropy validation and expiration window.
- The derivation is verifiable: any node replaying the transaction can confirm every block ID was honestly derived.

## Key Design Element: Allocation Seed on Collection

The Collection maintains a running hash that evolves with each block allocation:

- **Bootstrap**: `seed = hash(collectionId)` for the first block in a new collection.
- **Advance**: after a block is fully constructed and inserted into the Tracker, `seed = hash(seed || serialized(block))`.
- **Consumption**: `createBlockHeader()` reads the current seed to derive the new block ID.
- **Persistence**: either recomputed from the log on load, or stored in the collection header block.

This is block-type-agnostic — works for chain blocks, B-tree nodes, or any future structure — because it operates at the allocation level, not the data-structure level.

## Open Questions

- **Async ordering guarantee**: the scheme depends on block allocation order being deterministic across Quereus transaction replay. Quereus transactions are deterministic and the allocation path appears fully sequential (latched Collection, synchronous BTree operations within Atomic context), but this needs thorough verification — any async interleaving between Quereus and Optimystic would cause validators to compute different seeds.

- **Sync-phase allocations**: `syncInternal()` creates log blocks via `Log.addActions()` after the Quereus mutation phase. The running seed must span both phases in a consistent order. Need to confirm log block allocation is also deterministic.

- **Seed serialization**: what exactly gets hashed when advancing the seed — full block content, or a subset? Full content is strongest but has serialization cost and determinism requirements (field ordering).

- **Record iteration order**: `Atomic.commit()` applies transforms via `applyTransformToStore()`. If the inserts `Record<BlockId, IBlock>` is iterated, JavaScript preserves string-key insertion order, but this assumption should be validated.

- **ChipCode epoch tolerance**: what `ageMs` and acceptance window to use? Needs to balance clock skew tolerance against the grinding window.

- **Bootstrap block strength**: the first block uses `hash(collectionId)` as seed, which is well-known. Is ChipCode's entropy validation sufficient to prevent targeting for this single block, or does the bootstrap need additional hardening (e.g., commit-reveal)?
