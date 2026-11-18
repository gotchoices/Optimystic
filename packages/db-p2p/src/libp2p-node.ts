import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import {
	createLibp2pNodeBase,
	type ClientNodeOptions,
	type Libp2pTransports,
	type NodeOptions,
	type RawStorageProvider,
	type KVStoreProvider,
	type ServingNodeOptions,
} from './libp2p-node-base.js';
import type { OptimysticClientNode, OptimysticNode } from './optimystic-node.js';

export type { ClientNodeOptions, Libp2pTransports, NodeOptions, RawStorageProvider, KVStoreProvider, ServingNodeOptions };

/** A client node (`servesBlocks: false`): no repo, no block store; see {@link OptimysticClientNode}. */
export function createLibp2pNode(options: ClientNodeOptions): Promise<OptimysticClientNode>;
/** A node that stores blocks for its network — the default. */
export function createLibp2pNode(options: ServingNodeOptions): Promise<OptimysticNode>;
/** Either, as `options.servesBlocks` decides at run time; narrow the result on its `servesBlocks`. */
export function createLibp2pNode(options: NodeOptions): Promise<OptimysticNode | OptimysticClientNode>;
export async function createLibp2pNode(options: NodeOptions): Promise<OptimysticNode | OptimysticClientNode> {
	const port = options.port ?? 0;
	const wsHost = options.wsHost ?? '0.0.0.0';

	const defaultTransports: Libp2pTransports = [];
	const defaultListenAddrs: string[] = [];

	if (!options.disableTcp) {
		defaultTransports.push(tcp());
		defaultListenAddrs.push(`/ip4/0.0.0.0/tcp/${port}`);
	}
	if (options.wsPort !== undefined) {
		defaultTransports.push(webSockets());
		defaultListenAddrs.push(`/ip4/${wsHost}/tcp/${options.wsPort}/ws`);
	}
	// Always include the relay transport so this node can dial through relays
	defaultTransports.push(circuitRelayTransport());

	return await createLibp2pNodeBase(options, {
		listenAddrs: defaultListenAddrs,
		transports: defaultTransports,
	});
}
