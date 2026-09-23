import { pushable } from 'it-pushable';

/**
 * One end of a {@link makeLinkedPair}: the shape every libp2p stream consumer in this package
 * duck-types against (`send` / `close` / `abort` / async-iterable).
 */
export interface LinkedStream {
	send: (chunk: any) => void;
	close: () => Promise<void>;
	abort: (err?: Error) => void;
	[Symbol.asyncIterator]: () => AsyncGenerator<any>;
}

/**
 * An in-memory linked duplex pair backed by two `it-pushable` queues: what one side writes the
 * other side reads, so a client's encode → a service's decode/handle/encode → the client's decode
 * all run for real without standing up libp2p.
 *
 * `abort(err)` ends BOTH queues with the error, so a deadline-driven `stream.abort(...)` actually
 * unblocks a blocked read — a real libp2p stream rejects its async iterator on abort, and a pair
 * that only ended its own side would let a deadline test hang instead of failing.
 *
 * Shared rather than re-declared per spec: two copies drifting apart is how a harness stops
 * modelling the stream the production code meets.
 */
export function makeLinkedPair(): { clientStream: LinkedStream; serverStream: LinkedStream } {
	const toServer = pushable<any>({ objectMode: true });
	const toClient = pushable<any>({ objectMode: true });

	return {
		clientStream: {
			send: (chunk: any) => { toServer.push(chunk); },
			close: async () => { toServer.end(); },
			abort: (err?: Error) => { toServer.end(err); toClient.end(err); },
			async *[Symbol.asyncIterator]() { yield* toClient; }
		},
		serverStream: {
			send: (chunk: any) => { toClient.push(chunk); },
			close: async () => { toClient.end(); },
			abort: (err?: Error) => { toClient.end(err); toServer.end(err); },
			async *[Symbol.asyncIterator]() { yield* toServer; }
		}
	};
}
