/**
 * Capture and parse the debug lines that answer "which collections did this write
 * carry, did every node mean the same index collection, and which revision did the
 * read that could not see the row descend?":
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
 * All three carry a `node=` field naming the node that emitted them, and every revision
 * they print is `<rev>@<actionId>` — the two fields that make a merged multi-node log
 * answer "which machine wrote this, and are these two machines looking at one collection
 * or at two separately-built copies of it?".
 *
 * See `docs/debugging.md` (§ quereus-plugin sub-namespaces) for how an operator
 * reads them. Specs use these helpers so a change that silently stops emitting
 * any one of them fails the suite.
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
	/** Collection id → the revision half of its entry in the line's `revs=` field: a
	 *  revision number, `none` (an invented collection with no committed revision), or
	 *  `unknown` (a double lacking the accessor). Kept as the raw string so
	 *  `none`/`unknown` stay distinguishable from revision 0. */
	rev: Map<string, string>;
	/** Collection id → the action-id half of the same `revs=` entry: the id of the action
	 *  that produced that revision, `none` (no action recorded at that revision — an
	 *  invented collection, or a revision slot the log gave to a checkpoint or invalidation
	 *  entry), or `unknown` (a double lacking the accessor). Absent for a line that
	 *  predates the field.
	 *
	 *  This is the half that is comparable ACROSS collections and across nodes: two nodes
	 *  at the same revision of the same collection id are one collection with one node
	 *  behind if the ids match, and two separately-built collections if they differ. */
	action: Map<string, string>;
	/** The `node=` field: which node emitted the line
	 *  (`CollectionFactory.nodeTag()`). `undefined` for a line that predates the field. */
	node: string | undefined;
}

/** One `revs=` pair, split by the rule `TransactionBridge.logCommitCollections` documents:
 *  `,` first (the caller), then the LAST `@`, then the LAST `:`.
 *
 *  Order matters and no regex shortcut is safe here. The id half is a URI path and
 *  routinely contains `:`; the ACTION id half does too — db-core stamps session-mode
 *  action ids as `tx:<hash>` — so splitting the whole pair on its last `:` tears the
 *  action id in half. `@` is unambiguous in the other direction: `revisionToken` escapes
 *  `@` inside an action id, so the last `@` in a pair is always the token's separator.
 *
 *  Returns `action: undefined` for a line that predates the field (no `@` at all), which
 *  is why this reads a build older than the action ids rather than failing on one. */
function parseRevPair(pair: string): { id: string; rev: string; action?: string } | undefined {
	const at = pair.lastIndexOf('@');
	const [left, action] = at < 0 ? [pair, undefined] : [pair.slice(0, at), pair.slice(at + 1)];
	const colon = left.lastIndexOf(':');
	if (colon < 0) return undefined;
	return { id: left.slice(0, colon), rev: left.slice(colon + 1), ...(action !== undefined ? { action } : {}) };
}

/** Parse every `commit:collections` line out of a capture.
 *
 * The line's halves are parsed independently, which is deliberate: the `<id>=<state>`
 * tokens are the ORIGINAL shape of this line and are matched by the original pattern, so
 * this parser still reads a build that predates revisions. The revisions arrive as one
 * `revs=<id>:<rev>@<actionId>,...` field ({@link parseRevPair} splits a pair) and the
 * emitting node as a trailing `node=`; a line without either simply yields an empty map /
 * `undefined` rather than failing to parse. */
export function commitTraces(lines: readonly string[]): CommitTrace[] {
	const traces: CommitTrace[] = [];
	for (const raw of lines) {
		const head = /commit:collections mode=(\S+) count=(\d+)(.*)$/.exec(plain(raw));
		if (!head) continue;
		const tail = head[3]!.trim();
		const state = new Map<string, string>();
		const rev = new Map<string, string>();
		const action = new Map<string, string>();
		// A trailing `+1ms`, and the `revs=`/`node=` fields themselves, are dropped by the shape filter.
		for (const token of tail.split(/\s+/)) {
			const entry = /^(\S+)=(staged|clean|unknown)$/.exec(token);
			if (entry) state.set(entry[1]!, entry[2]!);
		}
		const revs = /(?:^|\s)revs=(\S*)/.exec(tail);
		for (const pair of (revs?.[1] ?? '').split(',')) {
			const entry = parseRevPair(pair);
			if (!entry) continue;
			rev.set(entry.id, entry.rev);
			if (entry.action !== undefined) action.set(entry.id, entry.action);
		}
		const node = /(?:^|\s)node=(\S+)/.exec(tail);
		traces.push({
			mode: head[1]!, count: Number(head[2]), ids: [...state.keys()], state, rev, action,
			node: node?.[1],
		});
	}
	return traces;
}

/** A parsed `index:tree-open` line. */
export interface IndexOpenTrace {
	table: string;
	index: string;
	uri: string;
	collection: string;
	/** Which node resolved this index tree (`CollectionFactory.nodeTag()`). Two nodes
	 *  opening the same logical index otherwise emit identical lines. */
	node: string;
}

/** Parse every `index:tree-open` line out of a capture. */
export function indexOpenTraces(lines: readonly string[]): IndexOpenTrace[] {
	const traces: IndexOpenTrace[] = [];
	for (const raw of lines) {
		const m = /index:tree-open table=(\S+) index=(\S+) uri=(\S+) collection=(\S+) node=(\S+)/.exec(plain(raw));
		if (m) traces.push({ table: m[1]!, index: m[2]!, uri: m[3]!, collection: m[4]!, node: m[5]! });
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
	 *  Raw string so `none` stays distinguishable from revision 0. The emitted field is
	 *  `rev=<rev>@<actionId>`; this is the revision half only, {@link action} the other. */
	rev: string;
	/** The action that produced {@link rev} — this collection's lineage marker at that
	 *  revision — or `none` when the collection's bounded committed list holds no entry
	 *  there. Unlike a revision, this IS comparable across collections and across nodes:
	 *  same revision + same action id means one collection with one node behind, same
	 *  revision + different action ids means two separately-built collections. */
	action: string;
	/** The main table collection's committed revision at the same instant, same encoding. */
	mainRev: string;
	/** The action that produced {@link mainRev}; see {@link action}. */
	mainAction: string;
	/** Which node emitted the line (`CollectionFactory.nodeTag()`). */
	node: string;
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
 * unreadable.
 *
 * `rev=`/`main_rev=` are split into their revision and action-id halves on their only `@`
 * (`[^\s@]+` then `@(\S+)`): the revision half is a number or a fixed word, and
 * `revisionToken` escapes any `@` inside an action id, so there is exactly one. A spec
 * asserting on `rev` therefore keeps comparing bare revisions while the lineage marker is
 * available separately. */
export function indexSeekTraces(lines: readonly string[]): IndexSeekTrace[] {
	const traces: IndexSeekTrace[] = [];
	for (const raw of lines) {
		const m = /index:seek table=(\S+) index=(\S+) collection=(\S+) main=(\S+) arm=(\S+) rev=([^\s@]+)@(\S+) main_rev=([^\s@]+)@(\S+) seek=(\S*) matched=(\d+) node=(\S+)/
			.exec(plain(raw));
		if (m) {
			traces.push({
				table: m[1]!, index: m[2]!, collection: m[3]!, main: m[4]!, arm: m[5]!,
				rev: m[6]!, action: m[7]!, mainRev: m[8]!, mainAction: m[9]!,
				seek: m[10]!, matched: Number(m[11]), node: m[12]!,
			});
		}
	}
	return traces;
}

/** A collection's id is its URI with the `tree://` scheme stripped (CollectionFactory.parseCollectionId). */
export const collectionIdOf = (uri: string): string => uri.replace(/^tree:\/\//, '');
