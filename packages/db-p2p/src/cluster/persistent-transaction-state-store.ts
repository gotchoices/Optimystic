import type { IKVStore } from "../storage/i-kv-store.js";
import type { ITransactionStateStore, PersistedCoordinatorState, PersistedParticipantState } from "./i-transaction-state-store.js";

export const COORDINATOR_STATE_KEY_PREFIX = 'coordinator/';
export const PARTICIPANT_STATE_KEY_PREFIX = 'participant/';
export const EXECUTED_KEY_PREFIX = 'executed/';

/**
 * ITransactionStateStore backed by an IKVStore for cross-platform persistence.
 *
 * Key namespace:
 *   coordinator/{messageHash}  → JSON(PersistedCoordinatorState)
 *   participant/{messageHash}  → JSON(PersistedParticipantState)
 *   executed/{messageHash}     → JSON({ timestamp: number })
 */
export class PersistentTransactionStateStore implements ITransactionStateStore {
	constructor(private readonly kv: IKVStore) {}

	// --- Coordinator ---

	async saveCoordinatorState(messageHash: string, state: PersistedCoordinatorState): Promise<void> {
		await this.kv.set(`${COORDINATOR_STATE_KEY_PREFIX}${messageHash}`, JSON.stringify(state));
	}

	async getCoordinatorState(messageHash: string): Promise<PersistedCoordinatorState | undefined> {
		const raw = await this.kv.get(`${COORDINATOR_STATE_KEY_PREFIX}${messageHash}`);
		return raw ? JSON.parse(raw) as PersistedCoordinatorState : undefined;
	}

	async deleteCoordinatorState(messageHash: string): Promise<void> {
		await this.kv.delete(`${COORDINATOR_STATE_KEY_PREFIX}${messageHash}`);
	}

	async getAllCoordinatorStates(): Promise<PersistedCoordinatorState[]> {
		const keys = await this.kv.list(COORDINATOR_STATE_KEY_PREFIX);
		const results: PersistedCoordinatorState[] = [];
		for (const key of keys) {
			const raw = await this.kv.get(key);
			if (raw) {
				results.push(JSON.parse(raw) as PersistedCoordinatorState);
			}
		}
		return results;
	}

	// --- Participant ---

	async saveParticipantState(messageHash: string, state: PersistedParticipantState): Promise<void> {
		await this.kv.set(`${PARTICIPANT_STATE_KEY_PREFIX}${messageHash}`, JSON.stringify(state));
	}

	async getParticipantState(messageHash: string): Promise<PersistedParticipantState | undefined> {
		const raw = await this.kv.get(`${PARTICIPANT_STATE_KEY_PREFIX}${messageHash}`);
		return raw ? JSON.parse(raw) as PersistedParticipantState : undefined;
	}

	async deleteParticipantState(messageHash: string): Promise<void> {
		await this.kv.delete(`${PARTICIPANT_STATE_KEY_PREFIX}${messageHash}`);
	}

	async getAllParticipantStates(): Promise<PersistedParticipantState[]> {
		const keys = await this.kv.list(PARTICIPANT_STATE_KEY_PREFIX);
		const results: PersistedParticipantState[] = [];
		for (const key of keys) {
			const raw = await this.kv.get(key);
			if (raw) {
				results.push(JSON.parse(raw) as PersistedParticipantState);
			}
		}
		return results;
	}

	// --- Executed ---

	async markExecuted(messageHash: string, timestamp: number): Promise<void> {
		await this.kv.set(`${EXECUTED_KEY_PREFIX}${messageHash}`, JSON.stringify({ timestamp }));
	}

	async wasExecuted(messageHash: string): Promise<boolean> {
		const raw = await this.kv.get(`${EXECUTED_KEY_PREFIX}${messageHash}`);
		return raw !== undefined;
	}

	async pruneExecuted(olderThan: number): Promise<void> {
		const keys = await this.kv.list(EXECUTED_KEY_PREFIX);
		for (const key of keys) {
			const raw = await this.kv.get(key);
			if (raw) {
				const { timestamp } = JSON.parse(raw) as { timestamp: number };
				if (timestamp < olderThan) {
					await this.kv.delete(key);
				}
			}
		}
	}
}
