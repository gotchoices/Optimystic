import type { IKVStore } from "../storage/i-kv-store.js";
import type { ITransactionStateStore, PersistedCoordinatorState, PersistedParticipantState } from "./i-transaction-state-store.js";

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
		await this.kv.set(`coordinator/${messageHash}`, JSON.stringify(state));
	}

	async getCoordinatorState(messageHash: string): Promise<PersistedCoordinatorState | undefined> {
		const raw = await this.kv.get(`coordinator/${messageHash}`);
		return raw ? JSON.parse(raw) as PersistedCoordinatorState : undefined;
	}

	async deleteCoordinatorState(messageHash: string): Promise<void> {
		await this.kv.delete(`coordinator/${messageHash}`);
	}

	async getAllCoordinatorStates(): Promise<PersistedCoordinatorState[]> {
		const keys = await this.kv.list('coordinator/');
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
		await this.kv.set(`participant/${messageHash}`, JSON.stringify(state));
	}

	async getParticipantState(messageHash: string): Promise<PersistedParticipantState | undefined> {
		const raw = await this.kv.get(`participant/${messageHash}`);
		return raw ? JSON.parse(raw) as PersistedParticipantState : undefined;
	}

	async deleteParticipantState(messageHash: string): Promise<void> {
		await this.kv.delete(`participant/${messageHash}`);
	}

	async getAllParticipantStates(): Promise<PersistedParticipantState[]> {
		const keys = await this.kv.list('participant/');
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
		await this.kv.set(`executed/${messageHash}`, JSON.stringify({ timestamp }));
	}

	async wasExecuted(messageHash: string): Promise<boolean> {
		const raw = await this.kv.get(`executed/${messageHash}`);
		return raw !== undefined;
	}

	async pruneExecuted(olderThan: number): Promise<void> {
		const keys = await this.kv.list('executed/');
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
