import debug from 'debug'

const BASE_NAMESPACE = 'optimystic:fret'

export function createLogger(subNamespace: string): debug.Debugger {
	return debug(`${BASE_NAMESPACE}:${subNamespace}`)
}


