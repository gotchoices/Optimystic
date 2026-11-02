import { COST_PRESETS, type ModuleCostProfile } from '@quereus/quereus';

/** A storage category Quereus publishes a cost profile for (`COST_PRESETS`). */
export type CostPresetName = keyof typeof COST_PRESETS;

/**
 * The plugin config's `cost_profile` (README § Plugin-Level Configuration): a preset name, or a
 * profile object — the object only through `register()`, since SQL cannot express one.
 */
export type CostProfileConfig = CostPresetName | ModuleCostProfile;

const profileFields: ReadonlySet<string> = new Set<keyof ModuleCostProfile>(['firstRowLatencyMs', 'perRowLatencyMs']);

/**
 * What reading the module's tables costs, for `OptimysticModule.costProfile`: the declared
 * `cost_profile` when the config carries one, which replaces the mapping entirely, else the
 * category the default transactor's storage falls in. `undefined` is Quereus's in-process
 * `memory`. A `cost_profile` this does not understand throws, so `register` refuses it rather than
 * planning with a profile nobody declared — stricter than Quereus, which would read a bad field
 * as 0 and warn.
 */
export function moduleCostProfile(defaultTransactor: string, declared: unknown): ModuleCostProfile | undefined {
	if (declared !== undefined) return declaredCostProfile(declared);
	return transactorCostProfile(defaultTransactor);
}

/**
 * The category a transactor's storage falls in, or `undefined` where the plugin cannot know it:
 * `test` and `mesh-test` run in process; `local` is memory unless the host passed a
 * `rawStorageFactory`, an opaque function that may front a disk, IndexedDB or MMKV; a
 * host-registered transactor is unknown to the plugin altogether. The host declares those.
 */
// NOTE: `network` maps to `distributed`, though in a group no larger than one cohort a node that
// holds the block answers from its own replica (`selfReadVerdict` in
// `packages/db-p2p/src/libp2p-key-network.ts`) and the read runs at local speed. The group's size
// is not visible at registration, and the two errors are not alike: overstating costs planner
// overhead (scans over seeks, parallel and prefetch rules firing on cheap reads); understating
// brings back one round trip per outer row of a nested loop over a genuinely remote table. Small
// deployments override with `cost_profile` (README § Plugin-Level Configuration).
function transactorCostProfile(transactor: string): ModuleCostProfile | undefined {
	return transactor === 'network' ? COST_PRESETS.distributed : undefined;
}

function declaredCostProfile(declared: unknown): ModuleCostProfile {
	if (typeof declared === 'string') return presetNamed(declared);
	if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
		return profileObject(declared as Record<string, unknown>);
	}
	throw new Error(`cost_profile must be a preset name (${presetNames()}) or an object with firstRowLatencyMs and perRowLatencyMs; got ${shown(declared)}`);
}

function presetNamed(name: string): ModuleCostProfile {
	if (!Object.hasOwn(COST_PRESETS, name)) {
		throw new Error(`cost_profile '${name}' is not a preset; the presets are ${presetNames()}`);
	}
	return COST_PRESETS[name as CostPresetName];
}

/** A copy holding only the fields the host gave, frozen so a later edit of the host's object changes nothing. */
function profileObject(declared: Record<string, unknown>): ModuleCostProfile {
	for (const key of Object.keys(declared)) {
		if (!profileFields.has(key)) {
			throw new Error(`cost_profile.${key} is not a cost profile field; cost_profile takes ${[...profileFields].join(', ')}`);
		}
	}
	const profile: { firstRowLatencyMs?: number; perRowLatencyMs?: number } = {};
	const firstRowLatencyMs = latencyMs(declared.firstRowLatencyMs, 'firstRowLatencyMs');
	if (firstRowLatencyMs !== undefined) profile.firstRowLatencyMs = firstRowLatencyMs;
	const perRowLatencyMs = latencyMs(declared.perRowLatencyMs, 'perRowLatencyMs');
	if (perRowLatencyMs !== undefined) profile.perRowLatencyMs = perRowLatencyMs;
	return Object.freeze(profile);
}

function latencyMs(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(`cost_profile.${field} must be a finite, non-negative number of milliseconds; got ${shown(value)}`);
	}
	return value;
}

function presetNames(): string {
	return Object.keys(COST_PRESETS).map(name => `'${name}'`).join(', ');
}

function shown(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	return `${typeof value} ${String(value)}`;
}
