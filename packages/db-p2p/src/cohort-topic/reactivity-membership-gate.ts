/**
 * Reactivity origination membership gate (`docs/reactivity.md` §Anchor, `docs/internals.md`
 * §Cohort-Topic Origination Bridge).
 *
 * Builds the `selfIsCohortMember(event)` predicate the change-notifier bridge gates each member commit
 * on: this node is responsible for a collection's reactivity-topic fan-out iff it sits in the FRET
 * cohort around `coord_0(H(currentTailId ‖ "reactivity"))`. The tail comes from `event.tailId` (the seam
 * ticket put the committed `CommitRequest.tailId` on the change event), so the decision is synchronous —
 * no async storage read, no per-collection registry. A tail-less event (a read-driven promotion) is
 * never a member; those never originate and are cert-gated out downstream anyway.
 *
 * Extracted from the node assembly so the encoding + coord derivation are unit-testable in isolation and
 * reusable by the future reactivity origination wiring.
 */

import {
	createReactivityTopicAnchor,
	createTierAddressing,
	createRingHash,
	type ReactivityTopicAnchor,
	type TierAddressing,
	type CollectionChangeEvent,
	type BlockId,
} from "@optimystic/db-core";
import type { FretService } from "p2p-fret";

const utf8 = new TextEncoder();

/**
 * The pinned `BlockId` → raw tail bytes encoding fed into {@link ReactivityTopicAnchor.topicId}
 * (`reactivityTopicId`).
 *
 * A `BlockId` is a string and `reactivityTopicId` itself hashes `H(tailBytes ‖ "reactivity")`, so the
 * bytes here must be the tail block id's **raw** bytes — not a pre-hashed routing key. We use
 * `TextEncoder().encode(blockId)`, the same synchronous block-id→bytes convention the rest of db-p2p
 * already uses for ring hashing of tail ids (`cluster/client.ts` `recordCoordinatorForRecordIfSupported`,
 * `repo/client.ts` `extractKeyFromOperations`). db-core's async `blockIdToBytes` (which `sha256`s the
 * utf8 bytes first) is deliberately NOT used: it would (a) double-hash relative to the spec's
 * `H(tailId ‖ "reactivity")` and (b) force this synchronous gate to become async.
 *
 * Load-bearing: origination (this gate) and the subscriber side must feed `reactivityTopicId` the SAME
 * bytes for a given tail, or they resolve different coords and origination silently never reaches
 * subscribers. The subscriber-facing reactivity transport (a sibling ticket) must adopt this same
 * encoding when deriving its `tailIdAtAttach` bytes from a `BlockId`.
 */
export function reactivityTailBytes(tailId: BlockId): Uint8Array {
	return utf8.encode(tailId);
}

/** Construction inputs for {@link createReactivitySelfMembershipGate}. */
export interface ReactivitySelfMembershipGateDeps {
	/** FRET membership read — the cohort assembler around a served coord (returns peer-id strings). */
	readonly fret: Pick<FretService, "assembleCohort">;
	/** This node's peer-id string, compared against the assembled cohort. */
	readonly selfPeerId: string;
	/**
	 * Requested cohort size `wantK`. MUST equal the cohort-topic host's `wantK`, so the gate checks the
	 * exact cohort the host serves; a mismatch silently breaks origination.
	 */
	readonly wantK: number;
	/**
	 * Reactivity topic anchor. Default db-core's {@link createReactivityTopicAnchor} (256-bit SHA-256),
	 * byte-identical to the host's internal `new RingHash()` and the subscriber-side anchor.
	 */
	readonly anchor?: ReactivityTopicAnchor;
	/**
	 * Tier addressing. Default `createTierAddressing(createRingHash())`. `coord_0` is fan-out independent
	 * (`H(0x00 ‖ topicId)`), so the default fan-out is irrelevant to the tier-0 reactivity coord.
	 */
	readonly addressing?: TierAddressing;
}

/**
 * Build the synchronous `selfIsCohortMember(event)` gate for {@link attachCohortChangeBridge}.
 *
 * Returns `false` for a tail-less event; otherwise resolves `coord_0(H(event.tailId ‖ "reactivity"))`
 * via the shared anchor + tier addressing and returns whether `fret.assembleCohort(coord, wantK)`
 * includes this node's peer id. Pure aside from the live FRET read; membership churn between commits is
 * fine because reactivity is hint-only.
 */
export function createReactivitySelfMembershipGate(
	deps: ReactivitySelfMembershipGateDeps,
): (event: CollectionChangeEvent) => boolean {
	const anchor = deps.anchor ?? createReactivityTopicAnchor();
	const addressing = deps.addressing ?? createTierAddressing(createRingHash());
	return (event: CollectionChangeEvent): boolean => {
		if (event.tailId === undefined) {
			return false; // promotion / tail-less event never originates
		}
		const topicId = anchor.topicId(reactivityTailBytes(event.tailId));
		const coord = addressing.coord0(topicId);
		return deps.fret.assembleCohort(coord, deps.wantK).includes(deps.selfPeerId);
	};
}
