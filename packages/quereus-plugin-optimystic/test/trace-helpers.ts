/**
 * Capture and parse the two debug lines that answer "which collections did this
 * write carry, and did every node mean the same index collection?":
 *
 * - `commit:collections` (`optimystic:quereus-plugin:txn-bridge`) — one line per
 *   commit naming every collection that commit is about to carry.
 * - `index:tree-open` (`optimystic:quereus-plugin:module`) — one line per index
 *   tree opened, naming the URI it was derived from and the collection id it
 *   resolved to.
 * - `index:seek` (`optimystic:quereus-plugin:module`) — one line per index-driven
 *   scan, naming the revision the index and main collections were read at, whether
 *   the read was allowed to refresh, and how many index entries the seek produced.
 *
 * See `docs/debugging.md` (§ quereus-plugin sub-namespaces) for how an operator
 * reads them. Specs use these helpers so a change that silently stops emitting
 * either line fails the suite.
 *
 * Not a `.spec.ts` file on purpose — mocha's glob would otherwise load it as a suite.
 */

import debugFactory from 'debug';
import { format } from 'node:util';

/**
 * Run `body` with the plugin's debug namespaces on, returning every line the
 * plugin emitted while it ran.
 *
 * `debug` is an external dependency of this package (tsup leaves `dependencies`
 * unbundled), so the instance imported here is the SAME one `src/logger.ts`
 * builds its loggers from — `enable()` therefore reaches loggers constructed at
 * dist-import time, and replacing `debugFactory.log` intercepts them before they
 * reach stderr. `log` is the fallback sink every instance uses
 * (`self.log || createDebug.log`) and it receives the RAW printf args, so the
 * `%s`/`%d` substitution node's default sink does via `util.format` is redone here.
 *
 * NOTE: this mutates process-global `debug` state (namespaces + sink) for the
 * duration and restores it in a `finally`. Safe while mocha runs this package's
 * suites serially (no `--parallel` in package.json's test script, no `parallel`
 * in .mocharc.json); if this package ever adopts a parallel runner, concurrent
 * captures would steal each other's lines and this needs a per-run sink instead.
 */
export async function captureTrace(body: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const previousNamespaces = debugFactory.disable();
	const previousLog = debugFactory.log;
	debugFactory.log = (...args: unknown[]) => { lines.push(format(...args)); };
	debugFactory.enable('optimystic:quereus-plugin:*');
	try {
		await body();
	} finally {
		debugFactory.log = previousLog;
		debugFactory.enable(previousNamespaces);
	}
	return lines;
}

/**
 * Strip ANSI colour codes so parsing does not depend on whether stderr is a TTY.
 *
 * `debug`'s node sink colourises the namespace prefix and pushes a coloured
 * `+1ms` suffix, both only when it believes stderr is a terminal.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\[[0-9;]*m`, 'g');
export const plain = (line: string): string => line.replace(ANSI, '');

/** A parsed `commit:collections` line. */
export interface CommitTrace {
	/** `legacy` (direct per-tree sync sweep) or `session` (distributed consensus). */
	mode: string;
	/** The `count=` field as emitted — assert it against `ids.length` so a truncated list is caught. */
	count: number;
	ids: string[];
	/** Collection id → `staged` | `clean` | `unknown`. */
	state: Map<string, string>;
	/** Collection id → its entry in the line's trailing `revs=` field: a revision number,
	 *  `none` (an invented collection with no committed revision), or `unknown` (a double
	 *  lacking the accessor). Kept as the raw string so `none`/`unknown` stay
	 *  distinguishable from revision 0. */
	rev: Map<string, string>;
}

/** Parse every `commit:collections` line out of a capture.
 *
 * The line has two halves and they are parsed independently, which is deliberate: the
 * `<id>=<state>` tokens are the ORIGINAL shape of this line and are matched by the
 * original pattern, so this parser still reads a build that predates revisions. The
 * revisions arrive as one trailing `revs=<id>:<rev>,...` field; a line without it simply
 * yields an empty `rev` map rather than failing to parse. Each pair splits on its LAST
 * `:` because an id may contain colons while a revision never does. */
export function commitTraces(lines: readonly string[]): CommitTrace[] {
	const traces: CommitTrace[] = [];
	for (const raw of lines) {
		const head = /commit:collections mode=(\S+) count=(\d+)(.*)$/.exec(plain(raw));
		if (!head) continue;
		const tail = head[3]!.trim();
		const state = new Map<string, string>();
		const rev = new Map<string, string>();
		// A trailing `+1ms`, and the `revs=` field itself, are dropped by the shape filter.
		for (const token of tail.split(/\s+/)) {
			const entry = /^(\S+)=(staged|clean|unknown)$/.exec(token);
			if (entry) state.set(entry[1]!, entry[2]!);
		}
		const revs = /(?:^|\s)revs=(\S*)/.exec(tail);
		for (const pair of (revs?.[1] ?? '').split(',')) {
			const entry = /^(.*):(\d+|none|unknown)$/.exec(pair);
			if (entry) rev.set(entry[1]!, entry[2]!);
		}
		traces.push({ mode: head[1]!, count: Number(head[2]), ids: [...state.keys()], state, rev });
	}
	return traces;
}

/** A parsed `index:tree-open` line. */
export interface IndexOpenTrace { table: string; index: string; uri: string; collection: string }

/** Parse every `index:tree-open` line out of a capture. */
export function indexOpenTraces(lines: readonly string[]): IndexOpenTrace[] {
	const traces: IndexOpenTrace[] = [];
	for (const raw of lines) {
		const m = /index:tree-open table=(\S+) index=(\S+) uri=(\S+) collection=(\S+)/.exec(plain(raw));
		if (m) traces.push({ table: m[1]!, index: m[2]!, uri: m[3]!, collection: m[4]! });
	}
	return traces;
}

/** A parsed `index:seek` line — one per index-driven scan. */
export interface IndexSeekTrace {
	table: string;
	index: string;
	/** The index collection's id — the same string `index:tree-open` and `commit:collections` print. */
	collection: string;
	/** The main table collection's id, so one line names BOTH collections the scan read. */
	main: string;
	/** `committed` (pinned pre-transaction view, never refreshes) or `live` (refreshed first). */
	arm: string;
	/** The index collection's committed revision, or `none` when it has never adopted one.
	 *  Raw string so `none` stays distinguishable from revision 0. */
	rev: string;
	/** The main table collection's committed revision at the same instant, same encoding. */
	mainRev: string;
	/** The framed seek key, percent-escaped by the emitter. `''` is the whole-index prefix;
	 *  `unset` means the scan returned before framing a key. Compare between nodes for
	 *  equality only — decoding it yields raw framing bytes, not the SQL value. */
	seek: string;
	/** Index entries the seek produced, counted before the row fetch. A floor: an
	 *  abandoned iteration reports what it had produced when it stopped. */
	matched: number;
}

/** Parse every `index:seek` line out of a capture.
 *
 * `seek=` is matched with `\S*` rather than `\S+` because the whole-index prefix frames
 * to the empty string, and an empty `seek=` must parse rather than making the whole line
 * unreadable. */
export function indexSeekTraces(lines: readonly string[]): IndexSeekTrace[] {
	const traces: IndexSeekTrace[] = [];
	for (const raw of lines) {
		const m = /index:seek table=(\S+) index=(\S+) collection=(\S+) main=(\S+) arm=(\S+) rev=(\S+) main_rev=(\S+) seek=(\S*) matched=(\d+)/
			.exec(plain(raw));
		if (m) {
			traces.push({
				table: m[1]!, index: m[2]!, collection: m[3]!, main: m[4]!, arm: m[5]!,
				rev: m[6]!, mainRev: m[7]!, seek: m[8]!, matched: Number(m[9]),
			});
		}
	}
	return traces;
}

/** A collection's id is its URI with the `tree://` scheme stripped (CollectionFactory.parseCollectionId). */
export const collectionIdOf = (uri: string): string => uri.replace(/^tree:\/\//, '');
