import { expect } from 'chai';
import { openOverPlugin, type NSPluginModule } from '../src/ns-opener.js';

describe('openOverPlugin', () => {
	it("a failed open rejects with the plugin's error and runs no statement", async () => {
		const failure = new Error('cannot open the database');
		const statements: string[] = [];
		const plugin: NSPluginModule = {
			openOrCreate: () => ({
				ready: Promise.reject(failure),
				execute: async (sql) => { statements.push(sql); },
				get: async (sql) => { statements.push(sql); return null; },
				select: async (sql) => { statements.push(sql); return []; },
				close: async () => {},
			}),
		};

		let raised: unknown;
		try {
			await openOverPlugin(plugin, 'optimystic.sqlite', 1);
		} catch (err) {
			raised = err;
		}

		expect(raised).to.equal(failure);
		expect(statements).to.deep.equal([]);
	});
});
