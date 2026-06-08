/**
 * Per-member willingness and the per-tier capacity barometer, modeled against
 * `docs/cohort-topic.md` §Willingness and §Capacity barometer.
 *
 * Each member advertises a 4-bit willingness vector (one bit per tier T0..T3) tied to its device
 * profile: an **Edge** node (mobile/browser/IoT) serves T0+T1 only; a **Core** node serves all
 * four. Per-node overrides may further *restrict* tiers, but Edge T2/T3 are permanently off — no
 * override can switch them on. A member also tracks a 3-bit (0..7) load bucket per tier; when a
 * tier's bucket reaches the overload threshold the member sheds that tier (its willingness bit
 * flips off until load recedes). Quorum-level willingness over the cohort decides
 * `UnwillingCohort` vs `UnwillingMember`.
 */

export type Tier = 0 | 1 | 2 | 3;
export const TIER_COUNT = 4;

export type DeviceProfile = 'edge' | 'core';

/** Highest tier a profile may *ever* serve: Edge → T1, Core → T3. */
function profileMaxTier(profile: DeviceProfile): number {
	return profile === 'core' ? 3 : 1;
}

/** A profile can serve a tier only if it is within the profile's permanent ceiling. */
export function profileAllows(profile: DeviceProfile, tier: number): boolean {
	return tier <= profileMaxTier(profile);
}

export interface MemberWillingnessOptions {
	/** Per-tier restriction overrides (default all-true); may only turn a tier *off*. */
	readonly overrides?: Partial<Record<Tier, boolean>>;
	/** Load bucket that trips willingness off for a tier (default 6, per cohort-topic.md). */
	readonly overloadBucket?: number;
}

export const DEFAULT_OVERLOAD_BUCKET = 6;

/** A cohort member's willingness inputs: profile ceiling, operator overrides, live load. */
export interface MemberWillingness {
	readonly profile: DeviceProfile;
	/** Operator restriction per tier; `false` forces a tier off regardless of load. */
	readonly overrides: boolean[];
	/** 3-bit per-tier load barometer, 0..7. */
	readonly loadBucket: number[];
	readonly overloadBucket: number;
}

export function makeMemberWillingness(
	profile: DeviceProfile,
	opts: MemberWillingnessOptions = {}
): MemberWillingness {
	const overrides = [true, true, true, true];
	if (opts.overrides) {
		for (const [tier, allow] of Object.entries(opts.overrides)) {
			overrides[Number(tier)] = allow as boolean;
		}
	}
	return {
		profile,
		overrides,
		loadBucket: [0, 0, 0, 0],
		overloadBucket: opts.overloadBucket ?? DEFAULT_OVERLOAD_BUCKET
	};
}

/** Set a member's load bucket for a tier (0..7); willingness re-derives from it lazily. */
export function setMemberLoadBucket(m: MemberWillingness, tier: Tier, bucket: number): void {
	assertBucket(bucket);
	m.loadBucket[tier] = bucket;
}

/**
 * Effective willingness for a tier: within the profile ceiling, not overridden off, and not
 * shedding under overload. Edge T2/T3 fail the profile check, so they are never willing.
 */
export function isWilling(m: MemberWillingness, tier: Tier): boolean {
	return (
		profileAllows(m.profile, tier) &&
		m.overrides[tier]! &&
		m.loadBucket[tier]! < m.overloadBucket
	);
}

/** The 4-entry boolean willingness vector (T0..T3). */
export function willingnessVector(m: MemberWillingness): boolean[] {
	return [0, 1, 2, 3].map((t) => isWilling(m, t as Tier));
}

/** Pack willingness into a 4-bit number, bit `t` set iff the member serves tier `t`. */
export function willingnessBits(m: MemberWillingness): number {
	let bits = 0;
	for (let t = 0; t < TIER_COUNT; t++) {
		if (isWilling(m, t as Tier)) {
			bits |= 1 << t;
		}
	}
	return bits;
}

/**
 * Cohort-aggregate willingness vector packed into 4 bits: bit `t` set iff at least `quorum`
 * members are willing to serve tier `t`. This is the gossiped per-cohort barometer that a
 * member uses to answer `UnwillingCohort` without polling siblings.
 */
export function cohortWillingnessBits(members: readonly MemberWillingness[], quorum: number): number {
	let bits = 0;
	for (let t = 0; t < TIER_COUNT; t++) {
		let willing = 0;
		for (const m of members) {
			if (isWilling(m, t as Tier)) {
				willing++;
			}
		}
		if (willing >= quorum) {
			bits |= 1 << t;
		}
	}
	return bits;
}

export type AdmissionResult = 'accepted' | 'unwilling_member' | 'unwilling_cohort';

export interface AdmissionVerdict {
	readonly result: AdmissionResult;
	/** For `unwilling_member`: indices of cohort members that will serve this tier. */
	readonly candidates?: number[];
}

/**
 * Classify a registration that FRET routed onto `routedIndex` for `tier`
 * (cohort-topic.md §Willingness):
 * - fewer than `quorum` members willing → `unwilling_cohort` (the cohort declines the tier),
 * - else routed member willing → `accepted`,
 * - else → `unwilling_member`, naming the willing siblings to retry.
 */
export function classifyAdmission(
	members: readonly MemberWillingness[],
	tier: Tier,
	routedIndex: number,
	quorum: number
): AdmissionVerdict {
	const candidates: number[] = [];
	for (let i = 0; i < members.length; i++) {
		if (isWilling(members[i]!, tier)) {
			candidates.push(i);
		}
	}
	if (candidates.length < quorum) {
		return { result: 'unwilling_cohort' };
	}
	if (isWilling(members[routedIndex]!, tier)) {
		return { result: 'accepted' };
	}
	return { result: 'unwilling_member', candidates };
}

function assertBucket(bucket: number): void {
	if (!Number.isInteger(bucket) || bucket < 0 || bucket > 7) {
		throw new RangeError(`load bucket must be an integer in [0, 7], got ${bucket}`);
	}
}
