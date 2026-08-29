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
import { publishableAddrsForPeer, type AddressLog, type DirectionalConnection } from '../peer-address-book.js'
import { createInboundStreamAuthorization, type InboundStreamAuthorization, type InboundStreamAuthorizationInit } from '../inbound-authorization.js'
import { registerProtocolHandler } from '../network/register-protocol-handler.js'

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
	/**
	 * Optional resolver for the addresses this node may publish for a redirect target. Async
	 * because the answer includes the peer's own advertised addresses, which live in the
	 * peerStore — see `publishableAddrsForPeer`. A synchronous `string[]` is still accepted so an
	 * embedder's connections-only stub keeps working.
	 */
	getConnectionAddrs?: (peerId: PeerId) => string[] | Promise<string[]>
	/**
	 * Optional libp2p node. The production wiring injects the node post-construction
	 * via {@link RepoService.setLibp2p} (the `components.libp2p` proxy does not
	 * reliably resolve from inside a service at request time); this field is a
	 * best-effort fallback resolver used only when no node has been injected.
	 */
	libp2p?: Libp2p
}

export type RepoServiceInit = InboundStreamAuthorizationInit & {
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
	/** Optional embedder authorization gate; `undefined` (the default) means no check runs. */
	private readonly authorization: InboundStreamAuthorization | undefined
	/**
	 * Sink for this service's `peer-address-book:*` lines — same reasoning as `ClusterService`'s:
	 * `this.log.error` would strand them under `db-p2p:repo-service:error`, outside the
	 * `optimystic:db-p2p:*` tree every other address-book line lives in.
	 */
	private readonly addressLog: AddressLog

	constructor(components: RepoServiceComponents, init: RepoServiceInit = {}) {
		this.components = components
		const computed = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0'
		this.protocol = computed
		this.maxInboundStreams = init.maxInboundStreams ?? 32
		this.maxOutboundStreams = init.maxOutboundStreams ?? 64
		this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:repo-service')
		this.addressLog = createLogger('peer-address-book', components.peerId?.toString())
		this.repo = components.repo
		this.running = false
		this.responsibilityK = init.responsibilityK ?? 1
		this.authorization = createInboundStreamAuthorization(init, this.protocol, (msg, ...args) => this.log.error(msg, ...args))
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

		await registerProtocolHandler(this.components.registrar, this.protocol, this.handleIncomingStream.bind(this), {
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

	/**
	 * The addresses this node may publish for `peerId` in a redirect payload.
	 *
	 * This fallback is the PRODUCTION source for the repo service: `libp2p-node-base` injects no
	 * `getConnectionAddrs` here (the node arrives later, via `setLibp2p`), and unlike a cluster
	 * redirect there is no record whose embedded multiaddrs could stand in. A redirect goes to a
	 * THIRD party, so it asks `publishableAddrsForPeer` — the one definition, shared with
	 * `ClusterService` and `findCluster` — rather than reading connections alone.
	 */
	private async getPeerAddrs(peerId: PeerId): Promise<string[]> {
		if (this.components.getConnectionAddrs) return await this.components.getConnectionAddrs(peerId)
		const libp2p = this.getLibp2p() as any
		if (!libp2p?.getConnections) return []
		const conns: DirectionalConnection[] = libp2p.getConnections(peerId) ?? []
		return await publishableAddrsForPeer(libp2p, conns, peerId, this.addressLog)
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
			return encodePeers(await Promise.all(peers.map(async (pid: PeerId) => ({
				id: pid.toString(),
				addrs: await this.getPeerAddrs(pid)
			}))))
		}

		return null
	}

	/**
	 * Handle incoming streams on the repo protocol
	 */
	private handleIncomingStream(stream: Stream, connection?: Connection): void {
		const peerId = connection?.remotePeer

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
					// No `skipClusterFetch` here: a read on this protocol comes from ANOTHER node, so
					// it must reach `CoordinatorRepo`'s cohort consult — answering a bare absent for
					// a block a cohort peer holds is an authoritative lie the transactor never
					// retries. Only the sync protocol keeps the flag (`sync/service.ts`, where the
					// consult itself lands), and that is what stops the recursion.
					// NOTE: this also puts lazy read-repair on remote reads of locally-present blocks
					// — one consult per block per `readRepairWindowMs`, damped by a 1000-entry LRU of
					// block ids. If a working set wider than that LRU ever shows a consult on every
					// read, widen the LRU rather than reinstating the skip.
					response = await this.repo.get(operation.get, { expiration: message.expiration })
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
				// Authorization runs before ANY decoding or execution. Guarded on the field so a
				// node without a predicate keeps the original path untouched.
				if (this.authorization && await this.authorization.deny(stream, peerId?.toString())) return
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
