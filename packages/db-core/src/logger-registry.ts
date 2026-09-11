/*
 * One switch for every `optimystic:*` log channel, whichever copy of `debug` it lives on.
 *
 * Why this exists. `debug` turns namespaces on only from `process.env.DEBUG` (Node) or
 * `localStorage.debug` (its browser build, which is the one Metro bundles). React Native has
 * neither, so every channel is silently off there — and an empty capture reads exactly like "that
 * code never ran". Calling `debug.enable(...)` from app code does not fix it reliably either: it
 * reaches only the copy of `debug` the caller resolved, and each Optimystic package may resolve its
 * own (this repo's install, `nmHoistingLimits: workspaces`, gives every package a separate copy).
 *
 * So each package's `src/logger.ts` registers the copy IT imported, and `enableOptimysticLogging`
 * drives all of them. Coverage follows from every package registering, not from how the install
 * happened to be laid out. `docs/debugging.md` § "Turning logging on" is the user-facing statement.
 *
 * This module imports nothing. It sits below every logger in the package, and
 * `test/barrel-import-cycle.spec.ts` holds registry modules to zero runtime imports.
 */

/** The slice of a `debug` module this registry drives. Structural, so db-core never type-imports a particular copy. */
export interface DebugModule {
	enable(namespaces: string): void;
	/** `debug` 4.x returns the namespaces that were active. */
	disable(): string;
	log: (...args: any[]) => any;
	/**
	 * `debug`'s persistence hook, which `enable` calls with every new set: it writes
	 * `process.env.DEBUG` on Node and `localStorage.debug` in the browser build. Suppressed around
	 * every call this registry makes — see `withoutPersisting`. Optional so a test double need not
	 * supply one, and because `@types/debug` does not declare it.
	 */
	save?: (namespaces: string) => void;
}

/** Where log lines go — the same shape as `debug`'s own `log` property. */
export type LogSink = (...args: unknown[]) => void;

export interface OptimysticLoggingOptions {
	/**
	 * Where log lines go. Default: leave each copy's own sink (stderr on Node; `console.debug` in the
	 * browser/RN build). Pass one when the platform hides that sink (e.g. a device log filtered above
	 * debug level) or to collect a capture in memory.
	 */
	log?: LogSink;
}

export interface OptimysticLoggingReport {
	/** The Optimystic contribution, comma-joined — empty when the call enabled nothing. */
	namespaces: string;
	/** One entry per distinct `debug` copy: the packages that registered it. */
	copies: string[][];
}

interface Entry {
	module: DebugModule;
	owners: string[];
	/** What this copy had enabled, and its sink, before our first touch. Unset while untouched. */
	original?: { namespaces: string; log: DebugModule['log'] };
}

interface Pending {
	namespaces: string;
	log?: LogSink;
}

/*
 * NOTE: the state lives on `globalThis`, not in module scope, so a bundle that ends up with two
 * copies of db-core still has ONE registry — a copy of a package that registered with the other
 * db-core would otherwise be unreachable. The cost: two DIFFERENT db-core versions in one bundle
 * share this object, so change its shape only additively.
 */
const REGISTRY_KEY = Symbol.for('@optimystic/logger-registry');

interface RegistryState {
	entries: Entry[];
	/** The last enable call's settings, applied to copies that register afterwards. Unset when off. */
	pending?: Pending;
}

function registry(): RegistryState {
	const holder = globalThis as unknown as Record<symbol, RegistryState | undefined>;
	return holder[REGISTRY_KEY] ??= { entries: [] };
}

/**
 * Run `fn` with the copy's `save` hook stubbed out, so what we enable changes this process only.
 *
 * Without this, on Node every `enable` would write `process.env.DEBUG` — and a copy of `debug` that
 * loads LATER reads that variable as its own starting set, so it would arrive with our namespaces
 * baked into what `disableOptimysticLogging` later treats as its baseline (they could never be
 * turned off on that copy). Capturing a baseline via `disable()` would also delete the user's
 * `DEBUG`. In a browser, it would persist our namespaces into `localStorage.debug`, leaving logging
 * on after a reload even without this call.
 */
function withoutPersisting(module: DebugModule, fn: () => void): void {
	const save = module.save;
	if (save) module.save = () => { };
	try {
		fn();
	} finally {
		if (save) module.save = save;
	}
}

/**
 * Bring one copy in line with `pending`: its baseline (captured on first touch) plus ours, and
 * `pending.log` or its original sink.
 *
 * NOTE: ours is appended, so a `-optimystic:…` skip already in the copy's baseline (say
 * `DEBUG='*,-optimystic:*'`) still wins — `debug` checks skips first. That is the user's explicit
 * exclusion, so it is left alone; if it ever confuses someone, have the confirmation line name the
 * conflicting skip rather than overriding it.
 *
 * NOTE: the baseline is captured once per enable/disable cycle, so an app that calls
 * `debug.enable(...)` on a shared copy while ours are on has that change overwritten by our next
 * enable or disable. Fine while apps set their channels once at start-up; if one ever toggles them
 * at run time, re-derive the baseline from the copy's live set minus our contribution instead.
 */
function apply(entry: Entry, pending: Pending): void {
	const module = entry.module;
	if (!entry.original) {
		let namespaces = '';
		withoutPersisting(module, () => { namespaces = module.disable(); });
		entry.original = { namespaces, log: module.log };
	}
	const combined = [entry.original.namespaces, pending.namespaces].filter(Boolean).join(',');
	withoutPersisting(module, () => module.enable(combined));
	module.log = pending.log ?? entry.original.log;
}

function restore(entry: Entry): void {
	const original = entry.original;
	if (!original) return;
	withoutPersisting(entry.module, () => entry.module.enable(original.namespaces));
	entry.module.log = original.log;
	entry.original = undefined;
}

/** Comma-join, trimming each entry and dropping empty ones. A string may already hold a list. */
function normalizeNamespaces(namespaces: string | readonly string[]): string {
	const parts = typeof namespaces === 'string' ? [namespaces] : namespaces;
	return parts
		.flatMap(part => part.split(','))
		.map(part => part.trim())
		.filter(Boolean)
		.join(',');
}

function confirmationLine(report: OptimysticLoggingReport): string {
	const what = report.namespaces ? `"${report.namespaces}"` : 'nothing (empty namespace list)';
	const trailer = 'libp2p:* is separate, see docs/debugging.md';
	if (report.copies.length === 0) {
		return `optimystic logging on: ${what}; no debug copies registered yet, namespaces will apply as Optimystic packages load; ${trailer}`;
	}
	const count = report.copies.length;
	const groups = report.copies.map(owners => owners.join(', ')).join(' | ');
	return `optimystic logging on: ${what} across ${count} debug ${count === 1 ? 'copy' : 'copies'} [${groups}]; ${trailer}`;
}

/**
 * Called once from each package's `src/logger.ts` at module load, with the `debug` module that file
 * imported. Idempotent per (owner, module); several owners sharing one copy are one entry.
 *
 * With no prior `enableOptimysticLogging` call this touches nothing, so `DEBUG=` on Node behaves
 * exactly as it always has. After one, the arriving copy gets the same namespaces and sink at once
 * (its own baseline captured first), silently — the enable call already confirmed.
 */
export function registerDebugModule(owner: string, module: DebugModule): void {
	const state = registry();
	const existing = state.entries.find(entry => entry.module === module);
	if (existing) {
		if (!existing.owners.includes(owner)) existing.owners.push(owner);
		return;
	}
	const entry: Entry = { module, owners: [owner] };
	state.entries.push(entry);
	if (state.pending) apply(entry, state.pending);
}

/**
 * Turn on the given namespaces on every registered `debug` copy, now and for copies that register
 * later — the way to enable Optimystic logging on any runtime, React Native included, without
 * environment variables.
 *
 * Adds to each copy's existing namespaces rather than replacing them, so an app's own channels
 * sharing a copy stay on. A second call replaces the first call's namespaces and `log`, and does not
 * accumulate. An empty list enables nothing of ours (and is not an error).
 *
 * Always writes one confirmation line — through `options.log` if given, else the first registered
 * copy's sink, else `console.log` — because silence is exactly what cannot be told apart from "the
 * code never ran". No line: this was not called, or the sink is swallowed. A line and no events: the
 * code did not run, or the filter does not match. Events: it works.
 */
export function enableOptimysticLogging(
	namespaces: string | readonly string[],
	options?: OptimysticLoggingOptions,
): OptimysticLoggingReport {
	const state = registry();
	const pending: Pending = { namespaces: normalizeNamespaces(namespaces), log: options?.log };
	state.pending = pending;
	for (const entry of state.entries) apply(entry, pending);

	const report: OptimysticLoggingReport = {
		namespaces: pending.namespaces,
		copies: state.entries.map(entry => [...entry.owners]),
	};
	const line = confirmationLine(report);
	const sink = options?.log ?? state.entries[0]?.module.log;
	if (sink) {
		sink(line);
	} else {
		// No Optimystic package has loaded yet, so there is no debug sink to write through — and the
		// confirmation line must never be skipped (see above).
		// eslint-disable-next-line no-console
		console.log(line);
	}
	return report;
}

/** Undo it: every copy goes back to what it had enabled before the first enable call, and its original sink. Safe to call when nothing is enabled. */
export function disableOptimysticLogging(): void {
	const state = registry();
	for (const entry of state.entries) restore(entry);
	state.pending = undefined;
}
