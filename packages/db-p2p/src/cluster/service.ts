import { pipe } from 'it-pipe';
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed';
import { peerIdFromString } from '@libp2p/peer-id';
import type { Startable, Logger, Stream, Connection, StreamHandler, PeerId } from '@libp2p/interface';
import type { ICluster, ClusterRecord } from '@optimystic/db-core';
import { encodePeers, type RedirectPayload } from '../repo/redirect.js';
import { toClusterErrorEnvelope } from './cluster-error.js';
import { MAX_CONTROL_MESSAGE_BYTES } from '../protocol-limits.js';
import type { Uint8ArrayList } from 'uint8arraylist';
import { createInboundStreamAuthorization, type InboundStreamAuthorization, type InboundStreamAuthorizationInit } from '../inbound-authorization.js';

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
	/**
	 * Optional sink for dialable addresses carried by an inbound cluster record, so this
	 * node can later dial a cohort sibling it has never had a connection to. Omitted →
	 * no address learning (the pre-existing behavior).
	 */
	recordPeerAddresses?: (peerId: PeerId, multiaddrs: string[]) => void
}

export interface ClusterServiceInit extends InboundStreamAuthorizationInit {
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
	/** Optional embedder authorization gate; `undefined` (the default) means no check runs. */
	private readonly authorization: InboundStreamAuthorization | undefined;

	constructor(components: ClusterServiceComponents, init: ClusterServiceInit = {}) {
		this.components = components;
		this.protocol = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0';
		this.maxInboundStreams = init.maxInboundStreams ?? 32;
		this.maxOutboundStreams = init.maxOutboundStreams ?? 64;
		this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:cluster');
		this.cluster = components.cluster;
		this.running = false;
		this.responsibilityK = init.responsibilityK ?? 1;
		this.authorization = createInboundStreamAuthorization(init, this.protocol, (msg, ...args) => this.log.error(msg, ...args));
	}

	readonly [Symbol.toStringTag] = '@libp2p/cluster';

	/**
	 * Best-effort read of `components.libp2p`. When `components` is libp2p's own Proxy, the getter
	 * THROWS `MissingServiceError('libp2p not set')` for any key it does not hold — and `libp2p` is
	 * not a component — so the read itself must be guarded; `?.` and a following null check are both
	 * too late. Every fallback below is a convenience for embedders that register this service
	 * directly; the production wiring supplies `peerId`/`getConnectionAddrs` explicitly.
	 */
	private getLibp2p(): any {
		try {
			return (this.components as any).libp2p;
		} catch {
			return undefined;
		}
	}

	private getSelfId(): PeerId | undefined {
		if (this.components.peerId) return this.components.peerId;
		return this.getLibp2p()?.peerId as PeerId | undefined;
	}

	private getPeerAddrs(id: string): string[] {
		let pid: PeerId;
		try {
			pid = peerIdFromString(id);
		} catch {
			return [];
		}
		if (this.components.getConnectionAddrs) return this.components.getConnectionAddrs(pid);
		const libp2p = this.getLibp2p();
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

	/**
	 * Run a single decoded protocol message. An application-level throw
	 * (validation / signature / merge / consensus failure inside `cluster.update`)
	 * propagates to the caller, which turns it into a structured error envelope;
	 * a redirect or a successful {@link ClusterRecord} is returned as-is.
	 *
	 * Public for the same reason {@link checkRedirect} is: it is the whole wire-ingress decision
	 * for a cluster update, and a test that reconstructs it by hand stops proving anything about
	 * the real ordering (address learning before redirect before consensus).
	 */
	async processOperation(message: { operation: string; record: ClusterRecord }): Promise<unknown> {
		if (message.operation === 'update') {
			// Learn the cohort's addresses FIRST — before both the redirect decision and
			// local consensus, since either can go on to dial these same peers. libp2p only
			// tells us the addresses of peers we are directly connected to, so for a cohort
			// picked by key position this record is often the only place a relay-only
			// sibling's address ever reaches us.
			this.learnPeerAddresses(message.record);
			// Scope consensus to responsible peers: redirect when we are not a
			// member of the record's authoritative peer set, otherwise process.
			const redirect = this.checkRedirect(message.record);
			return redirect ?? await this.cluster.update(message.record);
		}
		throw new Error(`Unknown operation: ${message.operation}`);
	}

	/**
	 * Offer every address the record carries for its cohort members to the node's address
	 * book. Self and unparseable entries are dropped here; the remaining validation, the
	 * per-peer cap, and the trust boundary live in the sink (`peer-address-book.ts`).
	 */
	private learnPeerAddresses(record: ClusterRecord): void {
		const sink = this.components.recordPeerAddresses;
		if (!sink) return;
		const selfStr = this.getSelfId()?.toString();
		for (const [idStr, peer] of Object.entries(record.peers ?? {})) {
			const addrs = peer?.multiaddrs ?? [];
			if (addrs.length === 0 || idStr === selfStr) continue;
			let pid: PeerId;
			try {
				pid = peerIdFromString(idStr);
			} catch (err) {
				this.log.error('cluster record carried an unparseable peer id %s - %e', idStr, err);
				continue;
			}
			sink(pid, addrs);
		}
	}

	private handleIncomingStream(stream: Stream, connection?: Connection): void {
		const peerId = connection?.remotePeer;

		const processStream = async function* (this: ClusterService, source: AsyncIterable<Uint8ArrayList>) {
			for await (const msg of source) {
				// Decode the framing. A malformed/undecodable message is a transport
				// fault handled by the outer abort path, not an application error.
				const decoded = new TextDecoder().decode(msg.subarray());
				const message = JSON.parse(decoded) as { operation: string; record: ClusterRecord };

				// Application-level processing: surface any throw to the coordinator as
				// a structured error envelope (closing the stream normally) instead of
				// aborting, so the real cause — not an opaque StreamResetError — reaches
				// the coordinator, which already enables debug logging. The abort path
				// is reserved for genuinely unrecoverable framing/transport faults.
				let response: unknown;
				try {
					response = await this.processOperation(message);
				} catch (err) {
					this.log.error('error processing cluster %s from %p - %e', message.operation, peerId, err);
					response = toClusterErrorEnvelope(err);
				}

				// Encode and yield the response
				yield new TextEncoder().encode(JSON.stringify(response));
				// One request per stream: every real ClusterClient sends exactly one
				// request per dial (see ProtocolClient.processMessage), so complete the
				// generator after the first response. A second frame a peer queued is
				// then never read or parsed. Mirrors sync/block-transfer.
				return;
			}
		};

		void (async () => {
			try {
				// Authorization runs before ANY decoding or execution. Guarded on the field so a
				// node without a predicate keeps the original path untouched.
				if (this.authorization && await this.authorization.deny(stream, peerId?.toString())) return;
				const responses = pipe(
					stream,
					(source) => lpDecode(source, { maxDataLength: MAX_CONTROL_MESSAGE_BYTES }),
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
