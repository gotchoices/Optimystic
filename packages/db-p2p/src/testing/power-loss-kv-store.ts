import type { IKVStore } from '../storage/i-kv-store.js';
import { WriteGroup, type CommittedBatch, type WriteGroupEntry } from '../storage/write-group.js';

const encoder = new TextEncoder();
// Built on first use rather than at module load (see NO_MODULE_SCOPE_TEXT_DECODER in eslint.config.js).
let decoderInstance: TextDecoder | undefined;
const decoder = (): TextDecoder => decoderInstance ??= new TextDecoder();

/** Thrown by every operation of a {@link PowerLossKVStore} after its {@link PowerLossKVStore.powerLoss}. */
export class StoreLostPowerError extends Error {
	constructor() {
		super('this store lost power: everything it held in memory is gone; reopen() it');
		this.name = 'StoreLostPowerError';
	}
}

/**
 * Test-only {@link IKVStore} that models a crash: the `IKVStore` counterpart of `MemoryBatchBackend`'s
 * power-loss double. Writes go through a {@link WriteGroup} the way `FileKVStore`'s do — a `set` or
 * `delete` resolves into the group's memory at once and is served from there — and `flush()` commits
 * everything written since the last one to the durable rows. {@link powerLoss} is the crash: what no
 * flush reached is gone, and {@link reopen} opens a fresh store over what survived, as the
 * conformance reopen case opens a fresh driver.
 *
 * Two differences from a real store, both so a test decides where the crash lands:
 *
 * - **It never flushes on its own.** A real write group flushes a write no `flush()` reached after an
 *   idle timeout; this one does not, so an unflushed write stays lost-on-crash until a flush.
 * - **A flushed write is durable when the flush resolves.** `IKVStore.flush` takes no window, so
 *   every flush is strict and there is no committed-but-not-yet-synced state to model, which is why
 *   this has no `deferSync`: the crash window is between a write and the flush after it.
 *
 * Deliberately not a `MemoryKVStore` subclass: the Quereus plugin refuses a `MemoryKVStore` as an
 * offline journal, and this store is the one that survives a (simulated) restart.
 */
export class PowerLossKVStore implements IKVStore {
	private readonly group: WriteGroup<string>;
	private lost = false;

	/** @param durable What survived every earlier crash; shared with the store {@link reopen} returns. */
	constructor(private readonly durable: Map<string, string> = new Map()) {
		this.group = new WriteGroup<string>(key => key, {
			commit: async entries => this.apply(entries),
			sync: () => Promise.resolve(),
		}, { setTimer: () => () => undefined });
	}

	async get(key: string): Promise<string | undefined> {
		this.throwIfLost();
		const held = this.group.lookup(key);
		if (held !== undefined) return held === null ? undefined : decoder().decode(held);
		return this.durable.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		this.throwIfLost();
		this.group.put(key, encoder.encode(value));
	}

	async delete(key: string): Promise<void> {
		this.throwIfLost();
		this.group.delete(key);
	}

	/** Every key starting with `prefix`: the durable ones, plus those written and not yet flushed, less
	 * those deleted and not yet flushed. */
	async list(prefix: string): Promise<string[]> {
		this.throwIfLost();
		const keys = new Set([...this.durable.keys()].filter(key => key.startsWith(prefix)));
		for (const [key, value] of this.group.entries()) {
			if (!key.startsWith(prefix)) continue;
			if (value === null) keys.delete(key);
			else keys.add(key);
		}
		return [...keys];
	}

	async flush(): Promise<void> {
		this.throwIfLost();
		await this.group.flush();
	}

	/** The crash: every write no flush reached is lost, and this store refuses everything from now on
	 * ({@link StoreLostPowerError}), since the process that held it is gone. */
	powerLoss(): void {
		this.lost = true;
	}

	/** A fresh store over what survived {@link powerLoss}, which must have run first: two live stores
	 * over one set of rows would each lose the other's unflushed writes. */
	reopen(): PowerLossKVStore {
		if (!this.lost) throw new Error('PowerLossKVStore.reopen: the store has not lost power; call powerLoss() first');
		return new PowerLossKVStore(this.durable);
	}

	/** A commit that was waiting behind another when the power went never lands. */
	private apply(entries: readonly WriteGroupEntry<string>[]): CommittedBatch {
		this.throwIfLost();
		for (const { key, value } of entries) {
			if (value === undefined) this.durable.delete(key);
			else this.durable.set(key, decoder().decode(value));
		}
		return { durable: Promise.resolve() };
	}

	private throwIfLost(): void {
		if (this.lost) throw new StoreLostPowerError();
	}
}
