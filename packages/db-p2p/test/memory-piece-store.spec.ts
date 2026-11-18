import { expect } from 'chai';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { PowerLossPieceStore } from '../src/testing/power-loss-piece-store.js';
import { conformancePieceId, runPieceStoreConformance } from '../src/testing/piece-store-conformance.js';

runPieceStoreConformance('MemoryPieceStore', async () => ({
	store: new MemoryPieceStore(),
	cleanup: async () => {}
}));

runPieceStoreConformance('PowerLossPieceStore', async () => {
	const store = new PowerLossPieceStore();
	return {
		store,
		cleanup: async () => {},
		reopen: async () => {
			store.powerLoss();
			return store.reopen();
		}
	};
}, { persistent: true });

describe('PowerLossPieceStore', () => {
	it('loses a put no flush reached, and keeps one a flush did', async () => {
		const flushedBytes = Uint8Array.of(1, 2, 3);
		const unflushedBytes = Uint8Array.of(4, 5, 6);
		const flushed = await conformancePieceId(flushedBytes);
		const unflushed = await conformancePieceId(unflushedBytes);
		const store = new PowerLossPieceStore();

		await store.put(flushed, flushedBytes);
		await store.flush();
		await store.put(unflushed, unflushedBytes);
		store.powerLoss();
		const reopened = store.reopen();

		expect(await reopened.has(flushed), 'flushed put').to.equal(true);
		expect(await reopened.has(unflushed), 'unflushed put').to.equal(false);
	});
});
