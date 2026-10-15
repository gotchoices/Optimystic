import { expect } from 'chai';
import { durabilityWindowMs, resolveDurabilityWindowPolicy, type StorageDurabilityOptions } from '../src/storage/durability-window.js';

function policy(options?: StorageDurabilityOptions, clusterSize = 10) {
	return resolveDurabilityWindowPolicy(options, { superMajorityThreshold: 0.75, clusterSize });
}

describe('durabilityWindowMs', () => {
	it('gives the published table at the defaults: 0 for one member, the 5000 ms cap from two up', () => {
		const windows = Array.from({ length: 10 }, (_, i) => durabilityWindowMs(i + 1, policy()));
		expect(windows).to.deep.equal([0, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);
	});

	it('follows the formula below the cap', () => {
		const fast = policy({ lossRatePerHour: 1 });
		expect(durabilityWindowMs(2, fast)).to.equal(113);
		expect(durabilityWindowMs(4, fast)).to.equal(65);
	});

	it('is 0 for every cohort when failures are not independent', () => {
		const shared = policy({ independentFailures: false });
		for (let n = 0; n <= 10; n++) {
			expect(durabilityWindowMs(n, shared), `n=${n}`).to.equal(0);
		}
	});

	it('keeps a write only one machine would hold strict even with a loose loss target', () => {
		expect(durabilityWindowMs(1, policy({ lossTarget: 1e-3 }))).to.equal(0);
	});

	it('caps the cohort size at the declared cluster size', () => {
		const p = policy({ lossRatePerHour: 1 }, 3);
		expect(durabilityWindowMs(10, p)).to.equal(durabilityWindowMs(3, p));
	});
});

describe('resolveDurabilityWindowPolicy', () => {
	it('throws RangeError naming the field for an out-of-range value', () => {
		expect(() => policy({ lossRatePerHour: 0 })).to.throw(RangeError, /lossRatePerHour/);
		expect(() => policy({ lossTarget: 1 })).to.throw(RangeError, /lossTarget/);
		expect(() => policy({ maxWindowMs: -1 })).to.throw(RangeError, /maxWindowMs/);
	});
});
