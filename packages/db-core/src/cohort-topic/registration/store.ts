/**
 * Cohort-topic substrate — in-memory registration store.
 *
 * Per `docs/cohort-topic.md` §Registration mechanics. Records are doubly indexed: an outer map
 * keyed by topic, each holding an inner map keyed by participant. This gives O(1)
 * {@link RegistrationStore.getByParticipant} / {@link RegistrationStore.delete} and O(participants)
 * {@link RegistrationStore.listByTopic} without a secondary index to keep in sync. The store is
 * local soft state; cross-member replication runs over cohort gossip in a later ticket.
 */

import { createLogger } from "../../logger.js";
import { bytesKey } from "./bytes.js";
import type { RegistrationRecord, RegistrationStore } from "./types.js";

const log = createLogger("cohort-topic:registration");

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

/** Called once per record that a `put` made present where the store held none for its participant. */
export type RecordAddedListener = (rec: RegistrationRecord) => void;

/**
 * A store that reports each absent→present `put`. Every way a record reaches a member — local
 * admission, a gossip merge, a rotation-handoff pull — goes through `put`, so this is the one place
 * a "a registration arrived here" signal can be taken without missing a path. A `put` that replaces
 * a held record (a renewal touch, a re-attach restamp, a re-merge) reports nothing.
 */
class RecordAdditionObserver implements RegistrationStore {
	constructor(
		private readonly inner: RegistrationStore,
		private readonly onAdded: RecordAddedListener,
	) {}

	put(rec: RegistrationRecord): void {
		const added = this.inner.getByParticipant(rec.topicId, rec.participantId) === undefined;
		this.inner.put(rec);
		if (added) {
			this.notify(rec);
		}
	}

	getByParticipant(topicId: Uint8Array, participantId: Uint8Array): RegistrationRecord | undefined {
		return this.inner.getByParticipant(topicId, participantId);
	}

	listByTopic(topicId: Uint8Array): readonly RegistrationRecord[] {
		return this.inner.listByTopic(topicId);
	}

	listAll(): readonly RegistrationRecord[] {
		return this.inner.listAll();
	}

	delete(topicId: Uint8Array, participantId: Uint8Array): void {
		this.inner.delete(topicId, participantId);
	}

	directParticipants(topicId: Uint8Array): number {
		return this.inner.directParticipants(topicId);
	}

	evictStale(now: number): readonly RegistrationRecord[] {
		return this.inner.evictStale(now);
	}

	/** A listener fault must not abort the admission or gossip merge that called `put`. */
	private notify(rec: RegistrationRecord): void {
		try {
			this.onAdded(rec);
		} catch (err) {
			log("record-added listener threw for topic %s participant %s: %o", bytesKey(rec.topicId), bytesKey(rec.participantId), err);
		}
	}
}

/**
 * Wrap `store` so `onAdded` fires after each `put` that makes a `(topicId, participantId)` record
 * present where none was held. A listener throw is logged, never propagated into `put`.
 */
export function observeRecordAdditions(store: RegistrationStore, onAdded: RecordAddedListener): RegistrationStore {
	return new RecordAdditionObserver(store, onAdded);
}
