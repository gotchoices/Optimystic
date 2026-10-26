/**
 * The `offline` block of the plugin's registration config (README § Offline mode), as `register`
 * receives it and as `OfflineMode` consumes it. Parsing lives apart from the controller so the
 * controller is only the mode and its translation of the queue's events.
 */
export interface OfflineConfig {
	/** Fail a queued transaction that stays unsettled this long, with reason `expired`. Default: no limit. */
	expireAfterMs?: number;
	/** How long a terminal outcome stays in `outcomes()` / `status()`. Default seven days. */
	outcomeRetentionMs?: number;
	/** The drain's re-check timer while the cohort is unreachable or after a transient failure
	 * (`OfflineQueueOptions.recheck`): exponential from `baseMs` to `maxMs`. Advanced; tests shorten it. */
	recheck?: { baseMs?: number; maxMs?: number };
}

const offlineKeys: ReadonlySet<string> = new Set(['expireAfterMs', 'outcomeRetentionMs', 'recheck']);
const recheckKeys: ReadonlySet<string> = new Set(['baseMs', 'maxMs']);

/**
 * Read `config.offline` as `register` received it, refusing anything it does not understand: a
 * misspelt key is an error here rather than a silently different configuration later (`journal` and
 * `allowSoloCommit` arrive with later stages and are refused until then).
 */
export function parseOfflineConfig(declared: unknown): OfflineConfig {
	if (declared === undefined) return {};
	const offline = plainObject(declared, 'offline');
	refuseUnknownKeys(offline, 'offline', offlineKeys);
	const config: OfflineConfig = {};
	const expireAfterMs = positiveMs(offline.expireAfterMs, 'offline.expireAfterMs');
	if (expireAfterMs !== undefined) config.expireAfterMs = expireAfterMs;
	const outcomeRetentionMs = positiveMs(offline.outcomeRetentionMs, 'offline.outcomeRetentionMs');
	if (outcomeRetentionMs !== undefined) config.outcomeRetentionMs = outcomeRetentionMs;
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
				+ (name === 'offline' ? " ('journal' and 'allowSoloCommit' arrive with later stages)" : ''));
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
