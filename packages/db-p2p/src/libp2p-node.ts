import type { Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
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
