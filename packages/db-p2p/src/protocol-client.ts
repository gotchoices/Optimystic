import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';
import type { Stream as Libp2pStream } from '@libp2p/interface';
import type { PeerId, IPeerNetwork, IKeyNetwork, BlockId } from '@optimystic/db-core';
import { routingKeyForBlock } from '@optimystic/db-core';
import { first } from './it-utility.js';
import { createLogger } from './logger.js';
import { MAX_BLOCK_MESSAGE_BYTES } from './protocol-limits.js';
import { UNDECLARED_RPC_DEADLINES, type RpcDeadlineDefaults } from './rpc-deadline.js';
import { isPreparedStream } from './network/prepared-streams.js';

const log = createLogger('protocol-client');

/**
 * Thrown when the per-peer dial deadline expires before a stream is established.
 * Distinct from a libp2p dial failure (no route, refused, etc.) so the
 * batch-retry loop and diagnostic surfaces can identify a slow/unreachable peer
 * specifically. `.code === DIAL_TIMEOUT_ERROR_CODE`.
 */
export const DIAL_TIMEOUT_ERROR_CODE = 'DIAL_TIMEOUT';

export class DialTimeoutError extends Error {
	readonly code = DIAL_TIMEOUT_ERROR_CODE;
	constructor(peer: string, protocol: string, ms: number) {
		super(`dial timeout: peer=${peer} protocol=${protocol} after ${ms}ms`);
		this.name = 'DialTimeoutError';
	}
}

/**
 * Thrown when a peer dialed successfully but the response-read deadline expired
 * before it wrote a reply (it connected, then went silent). Distinct from
 * {@link DialTimeoutError} (never connected) and from a parent cancellation
 * (`options.signal`), so callers/diagnostics can tell "peer went quiet" apart
 * from "peer was unreachable" and "we cancelled". `.code === RESPONSE_TIMEOUT_ERROR_CODE`.
 */
export const RESPONSE_TIMEOUT_ERROR_CODE = 'RESPONSE_TIMEOUT';

export class ResponseTimeoutError extends Error {
	readonly code = RESPONSE_TIMEOUT_ERROR_CODE;
	constructor(peer: string, protocol: string, ms: number) {
		super(`response timeout: peer=${peer} protocol=${protocol} after ${ms}ms`);
		this.name = 'ResponseTimeoutError';
	}
}

/**
 * Thrown, before any stream is opened, for a request that encodes to more than the cap its server
 * decodes requests under ({@link ProcessMessageOptions.maxRequestBytes}). Sending it would only have
 * the remote reset the stream at the length prefix, which the caller cannot tell from a peer that went
 * silent. `.code === MESSAGE_TOO_LARGE_ERROR_CODE`.
 */
export const MESSAGE_TOO_LARGE_ERROR_CODE = 'MESSAGE_TOO_LARGE';

export class MessageTooLargeError extends Error {
	readonly code = MESSAGE_TOO_LARGE_ERROR_CODE;
	constructor(peer: string, readonly protocol: string, readonly bytes: number, readonly limit: number) {
		super(`message too large: peer=${peer} protocol=${protocol} encodes to ${bytes} bytes, over the ${limit}-byte request limit`);
		this.name = 'MessageTooLargeError';
	}
}

/** What a {@link ProtocolClient} subclass may bound one request by. */
export type ProcessMessageOptions = {
	signal?: AbortSignal;
	correlationId?: string;
	dialTimeoutMs?: number;
	responseTimeoutMs?: number;
	/** The largest reply frame read; a larger one rejects at its length prefix. Defaults to `MAX_BLOCK_MESSAGE_BYTES`. */
	maxDataLength?: number;
	/**
	 * The largest request sent: the cap the server decodes requests under. A larger request throws
	 * {@link MessageTooLargeError} before any stream is opened. Absent means unchecked.
	 */
	maxRequestBytes?: number;
};

/** Whether any byte of the reply has arrived on a stream, which decides whether a request may be re-sent. */
type ExchangeProgress = { replyStarted: boolean };

const cidSuffix = (options?: ProcessMessageOptions): string =>
	options?.correlationId ? ` cid=${options.correlationId}` : '';

const errorCode = (err: unknown): string => {
	const code = (err as { code?: unknown })?.code;
	return typeof code === 'string' && code.length > 0 ? code : 'none';
};

const errorLabel = (err: unknown): string => {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 200 ? message.slice(0, 200) + '…' : message;
};

/** Base class for clients that communicate via a libp2p protocol */
export class ProtocolClient {
	constructor(
		protected readonly peerId: PeerId,
		protected readonly peerNetwork: IPeerNetwork,
		/**
		 * What a subclass applies to a request whose caller supplied no deadline of its own — the
		 * node's resolved `LinkDeadlines` on a live node. A client that follows a redirect hands these
		 * to the client it builds for the next hop.
		 */
		protected readonly rpcDeadlines: RpcDeadlineDefaults = UNDECLARED_RPC_DEADLINES,
	) { }

	/**
	 * Remember that `coordinator` coordinates `blockId`, so a follow-up op on that block dials it directly
	 * instead of being redirected again. Only a key network keeps coordinator hints — a plain
	 * {@link IPeerNetwork} omits `recordCoordinator`, and this is then a no-op. The hint is keyed on the
	 * block's routing key, the key a later `findCoordinator` looks it up by.
	 */
	protected recordCoordinatorHint(blockId: BlockId, coordinator: PeerId): void {
		const hints = this.peerNetwork as IPeerNetwork & Partial<Pick<IKeyNetwork, 'recordCoordinator'>>;
		hints.recordCoordinator?.(routingKeyForBlock(blockId), coordinator);
	}

	/**
	 * Send `message` to this client's peer on `protocol` and return the first reply: one request on one
	 * stream, which is then closed.
	 *
	 * A stream the key network's `PreparedStreams` pool handed out was negotiated up to its idle time
	 * before this request, and the connection under it can have died in between without either side
	 * noticing. When such a stream fails before any reply byte arrives — for any reason other than this
	 * request's own response deadline, the caller's abort, or a reset from the remote (see
	 * {@link mayResend}) — the request is sent once more, on a stream
	 * from a new `connect`, under the same caller signal and inside what is left of the same response
	 * deadline. That can deliver a request twice if the remote did receive it before failing; every
	 * protocol the pool serves already tolerates re-delivery, since the batch retries in
	 * `NetworkTransactor` re-send requests today. A failure after a reply byte, and a failure of the
	 * re-send, propagate unchanged.
	 *
	 * The message is encoded once, before any stream is opened: a request over
	 * `options.maxRequestBytes` throws {@link MessageTooLargeError} without dialing, and the re-send
	 * sends the same bytes.
	 */
	protected async processMessage<T>(
		message: unknown,
		protocol: string,
		options?: ProcessMessageOptions
	): Promise<T> {
		const t0 = Date.now();
		const request = this.encodeRequest(message, protocol, options);
		const stream = await this.openRequestStream(protocol, options);
		// The response deadline starts once the first stream is open; a re-send runs inside what is left of it.
		const responseTimeoutMs = options?.responseTimeoutMs;
		const responseDeadline = responseTimeoutMs && responseTimeoutMs > 0 ? Date.now() + responseTimeoutMs : undefined;
		const progress: ExchangeProgress = { replyStarted: false };
		try {
			return await this.exchange<T>(stream, request, protocol, options, t0, responseDeadline, progress);
		} catch (err) {
			if (!this.mayResend(stream, progress, err, options)) throw err;
			log('prepared:resend peer=%s protocol=%s reason=%s%s', this.peerId.toString(), protocol, errorLabel(err), cidSuffix(options));
			const resendStream = await this.openRequestStream(protocol, options);
			return await this.exchange<T>(resendStream, request, protocol, options, t0, responseDeadline, { replyStarted: false });
		}
	}

	/** `message` as the bytes one request frame carries, refused with {@link MessageTooLargeError} when over `options.maxRequestBytes`. */
	private encodeRequest(message: unknown, protocol: string, options?: ProcessMessageOptions): Uint8Array {
		const request = new TextEncoder().encode(JSON.stringify(message));
		const limit = options?.maxRequestBytes;
		if (limit !== undefined && request.byteLength > limit) {
			log('request:too-large peer=%s protocol=%s bytes=%d limit=%d%s', this.peerId.toString(), protocol, request.byteLength, limit, cidSuffix(options));
			throw new MessageTooLargeError(this.peerId.toString(), protocol, request.byteLength, limit);
		}
		return request;
	}

	/**
	 * A request on a prepared stream that failed before its reply began is sent once more — but never
	 * when the failure is this request's own response deadline or the caller's abort, which a re-send
	 * would only repeat, nor when the remote reset the stream. Every service this pool serves resets
	 * its stream when handling the request throws, so a reset says the request reached a live handler
	 * and failed there: re-sending would run it a second time to the same end. The failure a re-send
	 * exists for — a connection that died under the held stream — never arrives as a remote reset,
	 * since nothing comes back over a dead connection; it ends the stream from this side.
	 */
	private mayResend(stream: Libp2pStream, progress: ExchangeProgress, err: unknown, options?: ProcessMessageOptions): boolean {
		if (!isPreparedStream(stream) || progress.replyStarted) return false;
		if (stream.status === 'reset') return false;
		if (err instanceof ResponseTimeoutError) return false;
		return options?.signal?.aborted !== true;
	}

	/**
	 * Open the stream one request travels on, under the per-peer dial deadline when one is set: an
	 * unreachable peer then fails fast so the caller can re-pick a different coordinator — independent
	 * of any overall transaction budget the caller may also be enforcing.
	 */
	private async openRequestStream(protocol: string, options?: ProcessMessageOptions): Promise<Libp2pStream> {
		const peer = this.peerId.toString();
		const cid = cidSuffix(options);
		log('dial peer=%s protocol=%s%s', peer, protocol, cid);
		const t0 = Date.now();

		const dialTimeoutMs = options?.dialTimeoutMs;
		const dialController = dialTimeoutMs && dialTimeoutMs > 0 ? new AbortController() : undefined;
		let dialTimer: ReturnType<typeof setTimeout> | undefined;
		const onParentAbort = () => dialController?.abort(options?.signal?.reason);
		if (dialController) {
			dialTimer = setTimeout(() => {
				dialController.abort(new DialTimeoutError(peer, protocol, dialTimeoutMs!));
			}, dialTimeoutMs);
			if (options?.signal) {
				if (options.signal.aborted) dialController.abort(options.signal.reason);
				else options.signal.addEventListener('abort', onParentAbort, { once: true });
			}
		}
		const dialSignal = dialController?.signal ?? options?.signal;

		let stream: Libp2pStream;
		try {
			stream = await this.peerNetwork.connect(
				this.peerId,
				protocol,
				{ signal: dialSignal }
			) as unknown as Libp2pStream;
		} catch (err) {
			const elapsed = Date.now() - t0;
			// If the dial AbortController fired due to our own timer, surface the
			// dial-timeout error rather than the underlying AbortError so callers
			// can distinguish "peer was slow" from "user/parent cancelled".
			if (dialController?.signal.aborted && dialController.signal.reason instanceof DialTimeoutError) {
				log('dial:timeout peer=%s protocol=%s ms=%d%s', peer, protocol, elapsed, cid);
				throw dialController.signal.reason;
			}
			// A cancelled caller is owed its own reason — a whole-request budget's names the budget —
			// not whichever error libp2p raised several layers down. Mirrors the read below.
			if (options?.signal?.aborted) {
				log('dial:aborted peer=%s protocol=%s ms=%d%s', peer, protocol, elapsed, cid);
				throw options.signal.reason;
			}
			log('dial:fail peer=%s protocol=%s ms=%d code=%s msg=%s%s', peer, protocol, elapsed, errorCode(err), errorLabel(err), cid);
			throw err;
		} finally {
			if (dialTimer) clearTimeout(dialTimer);
			if (options?.signal) options.signal.removeEventListener('abort', onParentAbort);
		}
		log('dial:ok peer=%s ms=%d prepared=%s%s', peer, Date.now() - t0, isPreparedStream(stream), cid);
		return stream;
	}

	/**
	 * Send the encoded `request` on `stream`, read the first reply, and close the stream. `progress` records
	 * whether any reply byte arrived, which is what decides whether a failed prepared stream may be
	 * re-sent. `t0` is when the request began, for the timings it logs.
	 */
	private async exchange<T>(
		stream: Libp2pStream,
		request: Uint8Array,
		protocol: string,
		options: ProcessMessageOptions | undefined,
		t0: number,
		responseDeadline: number | undefined,
		progress: ExchangeProgress
	): Promise<T> {
		const peer = this.peerId.toString();
		const cid = cidSuffix(options);
		// Per-peer response deadline. A peer that connects but then never writes a frame
		// (and never closes the stream) would hang the `first(...)` read below forever.
		// Setting a timer alone is not enough — the underlying `for await` over the
		// libp2p stream keeps awaiting regardless. The decisive action is to actively
		// `stream.abort(...)`, which rejects the stream's async iterator and unblocks
		// the read. A parent `options.signal` abort is forwarded the same way so a
		// cancelled caller tears the stream down rather than leaking it. When neither
		// `responseTimeoutMs` nor `signal` is supplied, no cap is imposed — preserving
		// every existing caller (mirrors how omitting `dialTimeoutMs` imposes no dial cap).
		let responseTimer: ReturnType<typeof setTimeout> | undefined;
		let responseTimeoutError: ResponseTimeoutError | undefined;
		const onParentAbortResponse = () => {
			try { stream.abort(options?.signal?.reason ?? new Error('aborted')); } catch { /* already torn down */ }
		};
		try {
			if (responseDeadline !== undefined) {
				const responseTimeoutMs = options?.responseTimeoutMs ?? 0;
				responseTimer = setTimeout(() => {
					responseTimeoutError = new ResponseTimeoutError(peer, protocol, responseTimeoutMs);
					try { stream.abort(responseTimeoutError); } catch { /* already torn down */ }
				}, Math.max(0, responseDeadline - Date.now()));
			}
			if (options?.signal) {
				if (options.signal.aborted) onParentAbortResponse();
				else options.signal.addEventListener('abort', onParentAbortResponse, { once: true });
			}

			// Send the request using length-prefixed encoding. Its size was judged once, by name, against
			// `maxRequestBytes` (`encodeRequest`); the encoder's own default would add a 4 MiB cap below the
			// 8 MiB frame block-carrying servers decode under, and refuse every request between the two.
			const encoded = pipe(
				[request],
				(source) => lpEncode(source, { maxDataLength: request.byteLength })
			);
			for await (const chunk of encoded) {
				stream.send(chunk);
			}

			// Read the response from the stream (which is now directly AsyncIterable).
			// Cap the response frame size so a peer can't flood the client with an
			// oversized reply; each caller passes the cap matching its response shape
			// (control vs block), defaulting to the block cap so no existing caller
			// regresses. An oversized frame rejects at the length-prefix (before
			// allocation) and surfaces through the read's catch, tearing the stream down.
			const maxDataLength = options?.maxDataLength ?? MAX_BLOCK_MESSAGE_BYTES;
			const source = pipe(
				stream,
				// Noted on the raw bytes, ahead of framing: a reply that began and then broke off is no
				// longer a request the remote never saw.
				async function* (source) {
					for await (const chunk of source) {
						if (!progress.replyStarted) {
							log('first-byte peer=%s ms=%d%s', peer, Date.now() - t0, cid);
							progress.replyStarted = true;
						}
						yield chunk;
					}
				},
				(source) => lpDecode(source, { maxDataLength }),
				async function* (source) {
					for await (const data of source) {
						// A service answers a `void` operation with `JSON.stringify(undefined)`, which encodes as a
						// zero-length frame. No JSON value serializes to an empty string, so an empty frame is
						// exactly a `void` reply.
						yield data.byteLength === 0 ? undefined : JSON.parse(new TextDecoder().decode(data.subarray()));
					}
				}
			) as AsyncIterable<T>;

			let result: T;
			try {
				result = await first(() => source, () => { throw new Error('No response received') });
			} catch (err) {
				// Aborting the stream (our timer or a parent abort) surfaces here as an
				// iterator error. Translate it so callers see why the read ended.
				if (responseTimeoutError) {
					log('response:timeout peer=%s protocol=%s ms=%d%s', peer, protocol, Date.now() - t0, cid);
					throw responseTimeoutError;
				}
				if (options?.signal?.aborted) {
					log('response:aborted peer=%s protocol=%s ms=%d%s', peer, protocol, Date.now() - t0, cid);
					throw options.signal.reason;
				}
				throw err;
			}
			log('response peer=%s protocol=%s ms=%d%s', peer, protocol, Date.now() - t0, cid);
			return result;
		} finally {
			if (responseTimer) clearTimeout(responseTimer);
			if (options?.signal) options.signal.removeEventListener('abort', onParentAbortResponse);
			// Closing an already-aborted stream must be safe.
			try { await stream.close(); } catch { /* already torn down */ }
		}
	}
}
