import debug from 'debug';
import { format } from 'node:util';

/**
 * Capture what a `createLogger(<name>)` namespace emits while `fn` runs, restoring the
 * caller's `debug` configuration afterwards. Returns the raw `debug` argument lists so
 * specs can assert on both the event tag (`args[0]`) and the structured payload (`args[1]`).
 *
 * Not a `.spec.ts` file on purpose — mocha's glob would otherwise load it as a suite.
 */
export const captureLog = async (namespace: string, fn: () => Promise<void>): Promise<unknown[][]> => {
	const captured: unknown[][] = [];
	const previousNamespaces = debug.disable();
	const previousLog = debug.log;
	// Matches both the bare namespace (no peer id known) and a peer-id-suffixed one
	// (`createLogger` appends `:<truncated-peer-id>` when an instance knows its peer id).
	debug.enable(`optimystic:db-p2p:${namespace},optimystic:db-p2p:${namespace}:*`);
	debug.log = (...args: unknown[]): void => { captured.push(args); };
	try {
		await fn();
	} finally {
		debug.log = previousLog;
		debug.disable();
		if (previousNamespaces) debug.enable(previousNamespaces);
	}
	return captured;
};

/** True when the captured log contains `tag`. */
export const hasTag = (captured: unknown[][], tag: string): boolean =>
	captured.some(args => typeof args[0] === 'string' && args[0].includes(tag));

/**
 * The fully substituted text of one captured line.
 *
 * `debug` resolves only its own formatters (`%o`, `%O`, `%j`) before calling the log sink and
 * leaves `%s`/`%d` for `console.log`'s own `util.format` to fill in downstream — so `args[0]`
 * still reads `addressless=%d` and the value sits in a later element. Asserting on a *value*
 * carried by a log line therefore has to go through this rather than through {@link hasTag},
 * which only ever sees the literal template.
 */
export const formatCaptured = (args: unknown[]): string => format(...args);

/** True when the captured log contains a line whose fully substituted text includes `text`. */
export const hasLine = (captured: unknown[][], text: string): boolean =>
	captured.some(args => formatCaptured(args).includes(text));

/** True when the captured log contains `tag` carrying a payload with `rev`. */
export const hasTagAtRev = (captured: unknown[][], tag: string, rev: number): boolean =>
	captured.some(args =>
		typeof args[0] === 'string' && args[0].includes(tag)
		&& (args[1] as { rev?: number } | undefined)?.rev === rev
	);
