import { pipe } from 'it-pipe'
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed'
import type { Startable, Logger, Stream, Connection, StreamHandler, PeerId } from '@libp2p/interface'
import type { IRepo, RepoMessage } from '@optimystic/db-core'
import { peersEqual } from '../peer-utils.js'
import { sha256 } from 'multiformats/hashes/sha2'
import { encodePeers, type RedirectPayload } from './redirect.js'
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
	private readonly k: number
	/** Responsibility K - how many peers are responsible for a key (for redirect decisions) */
	private readonly responsibilityK: number

	constructor(components: RepoServiceComponents, init: RepoServiceInit = {}) {
		this.components = components
		const computed = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0'
		this.protocol = computed
		this.maxInboundStreams = init.maxInboundStreams ?? 32
		this.maxOutboundStreams = init.maxOutboundStreams ?? 64
		this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:repo-service')
		this.repo = components.repo
		this.running = false
		this.k = init.kBucketSize ?? 10
		this.responsibilityK = init.responsibilityK ?? 1
	}

	readonly [Symbol.toStringTag] = '@libp2p/repo-service'

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
		return (this.components as any).libp2p?.services?.networkManager as NetworkManagerLike | undefined
	}

	private getSelfId(): PeerId | undefined {
		if (this.components.peerId) return this.components.peerId
		return (this.components as any).libp2p?.peerId as PeerId | undefined
	}

	private getPeerAddrs(peerId: PeerId): string[] {
		if (this.components.getConnectionAddrs) return this.components.getConnectionAddrs(peerId)
		const libp2p = (this.components as any).libp2p
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
	 * Check if this node should redirect the request for a given key.
	 * Returns a RedirectPayload if not responsible, null if should handle locally.
	 * Also attaches cluster info to the message for downstream use.
	 */
	async checkRedirect(blockKey: string, opName: string, message: RepoMessage): Promise<RedirectPayload | null> {
		const nm = this.getNetworkManager()
		if (!nm) return null

		const mh = await sha256.digest(new TextEncoder().encode(blockKey))
		const key = mh.digest
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

				// Process each operation
				const operation = message.operations[0]
				let response: any

				if ('get' in operation) {
					const blockKey = operation.get.blockIds[0]!
					const redirect = await this.checkRedirect(blockKey, 'get', message)
					if (redirect) {
						response = redirect
					} else {
						response = await this.repo.get(operation.get, { expiration: message.expiration, skipClusterFetch: true } as any)
					}
				} else if ('pend' in operation) {
					const blockKey = Object.keys(operation.pend.transforms)[0]!
					const redirect = await this.checkRedirect(blockKey, 'pend', message)
					if (redirect) {
						response = redirect
					} else {
						response = await this.repo.pend(operation.pend, { expiration: message.expiration })
					}
				} else if ('cancel' in operation) {
					const blockKey = operation.cancel.actionRef.blockIds[0]
					if (blockKey) {
						const redirect = await this.checkRedirect(blockKey, 'cancel', message)
						if (redirect) {
							response = redirect
						} else {
							response = await this.repo.cancel(operation.cancel.actionRef, { expiration: message.expiration })
						}
					} else {
						response = await this.repo.cancel(operation.cancel.actionRef, { expiration: message.expiration })
					}
				} else if ('commit' in operation) {
					const blockKey = operation.commit.tailId
					const redirect = await this.checkRedirect(blockKey, 'commit', message)
					if (redirect) {
						response = redirect
					} else {
						response = await this.repo.commit(operation.commit, { expiration: message.expiration })
					}
				}

				// Encode and yield the response
				yield new TextEncoder().encode(JSON.stringify(response))
			}
		}

		void (async () => {
			try {
				const responses = pipe(
					stream,
					(source) => lpDecode(source),
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
