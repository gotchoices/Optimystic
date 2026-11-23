import {
	createLibp2pNodeBase,
	type ClientNodeOptions,
	type Libp2pTransports,
	type NodeOptions,
	type ServingNodeOptions,
} from './libp2p-node-base.js';
import type { OptimysticClientNode, OptimysticNode } from './optimystic-node.js';

export type { ClientNodeOptions, Libp2pTransports, NodeOptions, ServingNodeOptions };

/**
 * React Native-friendly libp2p node factory.
 *
 * This entrypoint intentionally does not import Node-only transports (like `@libp2p/tcp`).
 * Callers must provide `options.transports` (and typically `options.listenAddrs`).
 *
 * The same three shapes as the Node entry: `servesBlocks: false` builds a client
 * ({@link OptimysticClientNode}), unset or `true` a node that stores blocks ({@link OptimysticNode}),
 * and a plain `NodeOptions` either.
 */
export function createLibp2pNode(options: ClientNodeOptions): Promise<OptimysticClientNode>;
export function createLibp2pNode(options: ServingNodeOptions): Promise<OptimysticNode>;
export function createLibp2pNode(options: NodeOptions): Promise<OptimysticNode | OptimysticClientNode>;
export async function createLibp2pNode(options: NodeOptions): Promise<OptimysticNode | OptimysticClientNode> {
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
