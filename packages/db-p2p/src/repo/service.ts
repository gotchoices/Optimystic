import { pipe } from 'it-pipe'
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed'
import type { Startable, Logger, Stream, Connection, StreamHandler, PeerId, Libp2p } from '@libp2p/interface'
import type { IRepo, RepoMessage } from '@optimystic/db-core'
import { blockIdsForTransforms } from '@optimystic/db-core'
import { peersEqual } from '../peer-utils.js'
import { encodePeers, type RedirectPayload } from './redirect.js'
import { MAX_BLOCK_MESSAGE_BYTES } from '../protocol-limits.js'
import type { Uint8ArrayList } from 'uint8arraylist'
import { createLogger } from '../logger.js'

const debugLog = createLogger('repo-service')

// Define Components interface
interface BaseComponents {
	logger: { forComponent: (name: string) => Logger },
	registrar: {
		handle: (protocol: string, handler: StreamHandler, options: any) => Promise<void>
		unhandle: (protocol: string) => Promise<void>
	}
}

export interface NetworkManagerLike {
	getCluster(key: Uint8Array): Promise<PeerId[]>
}

export type RepoServiceComponents = BaseComponents & {
	repo: IRepo
	networkManager?: NetworkManagerLike
	peerId?: PeerId
	getConnectionAddrs?: (peerId: PeerId) => string[]
	/**
	 * Optional libp2p node. The production wiring injects the node post-construction
	 * via {@link RepoService.setLibp2p} (the `components.libp2p` proxy does not
	 * reliably resolve from inside a service at request time); this field is a
	 * best-effort fallback resolver used only when no node has been injected.
	 */
	libp2p?: Libp2p
}

export type RepoServiceInit = {
	protocol?: string,
	protocolPrefix?: string,
	maxInboundStreams?: number,
	maxOutboundStreams?: number,
	logPrefix?: string,
	kBucketSize?: number,
	/**
	 * Responsibility K - the replica set size for determining cluster membership.
	 * This is distinct from kBucketSize (DHT routing).
	 * When set, this determines how many peers (by XOR distance) are considered
	 * responsible for a key. If this node is not in the top responsibilityK peers,
	 * it will redirect requests to closer peers.
	 * Default: 1 (only the closest peer handles requests)
	 */
	responsibilityK?: number,
}

export function repoService(init: RepoServiceInit = {}): (components: RepoServiceComponents) => RepoService {
	return (components: RepoServiceComponents) => new RepoService(components, init);
}

/**
 * A libp2p service that handles repo protocol messages
 */
export class RepoService implements Startable {
	private readonly protocol: string
	private readonly maxInboundStreams: number
	private readonly maxOutboundStreams: number
	private readonly log: Logger
	private readonly repo: IRepo
	private readonly components: RepoServiceComponents
	private running: boolean
	/** Responsibility K - how many peers are responsible for a key (for redirect decisions) */
	private readonly responsibilityK: number
	/**
	 * The libp2p node, injected post-construction by the node wiring (see
	 * libp2p-node-base.ts, mirroring how `networkManager`/`fret` receive theirs).
	 * The libp2p `components.libp2p` proxy does NOT reliably resolve from inside a
	 * service at request time, so the redirect path resolves the network manager,
	 * self identity, and connection addrs through this explicitly-set reference.
	 */
	private libp2pRef: Libp2p | undefined

	constructor(components: RepoServiceComponents, init: RepoServiceInit = {}) {
		this.components = components
		const computed = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0'
		this.protocol = computed
		this.maxInboundStreams = init.maxInboundStreams ?? 32
		this.maxOutboundStreams = init.maxOutboundStreams ?? 64
		this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:repo-service')
		this.repo = components.repo
		this.running = false
		this.responsibilityK = init.responsibilityK ?? 1
	}

	readonly [Symbol.toStringTag] = '@libp2p/repo-service'

	/**
	 * Inject the running libp2p node. Called once post-construction by the node
	 * wiring so the redirect path can resolve the network manager / self id / addrs.
	 */
	setLibp2p(libp2p: Libp2p): void {
		this.libp2pRef = libp2p
	}

	/** Resolve the libp2p node: the injected ref first, then the (best-effort) components proxy. */
	private getLibp2p(): Libp2p | undefined {
		return this.libp2pRef ?? (this.components as any).libp2p
	}

	/**
	 * Start the service
	 */
	async start(): Promise<void> {
		if (this.running) {
			return
		}

		await this.components.registrar.handle(this.protocol, this.handleIncomingStream.bind(this), {
			maxInboundStreams: this.maxInboundStreams,
			maxOutboundStreams: this.maxOutboundStreams
		})

		this.running = true
	}

	/**
	 * Stop the service
	 */
	async stop(): Promise<void> {
		if (!this.running) {
			return
		}

		await this.components.registrar.unhandle(this.protocol)
		this.running = false
	}

	private getNetworkManager(): NetworkManagerLike | undefined {
		if (this.components.networkManager) return this.components.networkManager
		return (this.getLibp2p() as any)?.services?.networkManager as NetworkManagerLike | undefined
	}

	private getSelfId(): PeerId | undefined {
		if (this.components.peerId) return this.components.peerId
		return this.getLibp2p()?.peerId as PeerId | undefined
	}

	private getPeerAddrs(peerId: PeerId): string[] {
		if (this.components.getConnectionAddrs) return this.components.getConnectionAddrs(peerId)
		const libp2p = this.getLibp2p() as any
		if (!libp2p?.getConnections) return []
		const conns: any[] = libp2p.getConnections(peerId) ?? []
		const addrs: string[] = []
		for (const c of conns) {
			const addr = c.remoteAddr?.toString?.()
			if (addr) addrs.push(addr)
		}
		return addrs
	}

	/**
	 * Derive the redirect routing key and op name for a single operation.
	 *
	 * The key MUST be the block the corresponding handler actually coordinates and
	 * verifies responsibility on, so redirect routing stays consistent with where the
	 * op is executed:
	 *   - get    → blockIds[0]
	 *   - pend   → blockIdsForTransforms(transforms)[0]
	 *   - cancel → actionRef.blockIds[0]
	 *   - commit → blockIds[0]  (CoordinatorRepo.commit anchors consensus on
	 *     getClusterSize(blockIds[0]) / executeClusterTransaction(blockIds[0]) and guards
	 *     with verifyResponsibility(blockIds) — NOT tailId; for a per-block commit batch
	 *     whose blockIds[0] !== tailId, keying on tailId redirected the commit to the
	 *     collection tail's cluster, which then fails verifyResponsibility for the non-tail block.)
	 *
	 * Returns blockKey === undefined when the op carries no routable key (e.g. a cancel
	 * with an empty blockIds list), in which case the caller handles it locally without a
	 * redirect check.
	 */
	deriveBlockKey(operation: RepoMessage['operations'][number]): { blockKey: string | undefined, opName: string } {
		if ('get' in operation) {
			return { blockKey: operation.get.blockIds[0], opName: 'get' }
		}
		if ('pend' in operation) {
			return { blockKey: blockIdsForTransforms(operation.pend.transforms)[0], opName: 'pend' }
		}
		if ('cancel' in operation) {
			return { blockKey: operation.cancel.actionRef.blockIds[0], opName: 'cancel' }
		}
		if ('commit' in operation) {
			return { blockKey: operation.commit.blockIds[0], opName: 'commit' }
		}
		return { blockKey: undefined, opName: 'unknown' }
	}

	/**
	 * Check if this node should redirect the request for a given key.
	 * Returns a RedirectPayload if not responsible, null if should handle locally.
	 * Also attaches cluster info to the message for downstream use.
	 */
	async checkRedirect(blockKey: string, opName: string, message: RepoMessage): Promise<RedirectPayload | null> {
		const nm = this.getNetworkManager()
		if (!nm) return null

		// Pass the RAW encoded block-key bytes to getCluster. getCluster hashes
		// internally (hashKey == sha256), so the responsible-set coordinate becomes
		// hashKey(encode(blockKey)) — identical to how the cluster coordinator
		// derives it (ClusterCoordinator.getClusterForBlock → findCluster(encode(blockId))).
		// Pre-hashing here would double-hash (hashKey(sha256(encode(blockKey)))), placing
		// the cohort at an unrelated ring coordinate and redirecting requests the
		// coordinator legitimately routed to this peer.
		const key = new TextEncoder().encode(blockKey)
		const cluster = await nm.getCluster(key)
		;(message as any).cluster = cluster.map((p: PeerId) => p.toString?.() ?? String(p))

		const selfId = this.getSelfId()
		if (!selfId) return null

		const isMember = cluster.some((p: PeerId) => peersEqual(p, selfId))
		const smallMesh = cluster.length < this.responsibilityK

		if (!smallMesh && !isMember) {
			const peers = cluster.filter((p: PeerId) => !peersEqual(p, selfId))
			debugLog('redirect op=%s blockKey=%s cluster=%d', opName, blockKey, cluster.length)
			return encodePeers(peers.map((pid: PeerId) => ({
				id: pid.toString(),
				addrs: this.getPeerAddrs(pid)
			})))
		}

		return null
	}

	/**
	 * Handle incoming streams on the repo protocol
	 */
	private handleIncomingStream(stream: Stream, connection: Connection): void {
		const peerId = connection.remotePeer

		const processStream = async function* (this: RepoService, source: AsyncIterable<Uint8ArrayList>) {
			for await (const msg of source) {
				// Decode the message
				const decoded = new TextDecoder().decode(msg.subarray())
				const message = JSON.parse(decoded) as RepoMessage

				// Process each operation. Derive the redirect routing key once (keyed on the
				// block the handler actually coordinates), redirect-check it, then dispatch.
				const operation = message.operations[0]
				const { blockKey, opName } = this.deriveBlockKey(operation)
				const redirect = blockKey !== undefined
					? await this.checkRedirect(blockKey, opName, message)
					: null

				let response: any
				if (redirect) {
					response = redirect
				} else if ('get' in operation) {
					response = await this.repo.get(operation.get, { expiration: message.expiration, skipClusterFetch: true } as any)
				} else if ('pend' in operation) {
					response = await this.repo.pend(operation.pend, { expiration: message.expiration })
				} else if ('cancel' in operation) {
					response = await this.repo.cancel(operation.cancel.actionRef, { expiration: message.expiration })
				} else if ('commit' in operation) {
					response = await this.repo.commit(operation.commit, { expiration: message.expiration })
				}

				// Encode and yield the response
				yield new TextEncoder().encode(JSON.stringify(response))
				// One request per stream: every real RepoClient sends exactly one request
				// per dial (see ProtocolClient.processMessage), so complete the generator
				// after the first response. A second frame a peer queued is then never read
				// or parsed. Mirrors sync/block-transfer.
				return
			}
		}

		void (async () => {
			try {
				const responses = pipe(
					stream,
					(source) => lpDecode(source, { maxDataLength: MAX_BLOCK_MESSAGE_BYTES }),
					processStream.bind(this),
					(source) => lpEncode(source)
				)
				for await (const chunk of responses) {
					stream.send(chunk)
				}
				await stream.close()
			} catch (err) {
				this.log.error('error handling repo protocol message from %p - %e', peerId, err)
				stream.abort(err instanceof Error ? err : new Error(String(err)))
			}
		})()
	}
}
