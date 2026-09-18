import { expect } from 'chai';
import { build, type BuildFailure, type Message } from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PartialCommitError as RootPartialCommitError } from '../dist/index.js';
import { PartialCommitError as PluginPartialCommitError } from '../dist/plugin.js';

// Regression guard: both entry points must bundle for a browser.
//
// `transaction/quereus-engine.ts` used to read `@quereus/quereus`'s package.json from disk at module
// load, to learn the Quereus version for `QUEREUS_ENGINE_ID`. That put `node:fs`, `node:url` and
// `node:path` imports, plus `import.meta.resolve`, in the root entry's graph, so any browser or React
// Native app importing from `@optimystic/quereus-plugin-optimystic` — even just for
// `PartialCommitError` — failed to build. The version is now fixed when the plugin is built
// (`scripts/write-quereus-version.mjs`).
//
// This bundles `src/index.ts` and `src/plugin.ts` with esbuild for `platform: 'browser'` and fails on
// any import that does not resolve (a Node built-in has no browser build) and on any `import.meta`.
// A browser would accept `import.meta`, but Hermes, React Native's JavaScript engine, rejects it at
// compile time; the `logOverride` makes esbuild report it as an error even from code under
// `node_modules`, where it would otherwise stay silent. Workspace dependencies resolve to their built
// `dist`, which `register.mjs`'s freshness check guarantees is current.
//
// Scope: this only proves the graph bundles for a browser. It does not run the bundle, and it does not
// apply Metro's resolver or compile with Hermes; `yarn check:rn` is the check for that.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const describeMessage = (message: Message): string =>
	`${message.location?.file ?? '<no file>'}: ${message.text}`;

describe('browser bundle', function () {
	// esbuild bundles the whole graph (libp2p, db-p2p, Quereus) in well under a second locally.
	this.timeout(60_000);

	it('bundles the root and ./plugin entries with no Node built-ins and no import.meta', async () => {
		const outcome = await build({
			absWorkingDir: packageRoot,
			entryPoints: ['src/index.ts', 'src/plugin.ts'],
			bundle: true,
			write: false,
			outdir: 'browser-bundle-check',
			platform: 'browser',
			format: 'esm',
			logLevel: 'silent',
			supported: { 'import-meta': false },
			logOverride: { 'empty-import-meta': 'error' },
		}).catch((failure: BuildFailure) => failure);

		const problems = outcome.errors.map(describeMessage);
		if (problems.length > 0) expect.fail(`the plugin no longer bundles for a browser:\n  ${problems.join('\n  ')}`);
	});
});

// Regression guard: `PartialCommitError` must be the SAME class whether a caller imports it from
// the root entry (`./index.js`) or the `./plugin` entry it more commonly loads through. Today that
// holds only because tsup.config.ts splits shared code into one chunk both entries pull from — see
// the comment next to `splitting` there. If a future build config change ever gives each entry its
// own copy, `instanceof` silently stops matching for every real error and nothing else here would
// catch it (verified: building once with `splitting: false` makes this fail).
describe('plugin error class identity', function () {
	it('exports the same PartialCommitError constructor from both entries', function () {
		expect(PluginPartialCommitError).to.equal(RootPartialCommitError);
	});

	it('classifies an error thrown through the plugin entry as instanceof the root export', function () {
		// Constructed via the `./plugin` entry's own export, i.e. the exact class reference the
		// plugin's internal commit-sweep code throws (see txn-bridge.ts) — not a re-implementation.
		const error = new PluginPartialCommitError(['tree-a'], ['tree-b'], new Error('injected'));
		expect(error).to.be.instanceOf(RootPartialCommitError);
	});
});
