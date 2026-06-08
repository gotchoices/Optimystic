/**
 * Deterministic primary/backup assignment over a cohort membership snapshot, modeled against
 * `docs/cohort-topic.md` §Primary and backup sharding and §Membership rotation and primary
 * handoff.
 *
 *   order(members)           = sort(members ascending)
 *   slot(participantId)      = H(participantId ‖ cohortEpoch) mod k
 *   primary(participantId)   = order[slot]
 *   backups(participantId)   = order[slot+1 .. slot+2 (mod k)]
 *
 * The assignment is a pure function of `(participantId, cohortEpoch, members)`, so two disjoint
 * partition sides that heal back to the *same* member set derive the *same* `cohortEpoch` and
 * therefore converge on the same primary in one gossip round — the property the partition-heal
 * test asserts. The doc specifies a sha256-derived slot; the simulator hashes synchronously
 * (FNV-1a) like the other modeled hashes (`deriveTopicId`), since only determinism matters for
 * the model — the production substrate owns the real digest.
 */

/** FNV-1a over a string's UTF-16 code units → 32-bit unsigned. Deterministic, synchronous. */
export function fnv1a32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		h ^= c & 0xff;
		h = Math.imul(h, 0x0100_0193);
		h ^= (c >>> 8) & 0xff;
		h = Math.imul(h, 0x0100_0193);
	}
	return h >>> 0;
}

/**
 * `cohortEpoch` — a stable identifier for a membership snapshot: the hash of the sorted member
 * id list (cohort-topic.md §Cohort epoch). Order-independent (members are sorted first), so the
 * same set always yields the same epoch regardless of insertion order.
 */
export function cohortEpochOf(memberIds: readonly string[]): string {
	const sorted = [...memberIds].sort();
	return fnv1a32(sorted.join('')).toString(16).padStart(8, '0');
}

/** `slot(participantId, cohortEpoch) = H(participantId ‖ cohortEpoch) mod k`. */
export function slotOf(participantId: string, cohortEpoch: string, k: number): number {
	if (!Number.isInteger(k) || k <= 0) {
		throw new RangeError(`cohort size k must be a positive integer, got ${k}`);
	}
	return fnv1a32(`${participantId} ${cohortEpoch}`) % k;
}

/** Resolved serving assignment for one registration within a cohort. */
export interface PrimaryAssignment {
	readonly primary: string;
	readonly backups: string[];
}

/**
 * An immutable cohort-membership snapshot: sorted member ids plus the derived `cohortEpoch`, with
 * deterministic per-participant primary/backup assignment. Membership changes (FRET stabilization,
 * partition, heal) produce a *new* snapshot via `withMembers`/`split`/`merge` rather than mutating
 * one in place, so a stale snapshot stays a valid record of the membership it was taken under.
 */
export class CohortMembership {
	readonly members: readonly string[];
	readonly epoch: string;

	constructor(memberIds: readonly string[]) {
		if (memberIds.length === 0) {
			throw new RangeError('cohort membership must have at least one member');
		}
		// De-dup then sort: a healed/merged membership may carry overlap between the two sides.
		this.members = [...new Set(memberIds)].sort();
		this.epoch = cohortEpochOf(this.members);
	}

	get size(): number {
		return this.members.length;
	}

	has(memberId: string): boolean {
		return this.members.includes(memberId);
	}

	/**
	 * Deterministic `{ primary, backups }` for a participant under this snapshot's epoch. Up to
	 * `backups_per_registration` (2) warm backups follow the primary's slot, wrapping the ring and
	 * never re-naming the primary itself (a cohort of 1 yields no backups).
	 */
	assign(participantId: string, backupsPerRegistration = 2): PrimaryAssignment {
		const k = this.members.length;
		const slot = slotOf(participantId, this.epoch, k);
		const primary = this.members[slot]!;
		const backups: string[] = [];
		for (let i = 1; i <= backupsPerRegistration && i < k; i++) {
			backups.push(this.members[(slot + i) % k]!);
		}
		return { primary, backups };
	}

	/** A new snapshot over a different member set (stabilization / rotation). */
	withMembers(memberIds: readonly string[]): CohortMembership {
		return new CohortMembership(memberIds);
	}

	/**
	 * Split into two disjoint snapshots by a side predicate — the network-partition model. Members
	 * for which `onSideA` holds form side A; the rest form side B. Either side may be empty in
	 * principle, but a `CohortMembership` requires ≥1 member, so callers partition memberships of
	 * size ≥ 2 with a predicate that keeps both sides non-empty.
	 */
	split(onSideA: (memberId: string) => boolean): [CohortMembership, CohortMembership] {
		const a = this.members.filter(onSideA);
		const b = this.members.filter((id) => !onSideA(id));
		return [new CohortMembership(a), new CohortMembership(b)];
	}

	/** Merge two snapshots into one (partition heal). The union's epoch matches the pre-split set. */
	static merge(a: CohortMembership, b: CohortMembership): CohortMembership {
		return new CohortMembership([...a.members, ...b.members]);
	}
}
