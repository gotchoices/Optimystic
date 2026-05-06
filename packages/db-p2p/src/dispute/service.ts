import { pipe } from 'it-pipe';
import { decode as lpDecode, encode as lpEncode } from 'it-length-prefixed';
import type { Startable, Logger, Stream, Connection, StreamHandler } from '@libp2p/interface';
import type { Uint8ArrayList } from 'uint8arraylist';
import type { DisputeMessage } from './types.js';
import type { DisputeService } from './dispute-service.js';

interface BaseComponents {
	logger: { forComponent: (name: string) => Logger };
	registrar: {
		handle: (protocol: string, handler: StreamHandler, options: any) => Promise<void>;
		unhandle: (protocol: string) => Promise<void>;
	};
}

export interface DisputeProtocolServiceComponents extends BaseComponents {
	disputeService: DisputeService;
}

export interface DisputeProtocolServiceInit {
	protocol?: string;
	protocolPrefix?: string;
	maxInboundStreams?: number;
	maxOutboundStreams?: number;
}

export function disputeProtocolService(init: DisputeProtocolServiceInit = {}): (components: DisputeProtocolServiceComponents) => DisputeProtocolService {
	return (components: DisputeProtocolServiceComponents) => new DisputeProtocolService(components, init);
}

/**
 * Libp2p service that handles dispute protocol messages.
 * Follows the same pattern as ClusterService.
 */
export class DisputeProtocolService implements Startable {
	private readonly protocol: string;
	private readonly maxInboundStreams: number;
	private readonly maxOutboundStreams: number;
	private readonly log: Logger;
	private readonly disputeService: DisputeService;
	private readonly components: DisputeProtocolServiceComponents;
	private running: boolean;

	constructor(components: DisputeProtocolServiceComponents, init: DisputeProtocolServiceInit = {}) {
		this.components = components;
		this.protocol = init.protocol ?? (init.protocolPrefix ?? '/db-p2p') + '/dispute/1.0.0';
		this.maxInboundStreams = init.maxInboundStreams ?? 16;
		this.maxOutboundStreams = init.maxOutboundStreams ?? 32;
		this.log = components.logger.forComponent('db-p2p:dispute');
		this.disputeService = components.disputeService;
		this.running = false;
	}

	readonly [Symbol.toStringTag] = '@libp2p/dispute';

	async start(): Promise<void> {
		if (this.running) return;

		await this.components.registrar.handle(this.protocol, this.handleIncomingStream.bind(this), {
			maxInboundStreams: this.maxInboundStreams,
			maxOutboundStreams: this.maxOutboundStreams,
		});

		this.running = true;
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		await this.components.registrar.unhandle(this.protocol);
		this.running = false;
	}

	private handleIncomingStream(stream: Stream, connection: Connection): void {
		const peerId = connection.remotePeer;

		const processStream = async function* (this: DisputeProtocolService, source: AsyncIterable<Uint8ArrayList>) {
			for await (const msg of source) {
				const decoded = new TextDecoder().decode(msg.subarray());
				const message = JSON.parse(decoded) as DisputeMessage;

				let response: any;
				switch (message.type) {
					case 'challenge': {
						const vote = await this.disputeService.handleChallenge(message.challenge);
						response = { type: 'vote', vote };
						break;
					}
					case 'resolution': {
						this.disputeService.handleResolution(message.resolution);
						response = { type: 'ack' };
						break;
					}
					default:
						throw new Error(`Unknown dispute message type: ${(message as any).type}`);
				}

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
				this.log.error('error handling dispute protocol message from %p - %e', peerId, err);
				stream.abort(err instanceof Error ? err : new Error(String(err)));
			}
		})();
	}
}
