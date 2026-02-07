import type { Libp2p } from 'libp2p';
import {
	createLibp2pNodeBase,
	type Libp2pTransports,
	type NodeOptions,
	type RawStorageProvider,
} from './libp2p-node-base.js';

export type { Libp2pTransports, NodeOptions, RawStorageProvider };

/**
 * React Native-friendly libp2p node factory.
 *
 * This entrypoint intentionally does not import Node-only transports (like `@libp2p/tcp`).
 * Callers must provide `options.transports` (and typically `options.listenAddrs`).
 */
export async function createLibp2pNode(options: NodeOptions): Promise<Libp2p> {
	const transports = options.transports;
	if (!transports || transports.length === 0) {
		throw new Error(
			'createLibp2pNode (RN) requires options.transports. ' +
				'Provide an RN-compatible transport (e.g. WebSockets) and any required listenAddrs.'
		);
	}

	return await createLibp2pNodeBase(options, {
		listenAddrs: [],
		transports,
	});
}
