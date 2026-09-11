/**
 * Ticket: enable-optimystic-logging-on-every-debug-copy (GitHub issue #8).
 *
 * React Native cannot set `DEBUG`, so every `optimystic:*` channel was silently off there, and each
 * package may load its own copy of `debug`, so one `debug.enable()` cannot reach them all. Each
 * package now registers the copy it imported, and `enableOptimysticLogging` drives every registered
 * copy. These specs pin the registry's semantics against fake `debug` modules; the fan-out across
 * two REAL copies is pinned in `packages/db-p2p/test/logging-enable.spec.ts`.
 */

import { expect } from 'chai';
import {
	disableOptimysticLogging,
	enableOptimysticLogging,
	registerDebugModule,
	type DebugModule,
	type LogSink,
} from '../src/logger-registry.js';

const REGISTRY_KEY = Symbol.for('@optimystic/logger-registry');
const holder = globalThis as unknown as Record<symbol, unknown>;

/** A `debug` module stand-in: tracks its active set, what `save` was asked to persist, and what its default sink received. */
interface FakeDebug extends DebugModule {
	namespaces: string;
	saved: string[];
	written: unknown[][];
	readonly defaultLog: LogSink;
	save: (namespaces: string) => void;
}

function fakeDebug(initial = ''): FakeDebug {
	const written: unknown[][] = [];
	const defaultLog: LogSink = (...args) => { written.push(args); };
	return {
		namespaces: initial,
		saved: [],
		written,
		defaultLog,
		log: defaultLog,
		// Mirrors `debug`'s `common.js`: `enable` persists through `save`, `disable` is `enable('')`
		// returning what was active.
		enable(namespaces: string) {
			this.save(namespaces);
			this.namespaces = namespaces;
		},
		disable() {
			const previous = this.namespaces;
			this.enable('');
			return previous;
		},
		save(namespaces: string) {
			this.saved.push(namespaces);
		},
	};
}

function captureSink(): { log: LogSink; lines: unknown[][] } {
	const lines: unknown[][] = [];
	return { log: (...args) => { lines.push(args); }, lines };
}

describe('logger registry (enableOptimysticLogging)', () => {
	// The registry is process-wide by design, and db-core's own `src/logger.ts` has already registered
	// its real `debug` copy by the time this runs. Park that state and give every spec an empty one.
	let parked: unknown;
	before(() => { parked = holder[REGISTRY_KEY]; });
	beforeEach(() => { delete holder[REGISTRY_KEY]; });
	after(() => {
		disableOptimysticLogging();
		holder[REGISTRY_KEY] = parked;
	});

	describe('with no enable call', () => {
		it('registration touches nothing, so DEBUG= on Node behaves as before', () => {
			const copy = fakeDebug('myapp:*');
			registerDebugModule('db-core', copy);
			expect(copy.namespaces).to.equal('myapp:*');
			expect(copy.log).to.equal(copy.defaultLog);
			expect(copy.saved).to.deep.equal([]);
		});

		it('disable is a no-op, and safe to call twice', () => {
			const copy = fakeDebug('myapp:*');
			registerDebugModule('db-core', copy);
			disableOptimysticLogging();
			disableOptimysticLogging();
			expect(copy.namespaces).to.equal('myapp:*');
			expect(copy.log).to.equal(copy.defaultLog);
		});
	});

	describe('namespaces', () => {
		it('adds ours to each copy\'s existing set rather than replacing it', () => {
			const shared = fakeDebug('myapp:*');
			const empty = fakeDebug('');
			registerDebugModule('db-core', shared);
			registerDebugModule('db-p2p', empty);

			enableOptimysticLogging('optimystic:*', { log: captureSink().log });

			expect(shared.namespaces).to.equal('myapp:*,optimystic:*');
			// No leading comma when the copy had nothing on.
			expect(empty.namespaces).to.equal('optimystic:*');
		});

		it('a second call replaces our first contribution, not accumulates; the baseline is unchanged', () => {
			const copy = fakeDebug('myapp:*');
			registerDebugModule('db-core', copy);
			const sink = captureSink();

			enableOptimysticLogging('optimystic:*', { log: sink.log });
			const report = enableOptimysticLogging('optimystic:db-core:cache', { log: sink.log });

			expect(copy.namespaces).to.equal('myapp:*,optimystic:db-core:cache');
			expect(report.namespaces).to.equal('optimystic:db-core:cache');

			disableOptimysticLogging();
			expect(copy.namespaces).to.equal('myapp:*');
		});

		it('disable restores every copy to what it had before the first enable', () => {
			const a = fakeDebug('myapp:*');
			const b = fakeDebug('');
			registerDebugModule('db-core', a);
			registerDebugModule('db-p2p', b);

			enableOptimysticLogging('optimystic:*', { log: captureSink().log });
			disableOptimysticLogging();

			expect(a.namespaces).to.equal('myapp:*');
			expect(b.namespaces).to.equal('');
		});

		it('comma-joins an array, trimming each entry and dropping empty ones', () => {
			const copy = fakeDebug('');
			registerDebugModule('db-core', copy);

			const report = enableOptimysticLogging(['  optimystic:db-core:* ', '', 'optimystic:db-p2p:cluster*'], { log: captureSink().log });

			expect(report.namespaces).to.equal('optimystic:db-core:*,optimystic:db-p2p:cluster*');
			expect(copy.namespaces).to.equal('optimystic:db-core:*,optimystic:db-p2p:cluster*');
		});

		it('treats an empty list as enabling nothing of ours, not as an error', () => {
			const copy = fakeDebug('myapp:*');
			registerDebugModule('db-core', copy);
			const sink = captureSink();

			enableOptimysticLogging('optimystic:*', { log: sink.log });
			for (const empty of ['', '  ', [], ['', ' ']] as const) {
				const report = enableOptimysticLogging(empty, { log: sink.log });
				expect(report.namespaces, JSON.stringify(empty)).to.equal('');
				expect(copy.namespaces, JSON.stringify(empty)).to.equal('myapp:*');
			}
			// Still confirmed — every call writes its line, including one that enabled nothing.
			expect(sink.lines.length).to.equal(5);
			expect(String(sink.lines[4]![0])).to.include('nothing (empty namespace list)');
		});

		it('never persists: debug\'s save hook (process.env.DEBUG / localStorage.debug) is not called', () => {
			const copy = fakeDebug('myapp:*');
			registerDebugModule('db-core', copy);

			enableOptimysticLogging('optimystic:*', { log: captureSink().log });
			registerDebugModule('late', fakeDebug());
			disableOptimysticLogging();

			expect(copy.saved).to.deep.equal([]);
			// ...and the hook itself is put back, so the app's own `debug.enable` still persists.
			copy.enable('myapp:x');
			expect(copy.saved).to.deep.equal(['myapp:x']);
		});
	});

	describe('copies that register after the enable call', () => {
		it('get our namespaces and sink at once, with their own baseline captured first', () => {
			const sink = captureSink();
			enableOptimysticLogging('optimystic:*', { log: sink.log });

			const late = fakeDebug('late:*');
			registerDebugModule('db-p2p-storage-rn', late);

			expect(late.namespaces).to.equal('late:*,optimystic:*');
			expect(late.log).to.equal(sink.log);

			disableOptimysticLogging();
			expect(late.namespaces).to.equal('late:*');
			expect(late.log).to.equal(late.defaultLog);
		});

		it('are applied silently — no second confirmation line', () => {
			const sink = captureSink();
			enableOptimysticLogging('optimystic:*', { log: sink.log });
			registerDebugModule('late', fakeDebug());
			expect(sink.lines.length).to.equal(1);
		});

		it('are left alone once logging has been disabled again', () => {
			enableOptimysticLogging('optimystic:*', { log: captureSink().log });
			disableOptimysticLogging();

			const late = fakeDebug('late:*');
			registerDebugModule('late', late);
			expect(late.namespaces).to.equal('late:*');
			expect(late.log).to.equal(late.defaultLog);
		});
	});

	describe('deduplication by module identity', () => {
		it('one copy registered by several owners is one entry listing all of them', () => {
			const shared = fakeDebug();
			registerDebugModule('db-core', shared);
			registerDebugModule('db-p2p', shared);
			registerDebugModule('db-p2p', shared);

			const report = enableOptimysticLogging('optimystic:*', { log: captureSink().log });

			expect(report.copies).to.deep.equal([['db-core', 'db-p2p']]);
			// Applied once — a double application would read `optimystic:*,optimystic:*`.
			expect(shared.namespaces).to.equal('optimystic:*');
		});

		it('distinct copies are distinct entries, in registration order', () => {
			registerDebugModule('db-core', fakeDebug());
			registerDebugModule('db-p2p', fakeDebug());
			registerDebugModule('db-p2p-storage-rn', fakeDebug());

			const report = enableOptimysticLogging('optimystic:*', { log: captureSink().log });

			expect(report.copies).to.deep.equal([['db-core'], ['db-p2p'], ['db-p2p-storage-rn']]);
		});
	});

	describe('the log option', () => {
		it('is installed as every copy\'s sink and restored on disable', () => {
			const a = fakeDebug();
			const b = fakeDebug();
			registerDebugModule('db-core', a);
			registerDebugModule('db-p2p', b);
			const sink = captureSink();

			enableOptimysticLogging('optimystic:*', { log: sink.log });
			expect(a.log).to.equal(sink.log);
			expect(b.log).to.equal(sink.log);

			disableOptimysticLogging();
			expect(a.log).to.equal(a.defaultLog);
			expect(b.log).to.equal(b.defaultLog);
		});

		it('a later call without it puts each copy back on its original sink', () => {
			const copy = fakeDebug();
			registerDebugModule('db-core', copy);

			enableOptimysticLogging('optimystic:*', { log: captureSink().log });
			enableOptimysticLogging('optimystic:*');

			expect(copy.log).to.equal(copy.defaultLog);
		});
	});

	describe('the confirmation line', () => {
		it('is written once per call, through options.log when given', () => {
			const copy = fakeDebug();
			registerDebugModule('db-core', copy);
			const sink = captureSink();

			enableOptimysticLogging('optimystic:*', { log: sink.log });

			expect(sink.lines.length).to.equal(1);
			expect(copy.written).to.deep.equal([]);
		});

		it('otherwise goes through the first registered copy\'s own sink', () => {
			const first = fakeDebug();
			const second = fakeDebug();
			registerDebugModule('db-core', first);
			registerDebugModule('db-p2p', second);

			enableOptimysticLogging('optimystic:*');

			expect(first.written.length).to.equal(1);
			expect(second.written).to.deep.equal([]);
		});

		it('names the namespaces, the copy count and which packages share each copy, and points at libp2p', () => {
			const shared = fakeDebug();
			registerDebugModule('db-core', shared);
			registerDebugModule('db-p2p', shared);
			registerDebugModule('db-p2p-storage-rn', fakeDebug());
			const sink = captureSink();

			enableOptimysticLogging('optimystic:*', { log: sink.log });

			expect(sink.lines).to.deep.equal([[
				'optimystic logging on: "optimystic:*" across 2 debug copies [db-core, db-p2p | db-p2p-storage-rn]; '
				+ 'libp2p:* is separate, see docs/debugging.md'
			]]);
		});

		it('says "copy" for a single copy', () => {
			registerDebugModule('db-core', fakeDebug());
			const sink = captureSink();
			enableOptimysticLogging('optimystic:*', { log: sink.log });
			expect(String(sink.lines[0]![0])).to.include('across 1 debug copy [db-core]');
		});

		it('falls back to console.log when nothing has registered yet, and says the namespaces apply as packages load', () => {
			const lines: unknown[][] = [];
			const originalConsoleLog = console.log;
			console.log = (...args: unknown[]) => { lines.push(args); };
			let copies: string[][];
			try {
				copies = enableOptimysticLogging('optimystic:*').copies;
			} finally {
				console.log = originalConsoleLog;
			}

			expect(copies).to.deep.equal([]);
			expect(lines.length).to.equal(1);
			expect(String(lines[0]![0])).to.include('no debug copies registered yet');
			expect(String(lines[0]![0])).to.include('as Optimystic packages load');
		});

		it('with nothing registered, still prefers options.log over console.log', () => {
			const sink = captureSink();
			enableOptimysticLogging('optimystic:*', { log: sink.log });
			expect(sink.lines.length).to.equal(1);
		});
	});

	describe('process-wide state', () => {
		it('lives on globalThis under Symbol.for, not in module scope', () => {
			registerDebugModule('db-core', fakeDebug());
			const state = holder[REGISTRY_KEY] as { entries: unknown[] } | undefined;
			expect(state?.entries.length).to.equal(1);
		});

		/**
		 * The case the globalThis key exists for: a bundle with two copies of db-core. A second module
		 * instance of this same file (a distinct URL, so Node evaluates it again) must see the entries
		 * the first one registered, and drive them.
		 */
		it('is shared by a second instance of the module', async () => {
			const copy = fakeDebug();
			registerDebugModule('db-core', copy);

			// Through a variable: TypeScript cannot resolve a specifier carrying a query string.
			const specifier = '../src/logger-registry.js?second-db-core-copy';
			const second = await import(specifier) as typeof import('../src/logger-registry.js');
			expect(second.enableOptimysticLogging, 'the query-string import must be a distinct module instance').to.not.equal(enableOptimysticLogging);

			const report = second.enableOptimysticLogging('optimystic:*', { log: captureSink().log });
			expect(report.copies).to.deep.equal([['db-core']]);
			expect(copy.namespaces).to.equal('optimystic:*');

			disableOptimysticLogging();
			expect(copy.namespaces).to.equal('');
		});
	});
});
