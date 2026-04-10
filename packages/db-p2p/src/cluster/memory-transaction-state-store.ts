import type { ITransactionStateStore, PersistedCoordinatorState, PersistedParticipantState } from "./i-transaction-state-store.js";

/** In-memory ITransactionStateStore. Default when no persistent store is injected. */
export class MemoryTransactionStateStore implements ITransactionStateStore {
	private readonly coordinatorStates = new Map<string, PersistedCoordinatorState>();
	private readonly participantStates = new Map<string, PersistedParticipantState>();
	private readonly executedMap = new Map<string, number>();

	async saveCoordinatorState(messageHash: string, state: PersistedCoordinatorState): Promise<void> {
		this.coordinatorStates.set(messageHash, state);
	}

	async getCoordinatorState(messageHash: string): Promise<PersistedCoordinatorState | undefined> {
		return this.coordinatorStates.get(messageHash);
	}

	async deleteCoordinatorState(messageHash: string): Promise<void> {
		this.coordinatorStates.delete(messageHash);
	}

	async getAllCoordinatorStates(): Promise<PersistedCoordinatorState[]> {
		return Array.from(this.coordinatorStates.values());
	}

	async saveParticipantState(messageHash: string, state: PersistedParticipantState): Promise<void> {
		this.participantStates.set(messageHash, state);
	}

	async getParticipantState(messageHash: string): Promise<PersistedParticipantState | undefined> {
		return this.participantStates.get(messageHash);
	}

	async deleteParticipantState(messageHash: string): Promise<void> {
		this.participantStates.delete(messageHash);
	}

	async getAllParticipantStates(): Promise<PersistedParticipantState[]> {
		return Array.from(this.participantStates.values());
	}

	async markExecuted(messageHash: string, timestamp: number): Promise<void> {
		this.executedMap.set(messageHash, timestamp);
	}

	async wasExecuted(messageHash: string): Promise<boolean> {
		return this.executedMap.has(messageHash);
	}

	async pruneExecuted(olderThan: number): Promise<void> {
		for (const [hash, ts] of this.executedMap) {
			if (ts < olderThan) {
				this.executedMap.delete(hash);
			}
		}
	}
}
