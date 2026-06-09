/**
 * Matchmaking — cohort-side capability-filter evaluation (db-core, pure).
 *
 * Per `docs/matchmaking.md` §Capability filter: the filter is evaluated **locally at the cohort** and
 * is **advisory only** — it biases which providers the cohort returns but is never admission. The
 * seeker re-validates the returned set (`registrationSig`) and escalates if the filter matches too
 * little (§Edge cases 4). A pathological filter that matches almost nothing is therefore acceptable.
 *
 * Semantics (`docs/matchmaking.md` §Capability filter / §Wire formats):
 * - `must`    — every tag must be present in the provider's `capabilities`.
 * - `mustNot` — no tag may be present in the provider's `capabilities`.
 * - `minBudget` — when set, the provider's `capacityBudget` must be `>= minBudget`.
 *
 * An absent filter matches every provider.
 */

import type { CapabilityFilter } from "./wire.js";

/** The provider attributes a {@link CapabilityFilter} is evaluated against. */
export interface FilterableProvider {
	readonly capabilities: readonly string[];
	readonly capacityBudget: number;
}

/** True iff `p` satisfies `f` (`must` ⊆ caps, `mustNot` ∩ caps = ∅, `capacityBudget >= minBudget`). */
export function matchesFilter(p: FilterableProvider, f: CapabilityFilter | undefined): boolean {
	if (f === undefined) {
		return true;
	}
	const caps = new Set(p.capabilities);
	for (const tag of f.must) {
		if (!caps.has(tag)) {
			return false;
		}
	}
	for (const tag of f.mustNot) {
		if (caps.has(tag)) {
			return false;
		}
	}
	if (f.minBudget !== undefined && p.capacityBudget < f.minBudget) {
		return false;
	}
	return true;
}
