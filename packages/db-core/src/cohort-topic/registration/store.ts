/**
 * Cohort-topic substrate — in-memory registration store.
 *
 * Per `docs/cohort-topic.md` §Registration mechanics. Records are doubly indexed: an outer map
 * keyed by topic, each holding an inner map keyed by participant. This gives O(1)
 * {@link RegistrationStore.getByParticipant} / {@link RegistrationStore.delete} and O(participants)
 * {@link RegistrationStore.listByTopic} without a secondary index to keep in sync. The store is
 * local soft state; cross-member replication runs over cohort gossip in a later ticket.
 */

import { bytesKey } from "./bytes.js";
import type { RegistrationRecord, RegistrationStore } from "./types.js";

class InMemoryRegistrationStore implements RegistrationStore {
	/** topicKey → (participantKey → record). Inner maps are pruned when they empty. */
	private readonly byTopic = new Map<string, Map<string, RegistrationRecord>>();

	put(rec: RegistrationRecord): void {
		const tk = bytesKey(rec.topicId);
		let inner = this.byTopic.get(tk);
		if (inner === undefined) {
			inner = new Map<string, RegistrationRecord>();
			this.byTopic.set(tk, inner);
		}
		inner.set(bytesKey(rec.participantId), rec);
	}

	getByParticipant(topicId: Uint8Array, participantId: Uint8Array): RegistrationRecord | undefined {
		return this.byTopic.get(bytesKey(topicId))?.get(bytesKey(participantId));
	}

	listByTopic(topicId: Uint8Array): readonly RegistrationRecord[] {
		const inner = this.byTopic.get(bytesKey(topicId));
		return inner === undefined ? [] : [...inner.values()];
	}

	listAll(): readonly RegistrationRecord[] {
		const out: RegistrationRecord[] = [];
		for (const inner of this.byTopic.values()) {
			for (const rec of inner.values()) {
				out.push(rec);
			}
		}
		return out;
	}

	delete(topicId: Uint8Array, participantId: Uint8Array): void {
		const tk = bytesKey(topicId);
		const inner = this.byTopic.get(tk);
		if (inner === undefined) return;
		inner.delete(bytesKey(participantId));
		if (inner.size === 0) {
			this.byTopic.delete(tk);
		}
	}

	directParticipants(topicId: Uint8Array): number {
		return this.byTopic.get(bytesKey(topicId))?.size ?? 0;
	}

	evictStale(now: number): readonly RegistrationRecord[] {
		const evicted: RegistrationRecord[] = [];
		for (const [tk, inner] of this.byTopic) {
			for (const [pk, rec] of inner) {
				if (now - rec.lastPing > rec.ttl) {
					evicted.push(rec);
					inner.delete(pk);
				}
			}
			if (inner.size === 0) {
				this.byTopic.delete(tk);
			}
		}
		return evicted;
	}
}

/** Construct an empty {@link RegistrationStore}. */
export function createRegistrationStore(): RegistrationStore {
	return new InMemoryRegistrationStore();
}
