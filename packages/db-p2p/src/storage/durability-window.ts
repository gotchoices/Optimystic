/**
 * How long a storage write may wait before it is forced onto disk, computed from how many machines
 * would all have to lose power (or crash) within that wait for the write to be lost.
 *
 * A write acknowledged by a cohort of `n` members at promise threshold `t` is lost only if every
 * holder a rival write would have to out-vote loses it while it sat unsynced:
 * - approvals a rival needs: `a = ceil(t·n)`
 * - holders when the write is acknowledged, at minimum: `h = floor(n/2) + 1`
 * - holders that must lose it together: `m = a + h − n`, at least 1
 *
 * With `p` the per-machine rate of power cuts and operating-system crashes and `ε` the accepted
 * chance of losing one acknowledged write, independent failures give a loss chance of about
 * `C(h, m)·(p·w)^m`, so `w = (ε / C(h, m))^(1/m) / p`, capped at `maxWindowMs`. See
 * docs/correctness.md, Theorem 6.
 */

/** Options for {@link resolveDurabilityWindowPolicy}; `NodeOptions.storageDurability`. */
export interface StorageDurabilityOptions {
	/** Whether this deployment's machines lose power and crash independently of each other. Default true. False makes every write sync before it is reported (two machines on one circuit, say). */
	independentFailures?: boolean;
	/** Power cuts plus operating-system crashes per machine per hour. Default 1/720 (one per 30-day month). */
	lossRatePerHour?: number;
	/** Accepted chance that an acknowledged write is lost. Default 1e-9. */
	lossTarget?: number;
	/** Hard cap on any computed window, in ms. Default 5000. */
	maxWindowMs?: number;
}

/** {@link StorageDurabilityOptions} with every default applied, plus the node's own cohort facts. */
export interface DurabilityWindowPolicy {
	readonly independentFailures: boolean;
	readonly lossRatePerHour: number;
	readonly lossTarget: number;
	readonly maxWindowMs: number;
	/** The promise threshold the node's consensus runs at (`superMajorityThreshold`). */
	readonly superMajorityThreshold: number;
	/** The node's resolved `clusterSize`; a cohort size above it is capped to it. */
	readonly declaredCohortSize: number;
}

export const DEFAULT_DURABILITY_LOSS_RATE_PER_HOUR = 1 / 720;
export const DEFAULT_DURABILITY_LOSS_TARGET = 1e-9;
export const DEFAULT_DURABILITY_MAX_WINDOW_MS = 5000;

const MS_PER_HOUR = 3_600_000;

/** Fill defaults and validate, throwing `RangeError` naming the offending field. */
export function resolveDurabilityWindowPolicy(
	options: StorageDurabilityOptions | undefined,
	context: { superMajorityThreshold: number; clusterSize: number }
): DurabilityWindowPolicy {
	const independentFailures = options?.independentFailures ?? true;
	if (typeof independentFailures !== 'boolean') {
		throw new RangeError(`storageDurability.independentFailures must be a boolean, got ${String(independentFailures)}`);
	}
	const lossRatePerHour = options?.lossRatePerHour ?? DEFAULT_DURABILITY_LOSS_RATE_PER_HOUR;
	if (!Number.isFinite(lossRatePerHour) || lossRatePerHour <= 0) {
		throw new RangeError(`storageDurability.lossRatePerHour must be a finite number above 0, got ${lossRatePerHour}`);
	}
	const lossTarget = options?.lossTarget ?? DEFAULT_DURABILITY_LOSS_TARGET;
	if (!Number.isFinite(lossTarget) || lossTarget <= 0 || lossTarget >= 1) {
		throw new RangeError(`storageDurability.lossTarget must be a finite number above 0 and below 1, got ${lossTarget}`);
	}
	const maxWindowMs = options?.maxWindowMs ?? DEFAULT_DURABILITY_MAX_WINDOW_MS;
	if (!Number.isFinite(maxWindowMs) || maxWindowMs < 0) {
		throw new RangeError(`storageDurability.maxWindowMs must be a finite number at or above 0, got ${maxWindowMs}`);
	}
	return {
		independentFailures,
		lossRatePerHour,
		lossTarget,
		maxWindowMs,
		superMajorityThreshold: context.superMajorityThreshold,
		declaredCohortSize: context.clusterSize,
	};
}

/**
 * The longest a write acknowledged by a cohort of `cohortSize` members may wait for its sync, in
 * whole milliseconds. 0 means the write must be synced before it is reported held: a cohort of one
 * (or none), a write only one machine would hold (`m = 1`), or a deployment whose machines do not
 * fail independently.
 */
export function durabilityWindowMs(cohortSize: number, policy: DurabilityWindowPolicy): number {
	if (!policy.independentFailures) {
		return 0;
	}
	// A malformed size (NaN, fractional) falls to the strict answer rather than a NaN or fractional-cohort window.
	const n = Math.min(Math.floor(cohortSize), policy.declaredCohortSize);
	if (!Number.isFinite(n) || n <= 1) {
		return 0;
	}
	const approvals = Math.ceil(policy.superMajorityThreshold * n);
	const holders = Math.floor(n / 2) + 1;
	const mustLose = Math.max(1, approvals + holders - n);
	if (mustLose === 1) {
		return 0;
	}
	const windowHours = Math.pow(policy.lossTarget / binomial(holders, mustLose), 1 / mustLose) / policy.lossRatePerHour;
	return Math.floor(Math.min(windowHours * MS_PER_HOUR, policy.maxWindowMs));
}

/** `C(n, k)` as a product of ratios; exact enough for the small cohort sizes this sees. */
function binomial(n: number, k: number): number {
	let result = 1;
	for (let i = 1; i <= k; i++) {
		result *= (n - k + i) / i;
	}
	return result;
}
