import { MemoryKVStore, type IKVStore } from '@optimystic/db-p2p';

/**
 * The `offline` block of the plugin's registration config (README § Offline mode), as `register`
 * receives it. `OfflineMode` consumes it parsed ({@link ParsedOfflineConfig}). Parsing lives apart
 * from the controller so the controller is only the mode and its translation of the queue's events.
 */
export interface OfflineConfig {
	/** Persist queued transactions in this store (docs/offline-sync.md §Persistence): an `IKVStore`, or
	 * a function returning one, called once inside `register`. Absent: the queue lives in memory and a
	 * crash loses whatever was queued. A `MemoryKVStore` is refused — leave this off instead. */
	journal?: IKVStore | (() => IKVStore);
	/** The journal's records are keyed under `optimystic-offline/<journalLabel>/`, so two `Database`s
	 * over one store keep apart by giving each its own label; two with the same label corrupt each
	 * other's queue. Lowercase letters, digits, `_` and `-`. Default `'default'`; refused without `journal`. */
	journalLabel?: string;
	/** Fail a queued transaction that stays unsettled this long, with reason `expired`. Default: no limit. */
	expireAfterMs?: number;
	/** How long a terminal outcome stays in `outcomes()` / `status()`. Default seven days. */
	outcomeRetentionMs?: number;
	/** The drain's re-check timer while the cohort is unreachable or after a transient failure
	 * (`OfflineQueueOptions.recheck`): exponential from `baseMs` to `maxMs`. Advanced; tests shorten it. */
	recheck?: { baseMs?: number; maxMs?: number };
	/** How long a network-acknowledged commit made while transactions are queued waits behind them
	 * before throwing `OfflineCommitTimeoutError` (docs/offline-sync.md §Network acknowledgement behind
	 * a non-empty queue). Default `NetworkCommitBoundMs`, five minutes. */
	networkCommitTimeoutMs?: number;
}

/** {@link OfflineConfig} as `OfflineMode` takes it: a journal factory already called. */
export type ParsedOfflineConfig = Omit<OfflineConfig, 'journal'> & { journal?: IKVStore };

/** The journal label when none is given. */
export const DEFAULT_JOURNAL_LABEL = 'default';

/** A label is one key segment and a directory name under `FileKVStore`; lowercase only, because a
 * filesystem that ignores case (Windows, macOS by default) would put `One` and `one` in one directory,
 * which is the two-`Database`s-one-label corruption by another route. */
// NOTE: a Windows device name (`con`, `nul`, `aux`, …) passes this and fails every journal write
// under `FileKVStore` on Windows — loudly, as a failed commit, never as corruption. If an application
// ever meets it, refuse those names here.
const JOURNAL_LABEL = /^[a-z0-9_-]+$/;

const offlineKeys: ReadonlySet<string> = new Set(['journal', 'journalLabel', 'expireAfterMs', 'outcomeRetentionMs', 'recheck', 'networkCommitTimeoutMs']);
const recheckKeys: ReadonlySet<string> = new Set(['baseMs', 'maxMs']);
const kvStoreMethods = ['get', 'set', 'delete', 'list'] as const;

/**
 * Read `config.offline` as `register` received it, refusing anything it does not understand: a
 * misspelt key is an error here rather than a silently different configuration later
 * (`allowSoloCommit` arrives with a later stage and is refused until then). A `journal` given as a
 * factory is called here, once; whatever it throws is thrown out of `register`.
 */
export function parseOfflineConfig(declared: unknown): ParsedOfflineConfig {
	if (declared === undefined) return {};
	const offline = plainObject(declared, 'offline');
	refuseUnknownKeys(offline, 'offline', offlineKeys);
	const config: ParsedOfflineConfig = {};
	if (offline.journal !== undefined) config.journal = journalStore(offline.journal);
	const journalLabel = parseJournalLabel(offline.journalLabel, config.journal !== undefined);
	if (journalLabel !== undefined) config.journalLabel = journalLabel;
	const expireAfterMs = positiveMs(offline.expireAfterMs, 'offline.expireAfterMs');
	if (expireAfterMs !== undefined) config.expireAfterMs = expireAfterMs;
	const outcomeRetentionMs = positiveMs(offline.outcomeRetentionMs, 'offline.outcomeRetentionMs');
	if (outcomeRetentionMs !== undefined) config.outcomeRetentionMs = outcomeRetentionMs;
	const networkCommitTimeoutMs = positiveMs(offline.networkCommitTimeoutMs, 'offline.networkCommitTimeoutMs');
	if (networkCommitTimeoutMs !== undefined) config.networkCommitTimeoutMs = networkCommitTimeoutMs;
	if (offline.recheck !== undefined) {
		const recheck = plainObject(offline.recheck, 'offline.recheck');
		refuseUnknownKeys(recheck, 'offline.recheck', recheckKeys);
		config.recheck = {};
		const baseMs = positiveMs(recheck.baseMs, 'offline.recheck.baseMs');
		if (baseMs !== undefined) config.recheck.baseMs = baseMs;
		const maxMs = positiveMs(recheck.maxMs, 'offline.recheck.maxMs');
		if (maxMs !== undefined) config.recheck.maxMs = maxMs;
	}
	return config;
}

/** `declared` as the journal's store: the store itself, or what a factory returns, checked by shape. */
function journalStore(declared: unknown): IKVStore {
	const store = typeof declared === 'function' ? (declared as () => unknown)() : declared;
	if (store instanceof MemoryKVStore) {
		throw new Error('offline.journal is a MemoryKVStore, which does not survive a restart: a journal lost with the process is the no-journal configuration, so leave offline.journal off instead');
	}
	if (typeof store !== 'object' || store === null) {
		throw new Error(`offline.journal must be an IKVStore or a function returning one; got ${store === null ? 'null' : typeof store}`);
	}
	const shaped = store as Record<string, unknown>;
	const missing: string[] = kvStoreMethods.filter(method => typeof shaped[method] !== 'function');
	if (shaped.flush !== undefined && typeof shaped.flush !== 'function') missing.push('flush (present but not a function)');
	if (missing.length > 0) {
		throw new Error(`offline.journal must be an IKVStore (get, set, delete and list functions, and flush when present); missing: ${missing.join(', ')}`);
	}
	return store as IKVStore;
}

function parseJournalLabel(value: unknown, journaled: boolean): string | undefined {
	if (value === undefined) return undefined;
	if (!journaled) throw new Error('offline.journalLabel names the journal\'s records, and is refused without offline.journal');
	if (typeof value !== 'string' || !JOURNAL_LABEL.test(value)) {
		throw new Error(`offline.journalLabel must be lowercase letters, digits, '_' and '-'; got ${typeof value === 'string' ? `'${value}'` : typeof value}`);
	}
	return value;
}

function plainObject(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${name} must be an object; got ${Array.isArray(value) ? 'an array' : typeof value}`);
	}
	return value as Record<string, unknown>;
}

function refuseUnknownKeys(object: Record<string, unknown>, name: string, known: ReadonlySet<string>): void {
	for (const key of Object.keys(object)) {
		if (!known.has(key)) {
			throw new Error(`${name}.${key} is not a registration option; ${name} takes ${[...known].join(', ')}`
				+ (name === 'offline' ? " ('allowSoloCommit' arrives with a later stage)" : ''));
		}
	}
}

function positiveMs(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number of milliseconds; got ${typeof value} ${String(value)}`);
	}
	return value;
}
