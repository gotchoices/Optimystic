import { pipe } from 'it-pipe';
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Startable, Logger, Stream, Connection, StreamHandler, PeerId } from '@libp2p/interface';
import type { ICluster, ClusterRecord } from '@optimystic/db-core';
import { encodePeers, type RedirectPayload } from '../repo/redirect.js';
import type { Uint8ArrayList } from 'uint8arraylist';

interface BaseComponents {
	logger: { forComponent: (name: string) => Logger },
	registrar: {
		handle: (protocol: string, handler: StreamHandler, options: any) => Promise<void>,
		unhandle: (protocol: string) => Promise<void>
	}
}

export interface ClusterServiceComponents extends BaseComponents {
	cluster: ICluster
	/**
	 * This node's own peer id, used to decide whether we are a member of a
	 * cluster record's peer set. When absent the service cannot scope membership
	 * and processes every update locally (no redirect).
	 */
	peerId?: PeerId
	/**
	 * Optional resolver for a peer's dialable multiaddrs, used as a fallback when
	 * a redirect target has no multiaddrs embedded in `record.peers`.
	 */
	getConnectionAddrs?: (peerId: PeerId) => string[]
}

export interface ClusterServiceInit {
	protocol?: string,
	protocolPrefix?: string,
	maxInboundStreams?: number,
	maxOutboundStreams?: number,
	logPrefix?: string,
	/**
	 * Responsibility K - the replica set size for determining cluster membership.
	 * When the cluster record's peer set is smaller than this, the mesh is treated
	 * as "small" and the update is processed locally regardless of membership. When
	 * the peer set is at least this size and we are not a member, the update is
	 * redirected to the responsible peers.
	 * Default: 1 (only members process; any larger non-member set redirects)
	 */
	responsibilityK?: number,
}

export function clusterService(init: ClusterServiceInit = {}): (components: ClusterServiceComponents) => ClusterService {
	return (components: ClusterServiceComponents) => new ClusterService(components, init);
}

/**
 * A libp2p service that handles cluster protocol messages
 */
export class ClusterService implements Startable {
	private readonly protocol: string;
	private readonly maxInboundStreams: number;
	private readonly maxOutboundStreams: number;
	private readonly log: Logger;
	private readonly cluster: ICluster;
	private readonly components: ClusterServiceComponents;
	private running: boolean;
	/** Responsibility K - small-mesh bypass threshold for redirect decisions */
	private readonly responsibilityK: number;

	constructor(components: ClusterServiceComponents, init: ClusterServiceInit = {}) {
		this.components = components;
		this.protocol = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0';
		this.maxInboundStreams = init.maxInboundStreams ?? 32;
		this.maxOutboundStreams = init.maxOutboundStreams ?? 64;
		this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:cluster');
		this.cluster = components.cluster;
		this.running = false;
		this.responsibilityK = init.responsibilityK ?? 1;
	}

	readonly [Symbol.toStringTag] = '@libp2p/cluster';

	private getSelfId(): PeerId | undefined {
		if (this.components.peerId) return this.components.peerId;
		return (this.components as any).libp2p?.peerId as PeerId | undefined;
	}

	private getPeerAddrs(id: string): string[] {
		let pid: PeerId;
		try {
			pid = peerIdFromString(id);
		} catch {
			return [];
		}
		if (this.components.getConnectionAddrs) return this.components.getConnectionAddrs(pid);
		const libp2p = (this.components as any).libp2p;
		if (!libp2p?.getConnections) return [];
		const conns: any[] = libp2p.getConnections(pid) ?? [];
		const addrs: string[] = [];
		for (const c of conns) {
			const addr = c.remoteAddr?.toString?.();
			if (addr) addrs.push(addr);
		}
		return addrs;
	}

	/**
	 * Decide whether this node should redirect a cluster update instead of
	 * participating in its consensus.
	 *
	 * Membership is scoped against `record.peers` — the authoritative set the
	 * coordinator already computed and embedded (it only ever dials peers in this
	 * set). Using it directly (rather than independently recomputing the cluster
	 * from the key) is regression-proof against the "empty promises" symptom: a
	 * peer the coordinator legitimately included is, by construction, present in
	 * `record.peers` and is therefore never redirected.
	 *
	 * Returns a {@link RedirectPayload} when this node is not responsible, or null
	 * when the update should be processed locally (we are a member, the mesh is too
	 * small to scope, or we lack the identity/peer set to make a decision).
	 */
	checkRedirect(record: ClusterRecord): RedirectPayload | null {
		const selfId = this.getSelfId();
		if (!selfId) return null;					// no identity → can't scope, process locally

		const peers = record.peers ?? {};
		const peerIds = Object.keys(peers);
		if (peerIds.length === 0) return null;		// nothing to scope against → process locally

		const selfStr = selfId.toString();
		const isMember = peerIds.includes(selfStr);
		const smallMesh = peerIds.length < this.responsibilityK;

		if (!smallMesh && !isMember) {
			const others = peerIds.filter(id => id !== selfStr);
			return encodePeers(others.map(id => {
				const recAddrs = peers[id]?.multiaddrs ?? [];
				const addrs = recAddrs.length > 0 ? recAddrs : this.getPeerAddrs(id);
				return { id, addrs };
			}));
		}

		return null;
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		await this.components.registrar.handle(this.protocol, this.handleIncomingStream.bind(this), {
			maxInboundStreams: this.maxInboundStreams,
			maxOutboundStreams: this.maxOutboundStreams
		});

		this.running = true;
	}

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		await this.components.registrar.unhandle(this.protocol);
		this.running = false;
	}

	private handleIncomingStream(stream: Stream, connection: Connection): void {
		const peerId = connection.remotePeer;

		const processStream = async function* (this: ClusterService, source: AsyncIterable<Uint8ArrayList>) {
			for await (const msg of source) {
				// Decode the message
				const decoded = new TextDecoder().decode(msg.subarray());
				const message = JSON.parse(decoded) as { operation: string; record: ClusterRecord };

				// Process the operation
				let response: any;
				if (message.operation === 'update') {
					// Scope consensus to responsible peers: redirect when we are not a
					// member of the record's authoritative peer set, otherwise process.
					const redirect = this.checkRedirect(message.record);
					response = redirect ?? await this.cluster.update(message.record);
				} else {
					throw new Error(`Unknown operation: ${message.operation}`);
				}

				// Encode and yield the response
				yield new TextEncoder().encode(JSON.stringify(response));
			}
		};

		void (async () => {
			try {
				const responses = pipe(
					stream,
					(source) => lpDecode(source),
					processStream.bind(this),
					(source) => lpEncode(source)
				);
				for await (const chunk of responses) {
					stream.send(chunk);
				}
				await stream.close();
			} catch (err) {
				this.log.error('error handling cluster protocol message from %p - %e', peerId, err);
				stream.abort(err instanceof Error ? err : new Error(String(err)));
			}
		})();
	}
}
