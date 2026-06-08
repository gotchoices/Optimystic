/**
 * Cohort-topic substrate — membership-rotation primary handoff.
 *
 * Per `docs/cohort-topic.md` §Membership rotation and primary handoff. When membership changes the
 * deterministic slot may move a registration's primary. Each member runs this state machine:
 *
 * 1. New membership stabilizes; all members compute the new `cohortEpoch`.
 * 2. Members exchange a "primary inventory" listing the records they hold as primary ({@link start}).
 * 3. For each record, the new computed primary either already holds it (no-op) or **pulls** it from
 *    the previous holder ({@link onInventory} → `transport.pull`).
 * 4. **Resolved (GROUNDING):** the previous primary keeps serving (**dual-serve**) until the new
 *    primary acknowledges receipt ({@link onAck}) — closing the delivery gap.
 * 5. Participants discover the new primary on their next ping/delivery (renewal module).
 *
 * The gossip *transport* for the inventory comes from a later ticket; it is injected here so the
 * machine is unit-testable with a mock. The machine is purely cohort-local — FRET is unaware of it.
 */

import { bytesEqual, recordKey } from "./bytes.js";
import type { SlotAssigner } from "./sharding.js";
import type { RegistrationRecord, RegistrationStore } from "./types.js";

/** Identifies one registration in a {@link PrimaryInventory} or pull/ack exchange. */
export interface RecordRef {
	topicId: Uint8Array;
	participantId: Uint8Array;
}

/** A member's list of registrations it currently holds as primary, under the new `cohortEpoch`. */
export interface PrimaryInventory {
	/** The advertising member. */
	from: Uint8Array;
	/** The new cohort epoch this inventory was computed under. */
	epoch: Uint8Array;
	entries: readonly RecordRef[];
}

/** Transport the handoff drives; supplied by the cohort-gossip ticket, mocked in tests. */
export interface HandoffTransport {
	/** Broadcast this member's primary inventory to the cohort. */
	sendInventory(inv: PrimaryInventory): void;
	/** Pull a record this member is now primary for from its previous holder. */
	pull(from: Uint8Array, ref: RecordRef): Promise<RegistrationRecord | undefined>;
	/** Acknowledge receipt to the previous holder, ending its dual-serve for `ref`. */
	ack(to: Uint8Array, ref: RecordRef): void;
}

export interface HandoffDeps {
	store: RegistrationStore;
	/** This member's own peer id. */
	self: Uint8Array;
	slots: SlotAssigner;
	/** The new (post-rotation) cohort snapshot. */
	cohort: () => { members: readonly Uint8Array[]; cohortEpoch: Uint8Array };
	transport: HandoffTransport;
}

/** Per-member primary-handoff driver. One instance handles one rotation. */
export interface MembershipHandoff {
	/** Step 1+2: recompute under the new epoch, publish this member's inventory, mark hand-offs. */
	start(): void;
	/** Step 3: react to a peer's inventory — pull every record now assigned to this member, then ack. */
	onInventory(inv: PrimaryInventory): Promise<void>;
	/** Serve a pull from the new primary (this member is the previous holder); stays dual-serving. */
	onPull(ref: RecordRef): RegistrationRecord | undefined;
	/** New primary acked receipt: stop dual-serving `ref`. */
	onAck(ref: RecordRef): void;
	/** Whether this member should still answer renews for `(topicId, participantId)` right now. */
	isServing(topicId: Uint8Array, participantId: Uint8Array): boolean;
}

class StoreMembershipHandoff implements MembershipHandoff {
	/** Records this member held as primary but no longer is — kept serving until acked. */
	private readonly dualServing = new Set<string>();
	/** In-flight pulls, so a duplicate inventory does not pull twice. */
	private readonly pulling = new Set<string>();

	constructor(private readonly deps: HandoffDeps) {}

	start(): void {
		const { members, cohortEpoch } = this.deps.cohort();
		const entries: RecordRef[] = [];
		for (const rec of this.deps.store.listAll()) {
			if (!bytesEqual(rec.primary, this.deps.self)) {
				continue; // only records this member currently holds as primary
			}
			entries.push({ topicId: rec.topicId, participantId: rec.participantId });
			const { primary } = this.deps.slots.assignSlots(rec.participantId, cohortEpoch, members);
			if (!bytesEqual(primary, this.deps.self)) {
				// Primary moved away from this member: keep serving until the new primary acks.
				this.dualServing.add(recordKey(rec.topicId, rec.participantId));
			}
		}
		this.deps.transport.sendInventory({ from: this.deps.self, epoch: cohortEpoch, entries });
	}

	async onInventory(inv: PrimaryInventory): Promise<void> {
		if (bytesEqual(inv.from, this.deps.self)) {
			return; // ignore our own inventory
		}
		const { members, cohortEpoch } = this.deps.cohort();
		for (const ref of inv.entries) {
			await this.maybePull(inv.from, ref, members, cohortEpoch);
		}
	}

	private async maybePull(from: Uint8Array, ref: RecordRef, members: readonly Uint8Array[], cohortEpoch: Uint8Array): Promise<void> {
		const { primary, backups } = this.deps.slots.assignSlots(ref.participantId, cohortEpoch, members);
		if (!bytesEqual(primary, this.deps.self)) {
			return; // not assigned to this member now
		}
		if (this.deps.store.getByParticipant(ref.topicId, ref.participantId) !== undefined) {
			return; // already hold it (no-op handoff)
		}
		const key = recordKey(ref.topicId, ref.participantId);
		if (this.pulling.has(key)) {
			return;
		}
		this.pulling.add(key);
		try {
			const rec = await this.deps.transport.pull(from, ref);
			if (rec !== undefined) {
				// Re-stamp the assignment so a later rotation's `start()` recognises this member as primary.
				this.deps.store.put({ ...rec, primary, backups });
				this.deps.transport.ack(from, ref); // ends dual-serve at the previous holder
			}
		} finally {
			this.pulling.delete(key);
		}
	}

	onPull(ref: RecordRef): RegistrationRecord | undefined {
		// Previous holder serves the record; it remains in dualServing until the ack arrives.
		return this.deps.store.getByParticipant(ref.topicId, ref.participantId);
	}

	onAck(ref: RecordRef): void {
		this.dualServing.delete(recordKey(ref.topicId, ref.participantId));
	}

	isServing(topicId: Uint8Array, participantId: Uint8Array): boolean {
		const { members, cohortEpoch } = this.deps.cohort();
		const { primary } = this.deps.slots.assignSlots(participantId, cohortEpoch, members);
		if (bytesEqual(primary, this.deps.self)) {
			return true;
		}
		return this.dualServing.has(recordKey(topicId, participantId));
	}
}

/** Build a {@link MembershipHandoff} for one rotation. */
export function createMembershipHandoff(deps: HandoffDeps): MembershipHandoff {
	return new StoreMembershipHandoff(deps);
}
