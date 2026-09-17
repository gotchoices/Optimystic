import debug from 'debug'
import { format } from 'node:util'

/** Capture what one `debug` namespace emits while `fn` runs, fully substituted (`debug` leaves
 *  `%s`/`%d` for the downstream sink, so the raw args are not the text). Whatever namespaces were
 *  enabled before are restored afterwards, whether or not `fn` throws. */
export async function captureLog(namespace: string, fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = []
	const previousNamespaces = debug.disable()
	const previousLog = debug.log
	debug.enable(namespace)
	debug.log = (...args: unknown[]): void => { lines.push(format(...args)) }
	try {
		await fn()
	} finally {
		debug.log = previousLog
		debug.disable()
		if (previousNamespaces) debug.enable(previousNamespaces)
	}
	return lines
}

/** {@link captureLog} for the `db-core:collection` namespace — where every `collection:*`
 *  diagnostic line is emitted. */
export const captureCollectionLog = (fn: () => Promise<void>): Promise<string[]> =>
	captureLog('optimystic:db-core:collection', fn)
