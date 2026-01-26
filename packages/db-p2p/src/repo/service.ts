import { pipe } from 'it-pipe'
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed'
import type { Startable, Logger, IncomingStreamData } from '@libp2p/interface'
import type { IRepo, RepoMessage } from '@optimystic/db-core'
import { computeResponsibility } from '../routing/responsibility.js'
import { peersEqual } from '../peer-utils.js'
import { sha256 } from 'multiformats/hashes/sha2'
import { buildKnownPeers } from '../routing/libp2p-known-peers.js'
import { encodePeers } from './redirect.js'
import type { Uint8ArrayList } from 'uint8arraylist'

// Define Components interface
interface BaseComponents {
	logger: { forComponent: (name: string) => Logger },
	registrar: {
		handle: (protocol: string, handler: (data: IncomingStreamData) => void, options: any) => Promise<void>
		unhandle: (protocol: string) => Promise<void>
	}
}

export type RepoServiceComponents = BaseComponents & {
	repo: IRepo
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

	/**
	 * Handle incoming streams on the repo protocol
	 */
	private handleIncomingStream(data: IncomingStreamData): void {
		const { stream, connection } = data
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
					{
						// Use sha256 digest of block id string for consistent key space
						const mh = await sha256.digest(new TextEncoder().encode(operation.get.blockIds[0]!))
						const key = mh.digest
						const nm: any = (this.components as any).libp2p?.services?.networkManager
						if (nm?.getCluster) {
							const cluster: any[] = await nm.getCluster(key);
							(message as any).cluster = (cluster as any[]).map(p => p.toString?.() ?? String(p))
							const selfId = (this.components as any).libp2p.peerId
							const isMember = cluster.some((p: any) => peersEqual(p, selfId))
							// Use responsibilityK to determine if we're in the responsible set
							const smallMesh = cluster.length < this.responsibilityK
							if (!smallMesh && !isMember) {
								const peers = cluster.filter((p: any) => !peersEqual(p, selfId))
								console.debug('repo-service:redirect', {
									peerId: selfId.toString(),
									reason: 'not-cluster-member',
									operation: 'get',
									blockId: operation.get.blockIds[0],
									cluster: cluster.map((p: any) => p.toString?.() ?? String(p))
								})
								response = encodePeers(peers.map((pid: any) => ({ id: pid.toString(), addrs: [] })))
							} else {
								response = await this.repo.get(operation.get, { expiration: message.expiration })
							}
						} else {
							response = await this.repo.get(operation.get, { expiration: message.expiration })
						}
					}
				} else if ('pend' in operation) {
					{
						const id = Object.keys(operation.pend.transforms)[0]!
						const mh = await sha256.digest(new TextEncoder().encode(id))
						const key = mh.digest
						const nm: any = (this.components as any).libp2p?.services?.networkManager
						if (nm?.getCluster) {
							const cluster: any[] = await nm.getCluster(key)
								; (message as any).cluster = (cluster as any[]).map(p => p.toString?.() ?? String(p))
							const selfId = (this.components as any).libp2p.peerId
							const isMember = cluster.some((p: any) => peersEqual(p, selfId))
							// Use responsibilityK to determine if we're in the responsible set
							const smallMesh = cluster.length < this.responsibilityK
							if (!smallMesh && !isMember) {
								const peers = cluster.filter((p: any) => !peersEqual(p, selfId))
								console.debug('repo-service:redirect', {
									peerId: selfId.toString(),
									reason: 'not-cluster-member',
									operation: 'pend',
									blockId: id,
									cluster: cluster.map((p: any) => p.toString?.() ?? String(p))
								})
								response = encodePeers(peers.map((pid: any) => ({ id: pid.toString(), addrs: [] })))
							} else {
								response = await this.repo.pend(operation.pend, { expiration: message.expiration })
							}
						} else {
							response = await this.repo.pend(operation.pend, { expiration: message.expiration })
						}
					}
				} else if ('cancel' in operation) {
					response = await this.repo.cancel(operation.cancel.actionRef, {
						expiration: message.expiration
					})
				} else if ('commit' in operation) {
					{
						const mh = await sha256.digest(new TextEncoder().encode(operation.commit.tailId))
						const key = mh.digest
						const nm: any = (this.components as any).libp2p?.services?.networkManager
						if (nm?.getCluster) {
							const cluster: any[] = await nm.getCluster(key)
								; (message as any).cluster = (cluster as any[]).map(p => p.toString?.() ?? String(p))
							const selfId = (this.components as any).libp2p.peerId
							const isMember = cluster.some((p: any) => peersEqual(p, selfId))
							// Use responsibilityK to determine if we're in the responsible set
							const smallMesh = cluster.length < this.responsibilityK
							if (!smallMesh && !isMember) {
								const peers = cluster.filter((p: any) => !peersEqual(p, selfId))
								console.debug('repo-service:redirect', {
									peerId: selfId.toString(),
									reason: 'not-cluster-member',
									operation: 'commit',
									tailId: operation.commit.tailId,
									cluster: cluster.map((p: any) => p.toString?.() ?? String(p))
								})
								response = encodePeers(peers.map((pid: any) => ({ id: pid.toString(), addrs: [] })))
							} else {
								response = await this.repo.commit(operation.commit, { expiration: message.expiration })
							}
						} else {
							response = await this.repo.commit(operation.commit, { expiration: message.expiration })
						}
					}
				}

				// Encode and yield the response
				yield new TextEncoder().encode(JSON.stringify(response))
			}
		}

		Promise.resolve().then(async () => {
			await pipe(
				stream,
				(source) => lpDecode(source),
				processStream.bind(this),
				(source) => lpEncode(source),
				stream
			)
		}).catch(err => {
			this.log.error('error handling repo protocol message from %p - %e', peerId, err)
		})
	}
}
