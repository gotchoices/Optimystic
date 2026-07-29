import debug from 'debug';

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
	debug.enable(`optimystic:db-p2p:${namespace}`);
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

/** True when the captured log contains `tag` carrying a payload with `rev`. */
export const hasTagAtRev = (captured: unknown[][], tag: string, rev: number): boolean =>
	captured.some(args =>
		typeof args[0] === 'string' && args[0].includes(tag)
		&& (args[1] as { rev?: number } | undefined)?.rev === rev
	);
