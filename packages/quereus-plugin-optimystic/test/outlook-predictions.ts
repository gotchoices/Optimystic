/**
 * Every assured outlook the offline specs produce is checked against its outcome (docs/offline-sync.md
 * §Test plan): a transaction reported assured that then fails because a check refused — not through
 * expiry, discard, a validator's rejection or the size limit, and not through the failure of one it
 * depended on — counts in its plugin's `assuredFailures`, and a test that leaves any tracked plugin's
 * count above zero fails here.
 *
 * Plugins are tracked where the specs create them: `createMeshDbNode` in `mesh-node-harness.ts`, and
 * each offline spec's own `register` helper. The `afterEach` below is declared at the top level of a
 * module the specs import, so mocha attaches it to the root suite and it runs after every test of the
 * run; it checks the plugins that test created and forgets them. A test that fails an assured
 * transaction on purpose says so with {@link expectAssuredFailures}.
 *
 * Not a `.spec.ts` file on purpose — mocha's glob would otherwise load it as a suite.
 */

import { expect } from 'chai';
import type { OfflineModeState } from '../dist/index.js';

/** What this module needs of a plugin: its offline-mode state. */
type TrackedPlugin = { readonly offline: { queueState(): OfflineModeState } };

const tracked = new Set<TrackedPlugin>();

/** Check `plugin`'s assured failures when the current test ends. */
export function trackPredictions(plugin: TrackedPlugin): void {
	tracked.add(plugin);
}

/** Assert `plugin` has counted exactly `count` assured failures, and stop checking it for this test. */
export function expectAssuredFailures(plugin: TrackedPlugin, count: number): void {
	expect(plugin.offline.queueState().assuredFailures, 'transactions reported assured that failed anyway').to.equal(count);
	tracked.delete(plugin);
}

// NOTE: a failing root hook makes mocha skip every remaining test of the run, so one false assured
// outlook hides whatever else that run would have reported. Fine while the count stays at zero; if
// this hook ever fires routinely, fail the test itself instead (check inside the specs' own helpers).
afterEach(function () {
	const failures = [...tracked].map(plugin => plugin.offline.queueState().assuredFailures);
	tracked.clear();
	expect(failures.filter(count => count > 0), 'transactions reported assured that failed anyway (offline:assured-entry-failed)').to.deep.equal([]);
});
