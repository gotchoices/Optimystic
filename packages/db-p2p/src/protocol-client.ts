import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import type { Stream as Libp2pStream } from '@libp2p/interface';
import type { PeerId, IPeerNetwork } from '@optimystic/db-core';
import { first } from './it-utility.js';
import { createLogger } from './logger.js';

const log = createLogger('protocol-client');

/** Base class for clients that communicate via a libp2p protocol */
export class ProtocolClient {
	constructor(
		protected readonly peerId: PeerId,
		protected readonly peerNetwork: IPeerNetwork,
	) { }

	protected async processMessage<T>(
		message: unknown,
		protocol: string,
		options?: { signal?: AbortSignal; correlationId?: string }
	): Promise<T> {
		const peer = this.peerId.toString();
		const cid = options?.correlationId;
		log('dial peer=%s protocol=%s%s', peer, protocol, cid ? ` cid=${cid}` : '');
		const t0 = Date.now();

		let stream: Libp2pStream;
		try {
			stream = await this.peerNetwork.connect(
				this.peerId,
				protocol,
				{ signal: options?.signal }
			) as unknown as Libp2pStream;
		} catch (err) {
			log('dial:fail peer=%s protocol=%s ms=%d%s', peer, protocol, Date.now() - t0, cid ? ` cid=${cid}` : '');
			throw err;
		}
		log('dial:ok peer=%s ms=%d%s', peer, Date.now() - t0, cid ? ` cid=${cid}` : '');

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
			let firstByte = true;
			const source = pipe(
				stream,
				lpDecode,
				async function* (source) {
					for await (const data of source) {
						if (firstByte) {
							log('first-byte peer=%s ms=%d%s', peer, Date.now() - t0, cid ? ` cid=${cid}` : '');
							firstByte = false;
						}
						const decoded = new TextDecoder().decode(data.subarray());
						const parsed = JSON.parse(decoded);
						yield parsed;
					}
				}
			) as AsyncIterable<T>;

			const result = await first(() => source, () => { throw new Error('No response received') });
			log('response peer=%s protocol=%s ms=%d%s', peer, protocol, Date.now() - t0, cid ? ` cid=${cid}` : '');
			return result;
		} finally {
			await stream.close();
		}
	}
}
