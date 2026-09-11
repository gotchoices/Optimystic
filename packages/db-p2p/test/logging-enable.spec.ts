/**
 * Ticket: enable-optimystic-logging-on-every-debug-copy (GitHub issue #8).
 *
 * `packages/db-core/test/logger-registry.spec.ts` pins the registry's semantics with fake `debug`
 * modules. This pins the thing the registry exists for, against REAL copies: under this repo's
 * install (`nmHoistingLimits: workspaces` in `.yarnrc.yml`) db-core and db-p2p each load their own
 * `debug`, so a `debug.enable(...)` on either reaches only half of the `optimystic:*` channels. One
 * `enableOptimysticLogging` call must turn on both, whichever order loggers and the call happen in.
 *
 * Nothing here is React Native-specific: the only RN fact is that `debug` finds no filter to load
 * at start-up, which is upstream behaviour. The fan-out is platform-independent.
 */

import { createRequire } from 'node:module';
import { expect } from 'chai';
import debug from 'debug';
import { disableOptimysticLogging, enableOptimysticLogging } from '@optimystic/db-core';
import { createLogger } from '../src/logger.js';

/** db-core's own copy of `debug` — the module its `createLogger` builds channels on. */
const coreDebug = createRequire(import.meta.resolve('@optimystic/db-core'))('debug') as typeof debug;

describe('enableOptimysticLogging across two real debug copies', () => {
	const lines: unknown[][] = [];
	const sink = (...args: unknown[]): void => { lines.push(args); };
	const text = (args: unknown[]): string => args.map(String).join(' ');

	// Start every spec from "nothing on" on both copies, whatever DEBUG the run was started with, and
	// put that back at the end — the same save/restore `test/support/capture-log.ts` does.
	let previous: { p2p: string, core: string };
	before(() => {
		previous = { p2p: debug.disable(), core: coreDebug.disable() };
	});
	after(() => {
		if (previous.core) coreDebug.enable(previous.core);
		if (previous.p2p) debug.enable(previous.p2p);
	});
	beforeEach(() => { lines.length = 0; });
	afterEach(() => { disableOptimysticLogging(); });

	it('precondition: db-core and db-p2p load different copies of debug', () => {
		expect(
			coreDebug !== debug,
			'db-core and db-p2p now resolve the SAME `debug` copy: the install dedupes it (did `nmHoistingLimits` '
			+ 'in .yarnrc.yml change?). This spec no longer exercises the multi-copy case it exists for.'
		).to.equal(true);
	});

	it('finds both copies registered, as separate entries', () => {
		const report = enableOptimysticLogging('optimystic:*', { log: sink });

		const core = report.copies.find(owners => owners.includes('db-core'));
		const p2p = report.copies.find(owners => owners.includes('db-p2p'));
		expect(core, `db-core never registered its debug copy: ${JSON.stringify(report.copies)}`).to.not.equal(undefined);
		expect(p2p, `db-p2p never registered its debug copy: ${JSON.stringify(report.copies)}`).to.not.equal(undefined);
		expect(core).to.not.equal(p2p);
	});

	it('turns on channels built BEFORE the call, on both copies', () => {
		const p2pLog = createLogger('enable-probe-before');
		const coreLog = coreDebug('optimystic:db-core:enable-probe-before');
		expect(p2pLog.enabled).to.equal(false);
		expect(coreLog.enabled).to.equal(false);

		enableOptimysticLogging('optimystic:*', { log: sink });

		expect(p2pLog.enabled, 'db-p2p channel').to.equal(true);
		expect(p2pLog.error.enabled, 'db-p2p :error child').to.equal(true);
		expect(coreLog.enabled, 'db-core channel').to.equal(true);
	});

	it('turns on channels built AFTER the call, on both copies', () => {
		enableOptimysticLogging('optimystic:*', { log: sink });

		expect(createLogger('enable-probe-after').enabled, 'db-p2p channel').to.equal(true);
		expect(coreDebug('optimystic:db-core:enable-probe-after').enabled, 'db-core channel').to.equal(true);
	});

	it('routes both copies\' lines, confirmation first, into options.log — and gives each copy its own sink back', () => {
		const p2pSink = debug.log;
		const coreSink = coreDebug.log;

		enableOptimysticLogging('optimystic:*', { log: sink });
		createLogger('enable-probe-sink')('from-db-p2p');
		coreDebug('optimystic:db-core:enable-probe-sink')('from-db-core');

		expect(text(lines[0]!)).to.match(/^optimystic logging on: "optimystic:\*" across \d+ debug copies \[/);
		expect(lines.some(args => text(args).includes('from-db-p2p')), 'db-p2p line').to.equal(true);
		expect(lines.some(args => text(args).includes('from-db-core')), 'db-core line').to.equal(true);

		disableOptimysticLogging();
		expect(debug.log).to.equal(p2pSink);
		expect(coreDebug.log).to.equal(coreSink);
		expect(createLogger('enable-probe-sink').enabled).to.equal(false);
		expect(coreDebug('optimystic:db-core:enable-probe-sink').enabled).to.equal(false);
	});

	it('leaves an app\'s own channels on a shared copy on, through enable and disable', () => {
		try {
			debug.enable('myapp:*');
			enableOptimysticLogging('optimystic:*', { log: sink });
			expect(debug.enabled('myapp:thing'), 'after enable').to.equal(true);
			expect(debug.enabled('optimystic:db-p2p:thing')).to.equal(true);

			disableOptimysticLogging();
			expect(debug.enabled('myapp:thing'), 'after disable').to.equal(true);
			expect(debug.enabled('optimystic:db-p2p:thing')).to.equal(false);
		} finally {
			debug.disable();
		}
	});

	it('does not write process.env.DEBUG, so a copy loaded later does not inherit our namespaces as its own', () => {
		const before = process.env.DEBUG;
		enableOptimysticLogging('optimystic:*', { log: sink });
		expect(process.env.DEBUG).to.equal(before);
		disableOptimysticLogging();
		expect(process.env.DEBUG).to.equal(before);
	});

	/**
	 * Enabling moves namespaces and sinks, never format specifiers: db-p2p's `%b`/`%p`/… live on
	 * db-p2p's own copy (see the NOTE in `src/logger.ts`), so its lines keep rendering, and db-core's
	 * copy still does not have them.
	 */
	it('keeps db-p2p\'s format specifiers on db-p2p\'s copy only', () => {
		enableOptimysticLogging('optimystic:*', { log: sink });
		createLogger('enable-probe-fmt')('b58=%b', Uint8Array.from([0, 1, 2, 3, 255, 128, 7]));

		expect(lines.some(args => text(args).includes('b58=1W7N4wCi'))).to.equal(true);
		expect(coreDebug.formatters['b'], 'db-core\'s copy gained db-p2p\'s %b specifier').to.equal(undefined);
	});
});
