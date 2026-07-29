/**
 * Optional, embedder-supplied authorization for inbound protocol streams.
 *
 * The `repo`, `cluster`, `sync` and `block-transfer` services otherwise go straight from
 * "stream opened" to "decode and execute", so any peer that can open a connection can issue
 * database operations. An application that owns a *private* database (only nodes it admitted
 * may read or write) needs a seam ahead of decoding; this is that seam.
 *
 * Contract:
 *
 * - **Absent predicate → today's behavior exactly.** Every service holds
 *   `InboundStreamAuthorization | undefined`; when it is `undefined` the handler never
 *   awaits anything extra and no code on this path runs.
 * - **Supplied predicate → fail closed.** Only a literal `true` allows the stream. `false`,
 *   a throw, a rejection, a timeout, or an unidentifiable remote peer all deny, and denial
 *   aborts the stream *before* any frame is decoded or any operation executed.
 * - **Called once per inbound stream**, not once per operation — which is equivalent here
 *   because all four protocols are strictly one request per stream (each handler's generator
 *   `return`s after the first response, so a second queued frame is never read).
 * - **Peer id encoding**: the predicate receives `connection.remotePeer.toString()` — the
 *   libp2p base58btc/CIDv1 peer-id string (e.g. `12D3KooW…`), the same form
 *   `PeerId.toString()` produces everywhere else in this codebase. Compare against that,
 *   never against a multiaddr, a public-key hash, or a base64 encoding.
 * - **What a caller observes**: a stream reset. Denial is deliberately *not* reported on the
 *   wire — telling an unauthorized peer "you are not a member" confirms membership state to
 *   exactly the party the embedder decided not to trust, and the four protocols have four
 *   different response shapes with no common error frame. The denial is instead loud on the
 *   *denying* node: it is logged with the peer id, protocol and reason, and the stream is
 *   aborted with an {@link UnauthorizedInboundStreamError} carrying
 *   {@link INBOUND_STREAM_UNAUTHORIZED_CODE}, so local diagnostics can tell a denial apart
 *   from a transport fault.
 * - **Cost**: the predicate sits in the hot path of every inbound stream, ahead of the work
 *   that stream would do. Embedders are expected to make it cheap — an in-memory set lookup —
 *   and to memoize anything that would otherwise hit storage or the network per stream.
 *
 * NOTE: denial is stateless and unthrottled — a denied peer may reopen streams as fast as
 * libp2p's per-connection `maxInboundStreams` allows, and nothing here records the denial. That
 * is fine while the predicate is an in-memory lookup. If a denied peer ever shows up as load, the
 * fix is upstream of this module, not inside it: feed denials into `PeerReputationService`, or
 * refuse the peer at the connection level with `NodeOptions.connectionGater`.
 */

/**
 * Predicate deciding whether `remotePeerId` may open `protocol` on this node.
 *
 * @param remotePeerId the dialing peer's `PeerId.toString()` (base58btc / CIDv1, `12D3KooW…`)
 * @param protocol the full protocol id the stream was opened on, e.g.
 *   `/optimystic/<network>/repo/1.0.0`
 * @returns `true` to allow. Anything else — `false`, a throw, or a rejection — denies.
 */
export type AuthorizeInboundStream = (remotePeerId: string, protocol: string) => Promise<boolean> | boolean;

/** Stable error code carried by {@link UnauthorizedInboundStreamError}. */
export const INBOUND_STREAM_UNAUTHORIZED_CODE = 'ERR_INBOUND_STREAM_UNAUTHORIZED';

/**
 * The reason an inbound stream was aborted by the authorization gate. Distinct from a
 * transport fault so the denying node's logs and any local abort-reason inspection can tell
 * the two apart; the remote only ever sees the stream reset (see the module doc).
 */
export class UnauthorizedInboundStreamError extends Error {
	readonly code = INBOUND_STREAM_UNAUTHORIZED_CODE;
	constructor(remotePeerId: string, protocol: string, reason: string) {
		super(`inbound stream denied: peer=${remotePeerId} protocol=${protocol} reason=${reason}`);
		this.name = 'UnauthorizedInboundStreamError';
	}
}

/**
 * How long the predicate may take before the stream is denied. A hanging predicate would
 * otherwise pin an inbound stream slot indefinitely; timing out is the fail-closed reading of
 * "we could not establish that this peer is allowed".
 */
export const DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS = 5_000;

/** The slice of a service's init that configures this gate. Mixed into all four service inits. */
export interface InboundStreamAuthorizationInit {
	/**
	 * Optional predicate consulted once per inbound stream, before any decoding or execution.
	 * Absent → no check at all. See {@link AuthorizeInboundStream}.
	 */
	authorizeInboundStream?: AuthorizeInboundStream;
	/**
	 * Deadline for {@link InboundStreamAuthorizationInit.authorizeInboundStream}; expiry denies
	 * the stream. Default {@link DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS}.
	 */
	authorizeInboundStreamTimeoutMs?: number;
}

/** The part of a libp2p `Stream` this gate needs: the ability to tear it down. */
interface AbortableStream {
	abort: (err: Error) => void;
}

/** Log sink shape shared by the component loggers and the `debug` loggers the services use. */
export type AuthorizationLog = (message: string, ...args: unknown[]) => void;

/** Marker resolved by the deadline race when the predicate has not settled in time. */
const TIMED_OUT = Symbol('inbound-authorization-timeout');

/**
 * A configured authorization gate for one service's protocol. Constructed only when the
 * embedder supplied a predicate, so a service holding `undefined` runs the original code path.
 */
export class InboundStreamAuthorization {
	constructor(
		private readonly authorize: AuthorizeInboundStream,
		private readonly protocol: string,
		private readonly timeoutMs: number,
		private readonly log: AuthorizationLog
	) { }

	/**
	 * Consult the predicate for one inbound stream and abort the stream if it is not allowed.
	 *
	 * @returns `true` when the stream was denied — the caller must return immediately without
	 *   decoding anything — and `false` when it may proceed.
	 */
	async deny(stream: AbortableStream, remotePeerId: string | undefined): Promise<boolean> {
		// No identifiable remote → the predicate cannot be asked, so we cannot establish
		// authorization. Fail closed rather than fall through to execution.
		if (remotePeerId === undefined) {
			return this.abort(stream, '<unidentified>', 'no remote peer id on the inbound connection');
		}
		const verdict = await this.decide(remotePeerId);
		return verdict.allowed ? false : this.abort(stream, remotePeerId, verdict.reason);
	}

	/** Run the predicate under its deadline, converting every failure mode into a denial. */
	private async decide(remotePeerId: string): Promise<{ allowed: true } | { allowed: false, reason: string }> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const verdict = this.authorize(remotePeerId, this.protocol);
			// A synchronous predicate needs no timer at all.
			if (typeof verdict === 'boolean') {
				return verdict ? { allowed: true } : { allowed: false, reason: 'predicate returned false' };
			}
			const decision = await Promise.race([
				verdict,
				new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), this.timeoutMs); })
			]);
			if (decision === TIMED_OUT) {
				return { allowed: false, reason: `predicate did not settle within ${this.timeoutMs}ms` };
			}
			return decision === true ? { allowed: true } : { allowed: false, reason: 'predicate returned false' };
		} catch (err) {
			// A throwing predicate is a bug in the embedder, not permission to proceed: log it
			// (never swallow) and deny.
			this.log('authorization predicate threw for peer=%s protocol=%s - %o', remotePeerId, this.protocol, err);
			return { allowed: false, reason: `predicate threw: ${err instanceof Error ? err.message : String(err)}` };
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/** Log the denial and tear the stream down. Always returns `true` (denied). */
	private abort(stream: AbortableStream, remotePeerId: string, reason: string): true {
		const error = new UnauthorizedInboundStreamError(remotePeerId, this.protocol, reason);
		this.log('inbound stream denied peer=%s protocol=%s reason=%s', remotePeerId, this.protocol, reason);
		try {
			stream.abort(error);
		} catch (err) {
			// The stream may already be torn down; the denial itself still stands.
			this.log('aborting a denied stream failed peer=%s protocol=%s - %o', remotePeerId, this.protocol, err);
		}
		return true;
	}
}

/**
 * Build the gate for a service, or `undefined` when the embedder supplied no predicate.
 *
 * Returning `undefined` (rather than an always-allow gate) is what makes the absent-predicate
 * case genuinely free: the call site guards on the field and never awaits.
 */
export function createInboundStreamAuthorization(
	init: InboundStreamAuthorizationInit,
	protocol: string,
	log: AuthorizationLog
): InboundStreamAuthorization | undefined {
	if (init.authorizeInboundStream === undefined) {
		return undefined;
	}
	return new InboundStreamAuthorization(
		init.authorizeInboundStream,
		protocol,
		init.authorizeInboundStreamTimeoutMs ?? DEFAULT_INBOUND_AUTHORIZATION_TIMEOUT_MS,
		log
	);
}
