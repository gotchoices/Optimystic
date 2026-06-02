/**
 * Shared topology helpers for the slow circuit-relay / DCUtR integration specs
 * (`circuit-relay-long-lived.spec.ts`, `dcutr-direct-upgrade.spec.ts`).
 *
 * Each helper spins a real libp2p node (relay or service peer) via
 * `createLibp2pNode` and/or polls multiaddr / connection state. They are only
 * used by the `RUN_LONG_TESTS`-gated specs, never by the default unit suite.
 *
 * The `host` parameter exists so the same helpers can drive both the loopback
 * smoke topology (`127.0.0.1`, the default) and a real hole-punch topology where
 * nodes must bind a non-private routable address — `@libp2p/dcutr` filters out
 * private/loopback candidate addresses (`isPublicAndDialable`) and will never
 * upgrade a relayed connection over loopback. See `dcutr-direct-upgrade.spec.ts`.
 */
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import { webSockets } from '@libp2p/websockets';
import { tcp } from '@libp2p/tcp';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { createLibp2pNode, type Libp2pTransports } from '../../src/libp2p-node.js';

/** Default loopback bind host. Override with a non-private IP for real hole-punch runs. */
export const DEFAULT_HOST = '127.0.0.1';

/** Single-peer cluster scaffold shared by every node these specs spawn. */
const CLUSTER_SCAFFOLD = {
	clusterSize: 1,
	clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
	arachnode: { enableRingZulu: false }
} as const;

export interface SpawnRelayOpts {
	/** Bind host for the relay's TCP + WS listeners. Defaults to loopback. */
	host?: string;
	/**
	 * Forwarded to `circuitRelayServer` via `relayServerInit.reservations`.
	 * Defaults to `false` — lifts the default 128 KiB / 2 min per-circuit cap,
	 * the trusted-cluster posture (see `libp2p-node-base.ts`). The long-lived
	 * control case passes `true` to prove the cap resets sustained traffic.
	 */
	applyDefaultLimit?: boolean;
}

/** Relay node: TCP + WS + circuit-relay server. */
export async function spawnRelayNode(network: string, opts: SpawnRelayOpts = {}): Promise<Libp2p> {
	const host = opts.host ?? DEFAULT_HOST;
	const transports: Libp2pTransports = [tcp(), webSockets(), circuitRelayTransport()];
	return await createLibp2pNode({
		port: 0,
		wsPort: 0,
		networkName: network,
		bootstrapNodes: [],
		relay: true,
		relayServerInit: {
			reservations: { applyDefaultLimit: opts.applyDefaultLimit ?? false }
		},
		transports,
		listenAddrs: [`/ip4/${host}/tcp/0`, `/ip4/${host}/tcp/0/ws`],
		...CLUSTER_SCAFFOLD
	});
}

export interface SpawnTcpPeerOpts {
	/** Bind host for the peer's direct TCP listener. Defaults to loopback. */
	host?: string;
	/** Also listen on `<relayAddr>/p2p-circuit` so the peer is reachable via the relay. */
	listenOnCircuit?: boolean;
}

/**
 * A NAT'd service peer: TCP + circuit. It reaches the relay over the relay's
 * *TCP* address (so the peer needs no WS transport) and shares TCP as the common
 * direct transport DCUtR upgrades the relayed connection onto.
 */
export async function spawnTcpServicePeer(
	network: string,
	relayAddr: Multiaddr,
	opts: SpawnTcpPeerOpts = {}
): Promise<Libp2p> {
	const host = opts.host ?? DEFAULT_HOST;
	const transports: Libp2pTransports = [tcp(), circuitRelayTransport()];
	const listenAddrs = [`/ip4/${host}/tcp/0`];
	if (opts.listenOnCircuit) {
		listenAddrs.push(`${relayAddr.toString()}/p2p-circuit`);
	}
	return await createLibp2pNode({
		port: 0,
		networkName: network,
		bootstrapNodes: [relayAddr.toString()],
		relay: false,
		transports,
		listenAddrs,
		...CLUSTER_SCAFFOLD
	});
}

/** A plain TCP multiaddr on the node — has `/tcp/` + `/p2p/`, but not `/ws` or `/p2p-circuit`. */
export function pickRelayTcpAddr(node: Libp2p): Multiaddr {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const tcpAddr = addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/') && !a.includes('/ws') && !a.includes('/p2p-circuit'));
	if (!tcpAddr) {
		throw new Error(`No plain TCP multiaddr on node; have: ${addrs.join(', ')}`);
	}
	return multiaddr(tcpAddr);
}

/** A WebSocket multiaddr on the node. */
export function pickRelayWsAddr(node: Libp2p): Multiaddr {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const ws = addrs.find(a => a.includes('/ws/p2p/') || a.endsWith('/ws'));
	if (!ws) {
		throw new Error(`No /ws multiaddr on node; have: ${addrs.join(', ')}`);
	}
	return multiaddr(ws);
}

/** Wait until `node` publishes a `/p2p-circuit` listen multiaddr (relay reservation accepted). */
export async function waitForCircuitListen(node: Libp2p, timeoutMs: number): Promise<Multiaddr> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const circuit = node.getMultiaddrs().map(a => a.toString()).find(a => a.includes('/p2p-circuit/'));
		if (circuit) return multiaddr(circuit);
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error(`Peer never published a /p2p-circuit multiaddr (have: ${node.getMultiaddrs().map(a => a.toString()).join(', ')})`);
}

/** True once a non-circuit (direct) connection to `peerId` exists. */
export function hasDirectConnection(node: Libp2p, peerId: PeerId): boolean {
	return node.getConnections(peerId).some(c => !c.remoteAddr.toString().includes('/p2p-circuit'));
}

/** Poll until a direct connection to `peerId` appears, or the timeout elapses. */
export async function waitForDirectConnection(node: Libp2p, peerId: PeerId, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (hasDirectConnection(node, peerId)) return true;
		await new Promise(r => setTimeout(r, 250));
	}
	return false;
}
