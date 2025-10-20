import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import { pushable } from 'it-pushable';
import type { PeerId } from '@libp2p/interface';
import type { IPeerNetwork } from '@optimystic/db-core';
import { first } from './it-utility.js';

/** Base class for clients that communicate via a libp2p protocol */
export class ProtocolClient {
	constructor(
		protected readonly peerId: PeerId,
		protected readonly peerNetwork: IPeerNetwork,
	) { }

	protected async processMessage<T>(
		message: unknown,
		protocol: string,
		options?: { signal?: AbortSignal }
	): Promise<T> {
		const stream = await this.peerNetwork.connect(
			this.peerId,
			protocol,
			{ signal: options?.signal }
		);

		try {
			const source = pipe(
				stream.source,
				lpDecode,
				async function* (source) {
					for await (const data of source) {
						const decoded = new TextDecoder().decode(data.subarray());
						const parsed = JSON.parse(decoded);
						// Debug logging for cluster responses
						if (protocol.includes('/cluster/')) {
							console.log('[ProtocolClient] Received response:', {
								messageHash: (parsed as any)?.messageHash,
								hasPromisesField: 'promises' in (parsed ?? {}),
								hasCommitsField: 'commits' in (parsed ?? {}),
								promisesType: typeof (parsed as any)?.promises,
								commitsType: typeof (parsed as any)?.commits,
								promiseKeys: Object.keys((parsed as any)?.promises ?? {}),
								commitKeys: Object.keys((parsed as any)?.commits ?? {}),
								fullResponse: JSON.stringify(parsed).substring(0, 200)
							});
						}
						yield parsed;
					}
				}
			) as AsyncIterable<T>;

			const sink = pushable();
			void pipe(
				sink,
				lpEncode,
				stream.sink
			);

			sink.push(new TextEncoder().encode(JSON.stringify(message)));
			sink.end();

			return await first(() => source, () => { throw new Error('No response received') });
		} finally {
			stream.close();
		}
	}
}
