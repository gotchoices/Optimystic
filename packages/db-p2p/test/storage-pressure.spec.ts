import { expect } from 'chai';
import {
	DEFAULT_STORAGE_PRESSURE_THRESHOLDS,
	STORAGE_PRESSURE_STAGES,
	atLeastPressure,
	pressureStageOf,
	type StoragePressureStage
} from '../src/storage/storage-pressure.js';
import type { StorageCapacity } from '../src/storage/storage-account.js';

/**
 * A capacity as `StorageAccount.capacity()` answers one. `totalBytes` omitted is the unmeasurable
 * node — no allotment configured and a backend that reports no free space — and is the case every arm
 * of the chain must read as "do nothing".
 */
function capacity(usedBytes: number, totalBytes?: number): StorageCapacity {
	return {
		totalBytes,
		usedBytes,
		availableBytes: totalBytes === undefined ? undefined : Math.max(0, totalBytes - usedBytes)
	};
}

const thresholds = DEFAULT_STORAGE_PRESSURE_THRESHOLDS;

describe('storage pressure stages', () => {
	it('reads an unmeasurable node as `unknown` whatever it has stored, and orders that below every acting stage', () => {
		// Reading unknown as full is the failure this guards: a node that cannot measure itself would
		// otherwise shed responsibility and refuse data on a figure nobody measured. A use ABOVE 0 is
		// the case worth pinning — the node has stored something, and still knows nothing about its room.
		for (const usedBytes of [0, 1, 50 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
			expect(pressureStageOf(capacity(usedBytes), thresholds), `used=${usedBytes}`).to.equal('unknown');
		}
		for (const acting of ['slack', 'steady', 'shedding', 'refusing'] satisfies StoragePressureStage[]) {
			expect(atLeastPressure('unknown', acting), acting).to.equal(false);
		}
		expect(STORAGE_PRESSURE_STAGES[0]).to.equal('unknown');
	});

	it('puts each boundary on the calm side, and a node past its allotment in `refusing`', () => {
		// `usedBytes` is unclamped, so a node past its allotment reads above 1.0 — which is the point.
		// Each threshold is STRICT: a node sitting exactly on one is `steady` and does nothing.
		const cases: Array<{ used: number; total: number; expected: StoragePressureStage; why: string }> = [
			{ used: 0, total: 1000, expected: 'slack', why: 'empty' },
			{ used: 399, total: 1000, expected: 'slack', why: 'just below reclaimBelow (0.40)' },
			{ used: 400, total: 1000, expected: 'steady', why: 'exactly reclaimBelow: not slack' },
			{ used: 840, total: 1000, expected: 'steady', why: 'below shedAbove (0.85)' },
			{ used: 850, total: 1000, expected: 'steady', why: 'exactly shedAbove: not yet shedding' },
			{ used: 851, total: 1000, expected: 'shedding', why: 'past shedAbove' },
			{ used: 950, total: 1000, expected: 'shedding', why: 'exactly refuseAbove (0.95): not yet refusing' },
			{ used: 951, total: 1000, expected: 'refusing', why: 'past refuseAbove' },
			{ used: 1000, total: 1000, expected: 'refusing', why: 'exactly at the allotment' },
			{ used: 1400, total: 1000, expected: 'refusing', why: 'past the allotment: used > total' },
			{ used: 0, total: 0, expected: 'refusing', why: 'a location with no room at all is full, not empty' }
		];
		for (const { used, total, expected, why } of cases) {
			expect(pressureStageOf(capacity(used, total), thresholds), why).to.equal(expected);
		}
	});

	it('answers the stages in pressure order, so `at least shedding` covers refusing too', () => {
		expect(atLeastPressure('shedding', 'shedding')).to.equal(true);
		expect(atLeastPressure('refusing', 'shedding')).to.equal(true);
		expect(atLeastPressure('steady', 'shedding')).to.equal(false);
		expect(atLeastPressure('slack', 'steady')).to.equal(false);
	});
});
