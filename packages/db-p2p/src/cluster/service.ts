import { pipe } from 'it-pipe';
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed';
import type { Startable, Logger, IncomingStreamData } from '@libp2p/interface';
import type { ICluster, ClusterRecord } from '@optimystic/db-core';
import { computeResponsibility } from '../routing/responsibility.js'
import { peersEqual } from '../peer-utils.js'
import { buildKnownPeers } from '../routing/libp2p-known-peers.js'
import { encodePeers } from '../repo/redirect.js'
import type { Uint8ArrayList } from 'uint8arraylist';

interface BaseComponents {
	logger: { forComponent: (name: string) => Logger },
	registrar: {
		handle: (protocol: string, handler: (data: IncomingStreamData) => void, options: any) => Promise<void>,
		unhandle: (protocol: string) => Promise<void>
	}
}

export interface ClusterServiceComponents extends BaseComponents {
	cluster: ICluster
}

export interface ClusterServiceInit {
	protocol?: string,
	protocolPrefix?: string,
	maxInboundStreams?: number,
	maxOutboundStreams?: number,
	logPrefix?: string,
  kBucketSize?: number,
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
  private readonly k: number;

	constructor(components: ClusterServiceComponents, init: ClusterServiceInit = {}) {
		this.components = components;
		this.protocol = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/cluster/1.0.0';
		this.maxInboundStreams = init.maxInboundStreams ?? 32;
		this.maxOutboundStreams = init.maxOutboundStreams ?? 64;
		this.log = components.logger.forComponent(init.logPrefix ?? 'db-p2p:cluster');
		this.cluster = components.cluster;
		this.running = false;
    this.k = init.kBucketSize ?? 10;
	}

	readonly [Symbol.toStringTag] = '@libp2p/cluster';

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

	private handleIncomingStream(data: IncomingStreamData): void {
		const { stream, connection } = data;
		const peerId = connection.remotePeer;

		const processStream = async function* (this: ClusterService, source: AsyncIterable<Uint8ArrayList>) {
			for await (const msg of source) {
				// Decode the message
				const decoded = new TextDecoder().decode(msg.subarray());
				const message = JSON.parse(decoded) as { operation: string; record: ClusterRecord };

				// Process the operation
				let response: any;
				if (message.operation === 'update') {
          // Use message.record.message as key source; this is RepoMessage carrying block IDs
          const tailId = (message.record?.message as any)?.commit?.tailId ?? (message.record?.message as any)?.pend ? Object.keys((message.record as any).message.pend.transforms)[0] : undefined
          if (tailId) {
            const { sha256 } = await import('multiformats/hashes/sha2')
            const mh = await sha256.digest(new TextEncoder().encode(tailId))
            const key = mh.digest
            const nm: any = (this.components as any).libp2p?.services?.networkManager
            if (nm?.getCluster) {
              const cluster: any[] = await nm.getCluster(key)
              ;(message as any).cluster = (cluster as any[]).map(p => p.toString?.() ?? String(p))
              const selfId = (this.components as any).libp2p.peerId
              const isMember = cluster.some((p: any) => peersEqual(p, selfId))
              if (!isMember) {
                const peers = cluster.filter((p: any) => !peersEqual(p, selfId))
                response = encodePeers(peers.map((pid: any) => ({ id: pid.toString(), addrs: [] })))
              } else {
                response = await this.cluster.update(message.record)
              }
            } else {
              response = await this.cluster.update(message.record)
            }
					} else {
						response = await this.cluster.update(message.record)
					}
				} else {
					throw new Error(`Unknown operation: ${message.operation}`);
				}

				// Encode and yield the response
				yield new TextEncoder().encode(JSON.stringify(response));
			}
		};

		Promise.resolve().then(async () => {
			await pipe(
				stream,
				(source) => lpDecode(source),
				processStream.bind(this),
				(source) => lpEncode(source),
				stream
			);
		}).catch((err: Error) => {
			this.log.error('error handling cluster protocol message from %p - %e', peerId, err);
		});
	}
}
