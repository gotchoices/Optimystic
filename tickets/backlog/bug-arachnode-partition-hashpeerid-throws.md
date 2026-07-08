description: When a storage node has enough disk to specialize onto a sub-region of the keyspace, the code that works out which region it owns crashes, so the node never advertises its region — which silently breaks the peer-selection the block-recovery path depends on.
prereq:
files: packages/db-p2p/src/storage/ring-selector.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/ring-selector.spec.ts, packages/db-p2p/node_modules/p2p-fret/src/ring/hash.ts
difficulty: medium
----

# Arachnode partition calculation throws for any ring > 0 (fake PeerId passed to hashPeerId)

## Plain summary

A storage node picks a "ring depth" based on how much space it has. Ring 0 means "I
cover the whole keyspace"; ring N > 0 means "I only cover a 1/2^N slice, identified by a
partition prefix." To compute *which* slice, `RingSelector.calculatePartition` needs the
node's coordinate in the ring, which it gets by hashing the peer id. It hashes the peer id
wrong, and the hash function throws. So any node that lands on ring > 0 crashes while
computing its partition and never publishes one.

## The defect

`ring-selector.ts:95`:

```ts
const coord = await hashPeerId({ toString: () => peerId } as any);
```

`hashPeerId` (in `p2p-fret/src/ring/hash.ts:11`) does **not** use `.toString()` — it reads
the raw multihash bytes:

```ts
export async function hashPeerId(peerId: PeerId): Promise<RingCoord> {
	const bytes = peerId.toMultihash().bytes;   // <-- fake object has no toMultihash
	const digest = await sha256.encode(bytes);
	return digest;
}
```

The value passed is `{ toString: () => peerId }`, a plain string wrapper with no
`toMultihash` method. Calling it throws **`TypeError: peerId.toMultihash is not a
function`** (verified directly with a one-off node script during review).

`calculatePartition` returns early with `undefined` for ring 0 (so ring-0 nodes never hit
the bad line), but for **any ring depth > 0** it always throws.

## Why it hasn't blown up yet

`RingSelector.determineRing` only returns a depth > 0 when the node's available capacity is
a small fraction of estimated total network demand. In dev/test and small deployments the
capacity math lands everyone on ring 0 (see `ring-selector.ts:72-80`), so the throwing line
is never reached. The bug only bites at the scale the ring system exists for: many peers,
constrained per-node capacity → ring depth > 0.

## Blast radius

- **Startup crash.** `libp2p-node-base.ts:885` does
  `const arachnodeInfo = await ringSelector.createArachnodeInfo(peerId)` with
  `peerId = node.peerId.toString()` (a plain string), no surrounding try/catch shown.
  `createArachnodeInfo` awaits `calculatePartition` (`ring-selector.ts:111`), so a ring > 0
  node throws during Arachnode announcement.
- **Peer selection silently degraded.** ArachnodeInfo (including `partition.prefixValue`) is
  published into FRET metadata by each peer's own `createArachnodeInfo`
  (`arachnode-fret-adapter.ts:41` `setArachnodeInfo`). A peer that throws never publishes a
  partition, so network-wide no ring > 0 peer advertises a `prefixValue`. The block-recovery
  fallback filter `RestorationCoordinator.filterByPartition`
  (`restoration-coordinator.ts:126`) matches a block's partition prefix against
  `info.partition.prefixValue` — with none present, it matches **zero peers** at ring > 0.
  The `st-restoration-wrong-coordinate-space` fix corrected the coordinate space that filter
  uses, but the filter still has nothing to match against in production until this is fixed.

## Fix direction (for the fix agent to design)

The call site (`libp2p-node-base.ts:884`) already has the real `node.peerId` before stringifying
it. Options:

- Thread the real `PeerId` (with a working `toMultihash()`) through
  `createArachnodeInfo`/`calculatePartition` to `hashPeerId`, instead of a stringified
  wrapper. Preferred — keeps the peer's ring coordinate consistent with how the rest of FRET
  places that peer.
- Or reconstruct a `PeerId` from the string inside `calculatePartition`
  (`peerIdFromString`) before hashing.

Do **not** switch peer partitioning to `hashKey(stringBytes)` to dodge the throw: peers must
occupy the *same* coordinate FRET uses to place them in the ring (that coordinate is
`hashPeerId(peerId)`), or restoration's block-prefix vs peer-prefix comparison stops meaning
"this peer owns this block's slice."

## Also fix the test that masked this

`ring-selector.spec.ts` wraps every `calculatePartition(ring > 0, ...)` assertion in
`try { ... } catch { /* hashPeerId might fail */ }`. The empty catch turns the crash into a
vacuous pass — the suite is green today only because the throw is swallowed. Once the input
is a real PeerId, tighten these tests: drop the catch and assert a defined partition with a
`prefixValue` in `[0, 2^bits)` (the `describe('calculatePartition')` and
`describe('createArachnodeInfo')` blocks around `ring-selector.spec.ts:168` and `:292`).
