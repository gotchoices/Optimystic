import debug from 'debug';
import { registerDebugModule } from '@optimystic/db-core';

const BASE_NAMESPACE = 'optimystic:db-p2p-storage-web';

// So `enableOptimysticLogging` reaches this package's copy of `debug`, which may be no one else's.
registerDebugModule('db-p2p-storage-web', debug);

export function createLogger(subNamespace: string): debug.Debugger {
	return debug(`${BASE_NAMESPACE}:${subNamespace}`);
}
