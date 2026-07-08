/**
 * Verifiable dispersed arbitrator sampling.
 *
 * The old selection walked the ring positions *immediately adjacent* to the disputed block (sort every
 * peer by XOR distance to `hash(blockId)`, skip the original cluster, take the next K). That recruits
 * from exactly the neighborhood an attacker already had to own to capture the block's cluster — so
 * "independent" arbitration drew from the *least* independent population (see `docs/correctness.md` §7.1
 * Sybil, Theorems 8 & 10).
 *
 * Instead we derive `count` pseudo-random ring coordinates from `hash(blockId ‖ round ‖ epoch ‖ i)` and
 * pick the peer nearest each coordinate. SHA-256 output is uniform over the ring, so the coordinates land
 * spread across the whole keyspace and the sampled arbitrators are drawn from the whole population, not
 * the block's neighborhood. To capture them an attacker needs IDs near many independent random points —
 * a fraction of the *entire* network, not one locale.
 *
 * Two properties both hold:
 *  - **Deterministic & independently verifiable** — every honest node, given the same
 *    `(blockId, round, epoch)` and the same agreed membership, computes the identical set. This is what
 *    lets the dispute verify path re-derive the eligible set instead of trusting a declared one.
 *  - **Unpredictable / not pre-positionable** — the coordinates for round r are pinned only once
 *    `(blockId, round, epoch)` are all fixed. `round` advances in real time during the dispute; `epoch`
 *    is the agreed membership epoch, which rotates with membership and cannot be freely advanced by the
 *    attacker. So the attacker cannot know far enough ahead which coordinates to migrate IDs toward.
 */

/**
 * Resolve the peer-id strings nearest a ring coordinate, in ascending distance order.
 * Production: FRET `assembleCohort(coord, wants)`. Tests: sort a fixed `KnownPeer[]` by XOR distance.
 * May return fewer than `wants` — that signals the whole eligible membership fit in the slice.
 */
export type NearestResolver = (coord: Uint8Array, wants: number) => string[] | Promise<string[]>;

/** FRET-compatible ring hash of arbitrary bytes → coordinate (SHA-256; see db-core `RingHash.H` / FRET `hashKey`). */
export type RingHashFn = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export interface ArbitratorSamplingParams {
	/** Disputed block id bytes (messageHash fallback), as bound into the dispute. */
	readonly blockId: Uint8Array;
	/** Escalation round, 0-based. Round 0 is the first arbitration. */
	readonly round: number;
	/**
	 * Agreed membership epoch bytes. Pins the draw to an epoch the attacker cannot freely advance.
	 * Interim source (until `design-cluster-membership-agreement` lands): hash of the agreed responsible
	 * set the admission gate already converges on (`cluster-membership-admission-gate`).
	 */
	readonly epoch: Uint8Array;
	/** Number of fresh, distinct arbitrators to draw this round. */
	readonly count: number;
	/** Peer-id strings to exclude: original cluster + self + arbitrators already drawn in prior rounds. */
	readonly exclude: ReadonlySet<string>;
}

/** Little-endian u32 encoding of `n` — the canonical wire encoding for `round` and the coordinate index. */
function u32le(n: number): Uint8Array {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, n >>> 0, true);
	return out;
}

/** Concatenate byte spans left-to-right. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) { out.set(p, off); off += p.length; }
	return out;
}

/**
 * The exact preimage the i-th coordinate of a round hashes: `blockId ‖ u32le(round) ‖ epoch ‖ u32le(i)`.
 * Folding `round`, `epoch`, and `i` in gives: (a) each round samples a distinct population (round changes
 * every coordinate); (b) each of the `count` coordinates is an independent uniform draw (dispersion);
 * (c) a replacement for an offline/duplicate pick is the *next* peer in the same coordinate's ordering,
 * never a fresh challenger-chosen peer. The canonical little-endian encoding is asserted by a golden
 * vector so two implementations hash identical bytes.
 */
export function coordinatePreimage(blockId: Uint8Array, round: number, epoch: Uint8Array, i: number): Uint8Array {
	return concatBytes([blockId, u32le(round), epoch, u32le(i)]);
}

/**
 * Deterministic dispersed arbitrator draw. Returns up to `count` distinct peer-id strings; fewer only
 * when the network is too small to yield that many (small-network fallback) — never duplicates, never
 * loops. In the degenerate all-peers-in-cluster case, returns `[]`.
 *
 * For each coordinate `i` the nearest unseen peer is chosen. When a coordinate's nearest slice is
 * entirely `seen` (excluded, or already picked for an earlier coordinate) the slice is widened
 * (`wants` grows) and retried; if widening exposes the whole eligible membership with nobody fresh, the
 * entire membership is exhausted and the (short) picks are returned. Replacement of an offline/duplicate
 * pick is thus the deterministic next peer in the same coordinate's ordering, identical on every honest
 * node, so disputing parties cannot steer it.
 */
export async function sampleArbitrators(
	params: ArbitratorSamplingParams,
	nearest: NearestResolver,
	hash: RingHashFn,
): Promise<string[]> {
	const { blockId, round, epoch, count, exclude } = params;
	const picks: string[] = [];
	if (count <= 0) return picks;

	const seen = new Set<string>(exclude);

	for (let i = 0; picks.length < count; i++) {
		const coord = await hash(coordinatePreimage(blockId, round, epoch, i));

		// Walk this coordinate's ascending-distance ordering for the first peer we have not yet seen,
		// widening the slice until we find one or have proven the whole eligible membership is exhausted.
		// NOTE: `wants` starts at `seen.size + 1` (conservative — guarantees exhaustion is provable in one
		// widen). Starting at 1 and widening only on a seen-collision is also correct and asks the resolver
		// for far fewer peers per coordinate; if `assembleCohort` ever shows up as hot here, start smaller.
		let wants = seen.size + 1;
		let prevLen = -1;
		let picked: string | undefined;
		let membershipExhausted = false;
		for (;;) {
			const cands = await nearest(coord, wants);
			const fresh = cands.find(c => !seen.has(c));
			if (fresh !== undefined) { picked = fresh; break; }
			// No fresh peer in this slice. If the resolver returned fewer than we asked (or the slice
			// stopped growing), we have seen the whole eligible membership from this coordinate — and
			// since every one of them is already `seen`, no future coordinate can yield anything new.
			if (cands.length < wants || cands.length <= prevLen) { membershipExhausted = true; break; }
			prevLen = cands.length;
			wants *= 2;
		}

		if (picked !== undefined) {
			picks.push(picked);
			seen.add(picked);
		} else if (membershipExhausted) {
			break;
		}
	}

	return picks;
}
