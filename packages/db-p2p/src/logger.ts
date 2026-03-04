import debug from 'debug'

const BASE_NAMESPACE = 'optimystic:db-p2p'

export function createLogger(subNamespace: string): debug.Debugger {
	return debug(`${BASE_NAMESPACE}:${subNamespace}`)
}

export const verbose = typeof process !== 'undefined'
	&& (process.env.OPTIMYSTIC_VERBOSE === '1' || process.env.OPTIMYSTIC_VERBOSE === 'true');
