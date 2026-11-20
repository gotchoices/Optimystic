import { LruMap } from '@optimystic/db-core';

/**
 * How many `(peer, commit proof)` pairs one sender remembers. A pair costs a short key and nothing
 * else, and the set only has to span the blocks of one commit being copied to one peer, so a few
 * thousand covers a bulk-import push to a handful of peers with room to spare.
 */
const DEFAULT_MAX_PAIRS = 4096;

/**
 * How many times one `(peer, proof)` pair may come back unresolved before the sender stops naming
 * that proof to that peer at all.
 *
 * The first failure is forgiven because it is routinely transient: the peer restarted between two
 * blocks of one commit and re-filed the proof from the inline retry, so the next block's reference
 * resolves. A peer that resolves no reference ever — a replica store without
 * `IBlockReplicaStore.getCommitProof`, or a holder that accepts blocks and retains no proof —
 * answers every time, and with no bound every block of the commit would cost it two pushes
 * indefinitely: the same proof bytes as before references existed, plus a round trip each. The
 * bound makes that degradation the pre-reference behaviour plus this many extra round trips, once
 * per pair.
 */
const MAX_UNRESOLVED_PER_PAIR = 2;

/** What one sender knows about one `(peer, commit proof)` pair. */
type PairState = {
	/** Whether a push that CARRIED the proof to this peer was last confirmed by it. */
	readonly shown: boolean;
	/** How often this peer has answered that it could not resolve this proof's hash. */
	readonly unresolved: number;
};

/**
 * Which commit proofs a sender has already shown each peer, so a push can NAME a proof
 * (`BlockTransferRequest.proofRefs`) instead of carrying it. A proof lists every block of its
 * commit, so copying a commit of N blocks to one peer used to put N copies of the same proof on the
 * wire; with this, the first block of a commit carries the proof and the rest carry its hash.
 *
 * **Being wrong in either direction is safe.** Believing a peer holds a proof when it does not
 * costs one extra round trip for that block and corrects itself — the receiver answers the hash in
 * `BlockTransferResponse.unresolvedProofs` and the sender records that and re-pushes with the proof
 * inline. Not knowing that a peer holds one costs one proof on the wire, which is exactly the
 * behaviour before references existed. So nothing here needs to be durable, replicated, or exact —
 * and a peer that keeps failing to resolve is bounded by {@link MAX_UNRESOLVED_PER_PAIR} rather
 * than retried forever.
 *
 * **Nothing expires.** No site deletes a stored commit proof (see `RawStoreDriver.getCommitProof`),
 * so a peer that filed a proof holds it for good; eviction at the cap only re-sends a proof.
 */
export class PeerProofMemory {
	private readonly pairs: LruMap<string, PairState>;

	constructor(maxPairs: number = DEFAULT_MAX_PAIRS) {
		this.pairs = new LruMap(maxPairs);
	}

	/** Whether a push to `peerId` may name the proof whose consensus message hashes to `messageHash`. */
	holds(peerId: string, messageHash: string): boolean {
		const state = this.read(peerId, messageHash);
		return state !== undefined && state.shown && state.unresolved < MAX_UNRESOLVED_PER_PAIR;
	}

	/** Record that a push carrying that proof to `peerId` was confirmed. */
	remember(peerId: string, messageHash: string): void {
		this.write(peerId, messageHash, { shown: true, unresolved: this.read(peerId, messageHash)?.unresolved ?? 0 });
	}

	/** Record that `peerId` answered that it could not resolve that proof's hash. */
	recordUnresolved(peerId: string, messageHash: string): void {
		const failures = (this.read(peerId, messageHash)?.unresolved ?? 0) + 1;
		this.write(peerId, messageHash, { shown: false, unresolved: Math.min(failures, MAX_UNRESOLVED_PER_PAIR) });
	}

	// `get` rather than `peek`, so the pair being used right now is the last to be evicted: a commit
	// is copied block by block, and the pair for the commit in flight is the one that must survive
	// the cap.
	private read(peerId: string, messageHash: string): PairState | undefined {
		return this.pairs.get(pairKey(peerId, messageHash));
	}

	private write(peerId: string, messageHash: string, state: PairState): void {
		this.pairs.set(pairKey(peerId, messageHash), state);
	}
}

/**
 * `|` separates the two halves: a peer id is base58btc or base32 and a `messageHash` base58btc, so
 * neither can contain it and no two distinct pairs collide.
 */
function pairKey(peerId: string, messageHash: string): string {
	return `${peerId}|${messageHash}`;
}

/**
 * One memory per sending node, keyed on the node's own store.
 *
 * Every sender of one node hands `pushBlockToPeers` the SAME object as its `repo` — the node's own
 * `storageRepo` (`BlockTransferCoordinator`'s constructor argument, `SpreadOnChurnDeps.repo`, and
 * the under-replication drain's `pushBlock` closure in `libp2p-node-base.ts`), which is already
 * documented there as "the node's OWN store". So that object IS the node's identity at this seam,
 * and two nodes in one process (the in-process test mesh) never share a memory — unlike the
 * process-wide proof-votes memo, which is shared precisely because its verdict is a pure function
 * of its key, and "has this peer been shown this proof" is not.
 *
 * Module-level rather than an explicit option: threading one through would add a field to
 * `BlockTransferConfig` and `SpreadOnChurnDeps`, a ninth positional parameter to
 * `NetworkManagerService.initSpreadOnChurnMonitor`, and a wiring step a fifth sender can forget —
 * the same silent-degradation failure mode `ProofRetainingRepo` exists to prevent, except that
 * forgetting it here costs bandwidth rather than correctness.
 *
 * `WeakMap`, so a stopped node's memory is collected with its store.
 */
const memoriesBySender = new WeakMap<object, PeerProofMemory>();

/** The {@link PeerProofMemory} of the sender whose own store is `sender`, created on first use. */
export function peerProofMemoryFor(sender: object): PeerProofMemory {
	let memory = memoriesBySender.get(sender);
	if (!memory) {
		memory = new PeerProofMemory();
		memoriesBySender.set(sender, memory);
	}
	return memory;
}
