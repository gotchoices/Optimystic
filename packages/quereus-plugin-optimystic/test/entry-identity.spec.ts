import { expect } from 'chai';
import * as rootEntry from '../dist/index.js';
import * as pluginEntry from '../dist/plugin.js';

// Regression guard: whatever the root entry (`./index.js`) and the `./plugin` entry both export must be
// the SAME object from either, checked against the built output. Hosts load the plugin through
// `./plugin` and often import error classes from the root; a copy per entry would silently break
// `instanceof` for every real error. Today the two entries share one chunk only because
// tsup.config.ts sets `splitting: true` (verified: building with `splitting: false` fails this).

// The classes callers classify commit and write failures by (docs/transactions.md). Both entries
// promise all of them, so the identity check below cannot pass vacuously by one entry dropping a name.
const errorClassNames = ['PartialCommitError', 'CoordinatorPartialCommitError', 'SyncRetryExhaustedError', 'TornActionError'] as const;

const root: Record<string, unknown> = rootEntry;
const plugin: Record<string, unknown> = pluginEntry;

describe('entry identity', function () {
	it('exports every commit-failure error class from both entries', function () {
		for (const name of errorClassNames) {
			expect(root[name], `root entry: ${name}`).to.be.a('function');
			expect(plugin[name], `./plugin entry: ${name}`).to.be.a('function');
		}
	});

	it('exports the identical object for every name both entries export', function () {
		const shared = Object.keys(plugin).filter(name => name !== 'default' && name in root);
		expect(shared).to.include.members([...errorClassNames]);
		for (const name of shared) expect(plugin[name], name).to.equal(root[name]);
		expect(plugin.default, "./plugin's default vs root's register").to.equal(root.register);
	});

	it('classifies a PartialCommitError made through ./plugin as instanceof the root export', function () {
		// `./plugin`'s export is a direct re-export of the class `TransactionBridge` throws, so this is
		// the same identity a caught commit failure would have.
		const error = new pluginEntry.PartialCommitError(['tree-a'], ['tree-b'], new Error('injected'));
		expect(error).to.be.instanceOf(rootEntry.PartialCommitError);
	});
});
