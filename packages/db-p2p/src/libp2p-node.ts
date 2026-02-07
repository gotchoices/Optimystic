import type { Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import {
	createLibp2pNodeBase,
	type Libp2pTransports,
	type NodeOptions,
	type RawStorageProvider,
} from './libp2p-node-base.js';

export type { Libp2pTransports, NodeOptions, RawStorageProvider };

export async function createLibp2pNode(options: NodeOptions): Promise<Libp2p> {
	const port = options.port ?? 0;
	return await createLibp2pNodeBase(options, {
		listenAddrs: [`/ip4/0.0.0.0/tcp/${port}`],
		// Default node transports: TCP + relay transport so this node can dial through relays
		transports: [tcp(), circuitRelayTransport()],
	});
}

