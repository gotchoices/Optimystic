import debug from 'debug';

const BASE_NAMESPACE = 'optimystic:db-p2p-storage-rn';

export function createLogger(subNamespace: string): debug.Debugger {
	return debug(`${BASE_NAMESPACE}:${subNamespace}`);
}

