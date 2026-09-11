import debug from 'debug'
import { registerDebugModule } from './logger-registry.js'

const BASE_NAMESPACE = 'optimystic:db-core'

// So `enableOptimysticLogging` reaches this package's copy of `debug`, which may be no one else's.
registerDebugModule('db-core', debug)

export function createLogger(subNamespace: string): debug.Debugger {
	return debug(`${BASE_NAMESPACE}:${subNamespace}`)
}

export const verbose = typeof process !== 'undefined'
	&& (process.env.OPTIMYSTIC_VERBOSE === '1' || process.env.OPTIMYSTIC_VERBOSE === 'true');
