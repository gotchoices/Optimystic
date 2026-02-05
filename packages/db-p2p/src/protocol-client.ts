import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
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
			// Send the request using length-prefixed encoding
			const encoded = pipe(
				[new TextEncoder().encode(JSON.stringify(message))],
				lpEncode
			);
			for await (const chunk of encoded) {
				stream.send(chunk);
			}

			// Read the response from the stream (which is now directly AsyncIterable)
			const source = pipe(
				stream,
				lpDecode,
				async function* (source) {
					for await (const data of source) {
						const decoded = new TextDecoder().decode(data.subarray());
						const parsed = JSON.parse(decoded);
						yield parsed;
					}
				}
			) as AsyncIterable<T>;

			return await first(() => source, () => { throw new Error('No response received') });
		} finally {
			await stream.close();
		}
	}
}
