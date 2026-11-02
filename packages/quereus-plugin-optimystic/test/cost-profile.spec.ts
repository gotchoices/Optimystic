/**
 * The read cost the module declares to the planner (`moduleCostProfile`, README § Plugin-Level
 * Configuration): the storage category of the default transactor, unless the plugin config's
 * `cost_profile` replaces it — a preset name or a profile object — and a refusal for anything else.
 * One case per branch.
 */

import { expect } from 'chai';
import { COST_PRESETS } from '@quereus/quereus';
import { moduleCostProfile } from '../src/optimystic-adapter/cost-profile.js';

describe('moduleCostProfile: the read cost the plugin declares', () => {
	it('declares the distributed category for the network transactor', () => {
		expect(moduleCostProfile('network', undefined)).to.equal(COST_PRESETS.distributed);
	});

	it('declares nothing for an in-process transactor', () => {
		expect(moduleCostProfile('test', undefined)).to.equal(undefined);
	});

	it('reads an empty cost_profile as no declaration', () => {
		expect(moduleCostProfile('network', '')).to.equal(COST_PRESETS.distributed);
	});

	it('takes a preset named by cost_profile in place of the mapping', () => {
		expect(moduleCostProfile('network', 'localDisk')).to.equal(COST_PRESETS.localDisk);
	});

	it('passes a profile object through', () => {
		const declared = { ...COST_PRESETS.network, perRowLatencyMs: 0.02 };
		expect(moduleCostProfile('test', declared)).to.deep.equal(declared);
	});

	it('refuses a name that is not a preset', () => {
		expect(() => moduleCostProfile('network', 'toString')).to.throw(/cost_profile 'toString' is not a preset/);
	});

	it('refuses a key that is not a profile field', () => {
		expect(() => moduleCostProfile('network', { firstRowLatencyMs: 1, latencyMs: 2 })).to.throw(/cost_profile\.latencyMs is not a cost profile field/);
	});

	it('refuses a negative or non-finite field', () => {
		expect(() => moduleCostProfile('network', { perRowLatencyMs: -1 })).to.throw(/cost_profile\.perRowLatencyMs must be a finite, non-negative number/);
		expect(() => moduleCostProfile('network', { firstRowLatencyMs: Number.NaN })).to.throw(/cost_profile\.firstRowLatencyMs must be a finite, non-negative number/);
	});
});
