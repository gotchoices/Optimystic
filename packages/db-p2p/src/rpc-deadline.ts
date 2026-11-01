import { DEFAULT_COHORT_QUERY_TIMEOUT_MS } from '@optimystic/db-core';
import { unrefTimer } from './unref-timer.js';

/**
 * Per-RPC deadline knobs shared by the simple {@link ProtocolClient} subclasses
 * (cluster / sync / dispute). `dialTimeoutMs` bounds connecting; `responseTimeoutMs`
 * bounds waiting for the reply once connected (so a peer that connects then goes
 * silent throws {@link ResponseTimeoutError} instead of hanging the caller forever);
 * `signal` cancels the whole request. All optional.
 */
export type RpcDeadlineOptions = {
	signal?: AbortSignal;
	dialTimeoutMs?: number;
	responseTimeoutMs?: number;
};

/**
 * Per-peer dial deadline on a node that declares no link round trip, and the floor of the derived
 * one (see {@link resolveLinkDeadlines}). An unreachable peer fails the dial fast so the caller can
 * re-pick a different coordinator rather than blocking on a dead route.
 */
export const DEFAULT_DIAL_TIMEOUT_MS = 3000;

/**
 * Per-peer response deadline on a node that declares no link round trip, and the floor of the
 * derived one. A peer that connects then never writes a reply is abandoned instead of hanging the
 * caller forever.
 */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 10000;

/**
 * libp2p's connection-manager `dialTimeout` on a node that declares no link round trip, and the floor
 * of the derived one. Equal to libp2p's own default, but stated here so the fallback does not move
 * with libp2p.
 */
export const DEFAULT_LIBP2P_DIAL_TIMEOUT_MS = 10_000;

/**
 * libp2p's connection-manager `inboundUpgradeTimeout` on a node that declares no link round trip, and
 * the floor of the derived one. Equal to libp2p's own default, but stated here so the fallback does
 * not move with libp2p.
 */
export const DEFAULT_INBOUND_UPGRADE_TIMEOUT_MS = 10_000;

/**
 * libp2p's connection-manager `addressDialTimeout` on a node that declares no link round trip, and the
 * floor of the derived one. Equal to libp2p's own default (`ADDRESS_DIAL_TIMEOUT`), stated here so the
 * fallback does not move with libp2p.
 */
export const DEFAULT_ADDRESS_DIAL_TIMEOUT_MS = 6000;

/**
 * Per-peer deadline, on the dial and again on the reply, for the rebalance reaction's pushes and
 * confirms (`BlockTransferCoordinator`), on a node that declares no link round trip; the floor of
 * the derived one.
 */
export const DEFAULT_TRANSFER_TIMEOUT_MS = 30_000;

/**
 * The overall budget of one `NetworkTransactor` operation (its `timeoutMs`) on a node that declares no
 * link round trip; the floor of the derived one.
 */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * How long a stream open on the preferred connection to a peer may stay pending before
 * `openProtocolStream` starts one on the next path as well, on a node that declares no link round
 * trip; the floor of the derived one. Kept well under `DEFAULT_COHORT_QUERY_TIMEOUT_MS` (1000 ms) so
 * a cohort consult on an undeclared link that meets a dead connection first still finishes on the
 * live one inside its own deadline — the field failure of GitHub #32.
 */
export const DEFAULT_STREAM_HEDGE_DELAY_MS = 250;

/**
 * The two delays `openProtocolStream` (`network/open-protocol-stream.ts`) runs a stream open under.
 * A node resolves them with the rest of its deadlines ({@link LinkDeadlines} is assignable here); a
 * caller built without a node passes {@link UNDECLARED_STREAM_OPEN_DEADLINES}.
 */
export type StreamOpenDeadlines = {
	/**
	 * How long the stream open on the latest path tried may stay pending before the next path (the
	 * next open connection to the peer, then a fresh dial) is started as well, without cancelling it.
	 */
	hedgeDelayMs: number;
	/**
	 * How long a stream open on an existing connection may stay pending before that connection is
	 * judged dead and aborted. It is the RPC dial deadline, the bound this package already puts on one
	 * connection open plus negotiation — so on a link that takes longer than that to negotiate a
	 * stream a live connection is judged dead, which is why such a link declares its round trip.
	 */
	deadConnectionDelayMs: number;
};

export const UNDECLARED_STREAM_OPEN_DEADLINES: StreamOpenDeadlines = Object.freeze({
	hedgeDelayMs: DEFAULT_STREAM_HEDGE_DELAY_MS,
	deadConnectionDelayMs: DEFAULT_DIAL_TIMEOUT_MS,
});

/**
 * The fallback deadlines a {@link ProtocolClient} subclass applies to a request whose caller
 * supplied none. A client is built with the node's resolved values ({@link LinkDeadlines} is
 * assignable here), or with {@link UNDECLARED_RPC_DEADLINES} when nothing was declared.
 */
export type RpcDeadlineDefaults = {
	dialTimeoutMs: number;
	responseTimeoutMs: number;
};

export const UNDECLARED_RPC_DEADLINES: RpcDeadlineDefaults = Object.freeze({
	dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
	responseTimeoutMs: DEFAULT_RESPONSE_TIMEOUT_MS,
});

/**
 * Every network deadline a node derives from its declared link round trip
 * (`NodeOptions.linkRoundTripMs`), with the RPC dial and response deadlines replaced by
 * `NodeOptions.rpcDeadlines` where that sets them. All in milliseconds.
 */
export type LinkDeadlines = RpcDeadlineDefaults & StreamOpenDeadlines & {
	/**
	 * libp2p's connection-manager `dialTimeout`: the whole of a dial that carries no signal of its own,
	 * a cold relayed one included. Never shorter than {@link LinkDeadlines.addressDialTimeoutMs}, since
	 * one address has to be able to use all of its limit inside it.
	 */
	libp2pDialTimeoutMs: number;
	/**
	 * libp2p's connection-manager `inboundUpgradeTimeout`: the listener's side of a connection open.
	 * Its timer runs only over this node's own upgrade, never over a relay connection the dialer had
	 * to open first, so it does not take the cold-path multiple.
	 */
	inboundUpgradeTimeoutMs: number;
	/**
	 * libp2p's connection-manager `addressDialTimeout`: the most one address of a peer may take to
	 * connect. libp2p applies it inside every dial, including one that carries the caller's own signal,
	 * so it caps this package's RPC dials too, and a circuit dial opens its relay connection inside it.
	 */
	addressDialTimeoutMs: number;
	/** `clusterPolicy.cohortQueryTimeoutMs` when that field is not declared. */
	cohortQueryTimeoutMs: number;
	/** `BlockTransferCoordinator`'s per-peer `transferTimeoutMs`. */
	transferTimeoutMs: number;
	/**
	 * The overall budget of one `NetworkTransactor` operation (its `timeoutMs`), for a host that builds
	 * one over this node. The node itself applies it nowhere.
	 */
	transactionTimeoutMs: number;
	/**
	 * `NodeOptions.bootstrapContactTimeoutMs` when that field is not declared: the most a cohort
	 * lookup that would come back self-only waits for a configured bootstrap peer to join this
	 * node's view. One connection open, as {@link LinkDeadlines.libp2pDialTimeoutMs} allows the
	 * start-up bootstrap dial, plus identify on the opened connection.
	 */
	bootstrapContactTimeoutMs: number;
	/**
	 * A host's `NetworkTransactorInit.retryBackoffBaseMs`: the first wait before a retry of a request
	 * that went unanswered, doubling for each further coordinator tried. Exactly the declared round
	 * trip, and 0 — no wait, every retry at once — when none is declared, with no floor: a node on the
	 * LAN deadlines sends a retry over a link whose queue does not hold its predecessor back. The node
	 * applies it once itself, as its coordinator's first hold after a read-repair consult a silent
	 * cohort peer left unarmed (`CoordinatorRepoConfig.retryBackoffBaseMs`). `rpcDeadlines` does not
	 * move it.
	 */
	retryBackoffBaseMs: number;
};

/**
 * How many link round trips each derived deadline allows. A relayed dial whose connection to the relay
 * is already open costs about four (the hop, the stop and the relayed upgrade); one through a relay
 * this node is NOT connected to opens that connection first, from inside libp2p's per-address limit,
 * and costs up to about 6.6 (`test/cold-relayed-dial-fits-the-address-limit.spec.ts`, with the whole
 * round trip on the dialer's leg to the relay). That measurement leaves out the socket setup on the
 * dialer's leg, which adds one leg round trip for TCP, one more for a WebSocket upgrade and one more
 * for TLS 1.3 under `wss`. The leg's round trip is bounded by the declared one, since it is one hop of
 * the relayed path the declaration covers (an overestimate, but the only number there is), so a cold
 * open costs up to about 8.6 round trips over WebSocket and 9.6 over `wss`. Opening a stream costs one
 * more, even on a connection that is already open (`test/stream-open-costs-a-round-trip.spec.ts`).
 *
 * Every deadline that covers a connection open is sized for the cold path, because libp2p takes one
 * `addressDialTimeout` for every address of every dial and cannot be told which ones are cold. What a
 * longer limit costs is only that a dial that is going to fail fails later.
 *
 * - connection open (the per-address limit, and libp2p's `dialTimeout`): the cold open over WebSocket
 *   (8.6) plus margin; `wss` (9.6) still fits.
 * - dial: the cold open (10) + stream negotiation (1). The margin is already in the 10.
 * - inbound upgrade: the listener's timer runs over its own upgrade only (the relay's upgrade of the
 *   dialer's connection, or the target's upgrade of the relayed one after the stop), never over a
 *   relay connection the dialer had to open first, so it keeps the warm open (4) + one of margin.
 * - response: request plus reply is one; the rest covers payload transfer and the peer's own work.
 * - cohort query: negotiation plus request is two on a reused connection. A fresh relayed connection
 *   does not fit, which is safe: the peer is counted silent and the read is flagged, not misreported.
 * - transaction: counted in dial deadlines, since dials dominate its cost: one dial to a dead
 *   coordinator that runs out its deadline, the cold dial to the coordinator picked next, that
 *   coordinator's own cold dial to a cohort member, and a fourth for the warm round trips of the
 *   consensus rounds.
 * - bootstrap contact: the connection open the start-up bootstrap dial runs under (10), then
 *   identify on that connection: one to open its stream and one for the reply. It floors at the
 *   connection deadline's own floor, whose margin on a fast link covers identify.
 * - stream hedge: one and a half, so a connection whose negotiation runs a little past one round
 *   trip is merely slow and keeps its chance, while a dead one costs half a round trip on top of the
 *   live one's negotiation. The residual on a declared link: a cohort consult (3) that meets a dead
 *   connection first spends 1.5 on the hedge, 1 negotiating and 1 on the request over the live one,
 *   3.5 of its 3, so that one consult can still miss. The dead connection is then aborted within
 *   the dial deadline and the next consult succeeds. The floors leave an undeclared link 250 ms of
 *   its 1000.
 * - dead connection: the dial deadline itself, the bound already placed on one connection open plus
 *   negotiation; it follows an explicit `rpcDeadlines.dialTimeoutMs` as the transfer budget does.
 * - retry backoff base: one round trip, the time a retry waits so it stops lengthening the send queue
 *   its predecessor is still in; the one value with no floor, 0 when undeclared (no wait).
 */
const CONNECTION_ROUND_TRIPS = 10;
const DIAL_ROUND_TRIPS = CONNECTION_ROUND_TRIPS + 1;
const INBOUND_UPGRADE_ROUND_TRIPS = 5;
const RESPONSE_ROUND_TRIPS = 3;
const COHORT_QUERY_ROUND_TRIPS = 3;
const TRANSACTION_DIALS = 4;
const BOOTSTRAP_CONTACT_ROUND_TRIPS = CONNECTION_ROUND_TRIPS + 2;
const STREAM_HEDGE_ROUND_TRIPS = 1.5;

/**
 * The largest delay `setTimeout` accepts on every platform this runs on; a larger one fires almost
 * at once (see `MAX_COHORT_QUERY_TIMEOUT_MS` in `cluster/cluster-policy.ts`).
 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * The largest `linkRoundTripMs` a node accepts, in milliseconds (about 13 hours). The largest value
 * derived from it is the transaction budget (forty-four round trips), and that reaches timers: a
 * `RepoClient` arms one for what is left of the expiration the budget stamps, and a cluster member
 * arms one 5 s past that expiration. So the ceiling is the 32-bit delay `setTimeout` accepts divided
 * by the transaction budget's round trips plus one of headroom for those few seconds, and every other
 * derived delay (the reconcile pass bound's fifteen round trips included) then fits too.
 */
export const MAX_LINK_ROUND_TRIP_MS = Math.floor(MAX_TIMER_DELAY_MS / (TRANSACTION_DIALS * DIAL_ROUND_TRIPS + 1));

/**
 * The largest explicit `rpcDeadlines.dialTimeoutMs` a node accepts, in milliseconds (about 5 days).
 * The transaction budget is {@link TRANSACTION_DIALS} dials, and it reaches timers the same way it
 * does under {@link MAX_LINK_ROUND_TRIP_MS}: a `RepoClient` arms one for what is left of the
 * expiration the budget stamps, and a cluster member arms one 5 s past that expiration. So the
 * ceiling is the 32-bit delay `setTimeout` accepts divided by those dials plus one of headroom: for
 * any dial of at least 5000 ms, `4 × dial + 5000` is at most `5 × dial`, and below 5000 the sum is
 * far under the limit.
 */
export const MAX_RPC_DIAL_TIMEOUT_MS = Math.floor(MAX_TIMER_DELAY_MS / (TRANSACTION_DIALS + 1));

/**
 * Derive every network deadline from the slowest round trip, in milliseconds, between any two
 * nodes that will talk to each other, relayed hops included. Undeclared (`undefined`) yields
 * exactly the undeclared constants, because every derived value floors at the constant it replaces:
 * a node that declares nothing, or declares a round trip fast enough that no multiple exceeds its
 * floor, behaves as it did before the declaration existed.
 *
 * `rpcDeadlines` sets the RPC dial and response deadlines exactly, in place of the derived ones and
 * with no floor (`NodeOptions.rpcDeadlines`). It is applied before the transfer and transaction
 * budgets are derived, so both follow an explicit dial; each keeps its own floor.
 *
 * NOTE: a declared value that is not a finite number above zero, or is above its ceiling
 * ({@link MAX_LINK_ROUND_TRIP_MS} for the round trip, {@link MAX_RPC_DIAL_TIMEOUT_MS} for the dial,
 * the 32-bit timer limit for the response), THROWS rather than falling back to the undeclared
 * deadlines, for the reason `resolveCohortQueryTimeoutMs` gives: the one deployment that declared
 * this field did so to escape the LAN deadlines, and a silent fallback would keep them. A fractional
 * value is accepted. An RPC deadline of `0`, which {@link withRpcDeadlineDefaults} reads as "no
 * cap" on a single request, is refused here: no cap is not a policy for a whole node.
 */
export function resolveLinkDeadlines(linkRoundTripMs?: number, rpcDeadlines?: Partial<RpcDeadlineDefaults>): LinkDeadlines {
	const roundTripMs = linkRoundTripMs === undefined
		? 0
		: validDeclaredMs('linkRoundTripMs', linkRoundTripMs, MAX_LINK_ROUND_TRIP_MS);
	const dialTimeoutMs = rpcDeadlines?.dialTimeoutMs === undefined
		? Math.max(DEFAULT_DIAL_TIMEOUT_MS, DIAL_ROUND_TRIPS * roundTripMs)
		: validDeclaredMs('rpcDeadlines.dialTimeoutMs', rpcDeadlines.dialTimeoutMs, MAX_RPC_DIAL_TIMEOUT_MS);
	const responseTimeoutMs = rpcDeadlines?.responseTimeoutMs === undefined
		? Math.max(DEFAULT_RESPONSE_TIMEOUT_MS, RESPONSE_ROUND_TRIPS * roundTripMs)
		// Nothing is derived from it; it reaches one `setTimeout` directly (`ProtocolClient.processMessage`).
		: validDeclaredMs('rpcDeadlines.responseTimeoutMs', rpcDeadlines.responseTimeoutMs, MAX_TIMER_DELAY_MS);
	return {
		dialTimeoutMs,
		responseTimeoutMs,
		libp2pDialTimeoutMs: Math.max(DEFAULT_LIBP2P_DIAL_TIMEOUT_MS, CONNECTION_ROUND_TRIPS * roundTripMs),
		inboundUpgradeTimeoutMs: Math.max(DEFAULT_INBOUND_UPGRADE_TIMEOUT_MS, INBOUND_UPGRADE_ROUND_TRIPS * roundTripMs),
		addressDialTimeoutMs: Math.max(DEFAULT_ADDRESS_DIAL_TIMEOUT_MS, CONNECTION_ROUND_TRIPS * roundTripMs),
		cohortQueryTimeoutMs: Math.max(DEFAULT_COHORT_QUERY_TIMEOUT_MS, COHORT_QUERY_ROUND_TRIPS * roundTripMs),
		// A transfer is a dial like any other, so it may never be the shorter of the two.
		transferTimeoutMs: Math.max(DEFAULT_TRANSFER_TIMEOUT_MS, dialTimeoutMs),
		transactionTimeoutMs: Math.max(DEFAULT_TRANSACTION_TIMEOUT_MS, TRANSACTION_DIALS * dialTimeoutMs),
		bootstrapContactTimeoutMs: Math.max(DEFAULT_LIBP2P_DIAL_TIMEOUT_MS, BOOTSTRAP_CONTACT_ROUND_TRIPS * roundTripMs),
		hedgeDelayMs: Math.max(DEFAULT_STREAM_HEDGE_DELAY_MS, STREAM_HEDGE_ROUND_TRIPS * roundTripMs),
		deadConnectionDelayMs: dialTimeoutMs,
		retryBackoffBaseMs: roundTripMs,
	};
}

/**
 * The bootstrap contact wait a node applies: `NodeOptions.bootstrapContactTimeoutMs` when declared,
 * else the value derived from the link round trip. `0` is accepted and means "never wait". Any
 * other value that is not a finite number of milliseconds within the 32-bit timer limit throws,
 * for the reason {@link resolveLinkDeadlines} gives.
 */
export function resolveBootstrapContactTimeoutMs(declared: number | undefined, deadlines: LinkDeadlines): number {
	if (declared === undefined) return deadlines.bootstrapContactTimeoutMs;
	if (!Number.isFinite(declared) || declared < 0 || declared > MAX_TIMER_DELAY_MS) {
		throw new Error(
			`bootstrapContactTimeoutMs must be a finite number of milliseconds from 0 to ${MAX_TIMER_DELAY_MS}; got ${String(declared)}`
		);
	}
	return declared;
}

/**
 * The whole-dial deadline a node applies: `NodeOptions.connectionManager.dialTimeout` when declared,
 * else `LinkDeadlines.libp2pDialTimeoutMs`. One value serves two consumers — libp2p's connection
 * manager, and FRET's maintenance redial, which always dials with a signal and so is never reached
 * by libp2p's limit.
 *
 * A declared value that is not a finite number above zero, or is above the 32-bit timer limit,
 * throws. libp2p alone would take `0` and arm `AbortSignal.timeout(0)` on every signal-less dial,
 * failing each at once, and FRET's constructor refuses it — but only at `node.start()`, under a
 * name (`dialTimeoutMs`) the host never set. Refusing it here names the option the host did set,
 * before the node has acquired anything.
 */
export function resolveLibp2pDialTimeoutMs(declared: number | undefined, deadlines: LinkDeadlines): number {
	return declared === undefined
		? deadlines.libp2pDialTimeoutMs
		: validDeclaredMs('connectionManager.dialTimeout', declared, MAX_TIMER_DELAY_MS);
}

/**
 * How long `@libp2p/ping` lets an inbound ping stream live before aborting it, on a node that neither
 * declares one nor declares a connection-monitor deadline. Equal to `@libp2p/ping`'s own `TIMEOUT`,
 * stated here so the fallback does not move with that package.
 */
export const DEFAULT_PING_HANDLER_TIMEOUT_MS = 10_000;

/**
 * libp2p's `AdaptiveTimeout` default `maxTimeout`, which caps the connection monitor's deadline when a
 * node declares a `pingTimeout` without one. Stated here so the derivation does not move with libp2p.
 */
export const LIBP2P_DEFAULT_PING_MAX_TIMEOUT_MS = 60_000;

/** The part of libp2p's `ConnectionMonitorInit` the ping handler timeout is derived from. */
export type DeclaredPingDeadline = { pingTimeout?: { minTimeout?: number; maxTimeout?: number } };

/**
 * The timeout this node's ping service puts on every inbound ping stream (`NodeOptions.pingHandlerTimeoutMs`).
 *
 * The answering side's timer runs over the whole stream — echo, waiting for the pinger to close, and
 * the final close — and when it fires first it resets the stream, which the pinging node's connection
 * monitor cannot tell from a dead peer, so it aborts the connection. So a deadline the pinger declares
 * is capped at the answerer's handler timeout. Declared → used exactly as given, never raised (an
 * embedder who sets it low has decided). Undeclared with a monitor deadline declared → twice that
 * deadline's ceiling (strictly above it, with room for the close), floored at the library default and
 * capped at the 32-bit timer limit; this assumes the remote's monitor is configured like this node's.
 * Otherwise → {@link DEFAULT_PING_HANDLER_TIMEOUT_MS}, today's behaviour.
 *
 * NOTE: an unconfigured libp2p monitor's adaptive deadline can rise toward its own 60 s default
 * `maxTimeout` for one slow ping, so even a stock pair can in principle meet the 10 s handler cap; the
 * undeclared default is left at 10 s on purpose. If stock-config deployments report reset-driven
 * aborts (`aborting connection due to ping failure` with a stream reset or unexpected EOF), derive
 * from libp2p's default max too.
 */
export function resolvePingHandlerTimeoutMs(declared: number | undefined, connectionMonitor: DeclaredPingDeadline | undefined): number {
	if (declared !== undefined) return validDeclaredMs('pingHandlerTimeoutMs', declared, MAX_TIMER_DELAY_MS);
	const monitorCeiling = declaredMonitorDeadlineCeiling(connectionMonitor);
	return monitorCeiling === undefined
		? DEFAULT_PING_HANDLER_TIMEOUT_MS
		: Math.min(MAX_TIMER_DELAY_MS, Math.max(DEFAULT_PING_HANDLER_TIMEOUT_MS, 2 * monitorCeiling));
}

/**
 * The longest deadline a declared connection monitor can give one ping, or `undefined` when the node
 * declares neither bound. libp2p raises the adaptive deadline to `minTimeout` and only then caps it at
 * `maxTimeout`, so the ceiling is `maxTimeout` — libp2p's own default when it is undeclared or unusable,
 * since that default is what libp2p then applies. A node that declares only `minTimeout` therefore
 * derives from 60 s, not from nothing: its monitor waits at least that `minTimeout`, so a 10 s handler
 * would cut it off.
 */
function declaredMonitorDeadlineCeiling(connectionMonitor: DeclaredPingDeadline | undefined): number | undefined {
	const pingTimeout = connectionMonitor?.pingTimeout;
	if (pingTimeout?.minTimeout === undefined && pingTimeout?.maxTimeout === undefined) return undefined;
	const max = pingTimeout.maxTimeout;
	return max !== undefined && Number.isFinite(max) && max > 0 ? max : LIBP2P_DEFAULT_PING_MAX_TIMEOUT_MS;
}

function validDeclaredMs(field: string, declared: number, ceiling: number): number {
	if (!Number.isFinite(declared) || declared <= 0 || declared > ceiling) {
		throw new Error(
			`${field} must be a finite number of milliseconds above 0 and no greater than ${ceiling}; got ${String(declared)}`
		);
	}
	return declared;
}

/**
 * Merge caller-supplied deadline options with the client's fallback deadlines. An
 * explicitly-supplied value wins (including a deliberate `0`, which
 * {@link ProtocolClient.processMessage} reads as "no cap"); an absent key falls
 * back to the client's so a caller that passes nothing still gets a deadline.
 * `signal` has no default — cancellation is always caller-driven.
 *
 * Unlike `BlockTransferClient` (which leaves its defaults to the owning
 * `SpreadOnChurnMonitor` config), these clients have many callers and no single
 * owning monitor, so the fallback belongs on the client instance, set by whoever builds it.
 */
export function withRpcDeadlineDefaults(options: RpcDeadlineOptions | undefined, defaults: RpcDeadlineDefaults): RpcDeadlineOptions {
	return {
		dialTimeoutMs: options?.dialTimeoutMs ?? defaults.dialTimeoutMs,
		responseTimeoutMs: options?.responseTimeoutMs ?? defaults.responseTimeoutMs,
		signal: options?.signal,
	};
}

/**
 * The abort reason of a request run under {@link withinRequestBudget} when its budget expires.
 * Distinct from `DialTimeoutError` and `ResponseTimeoutError`, which name one phase of a request
 * and a client default: this names the caller's own budget for the whole request.
 * `.code === REQUEST_BUDGET_EXCEEDED_ERROR_CODE`.
 */
export const REQUEST_BUDGET_EXCEEDED_ERROR_CODE = 'REQUEST_BUDGET_EXCEEDED';

export class RequestBudgetExceededError extends Error {
	readonly code = REQUEST_BUDGET_EXCEEDED_ERROR_CODE;
	constructor(peer: string, protocol: string, budgetMs: number) {
		super(`request budget exceeded: peer=${peer} protocol=${protocol} after ${budgetMs}ms`);
		this.name = 'RequestBudgetExceededError';
	}
}

/**
 * Run one RPC to `peer` with `budgetMs` as the only limit on it: dial, stream negotiation, request
 * and reply all share the one budget, and nothing inside the request is shorter.
 *
 * For a caller that owns a per-peer budget of its own. The client defaults cannot simply be left
 * underneath it: opening a stream costs one link round trip even on a connection that is already
 * open (`test/stream-open-costs-a-round-trip.spec.ts`), so on a link whose round trip reaches
 * {@link DEFAULT_DIAL_TIMEOUT_MS} the default dial deadline fails every request that has to negotiate
 * its stream (the first to a peer after a quiet spell; later ones take a prepared stream), and a larger
 * budget above it never takes effect. So `request` receives explicit `0`s for both phase deadlines
 * ("no cap", see {@link withRpcDeadlineDefaults}) and a signal that aborts with a
 * {@link RequestBudgetExceededError} once the budget runs out. `ProtocolClient.processMessage`
 * forwards that signal to the dial and aborts the stream with it during the read, so an expired
 * request is torn down rather than left running to a later default.
 *
 * The signal is built from an `AbortController` and a timer rather than `AbortSignal.timeout`,
 * which Hermes (React Native's JS engine) does not provide. The timer is cleared on either outcome,
 * so a peer that answers quickly leaves nothing pending for the rest of the budget, and it is
 * `unref`'d where the platform supports that.
 */
export async function withinRequestBudget<T>(
	peer: string,
	protocol: string,
	budgetMs: number,
	request: (options: RpcDeadlineOptions) => Promise<T>
): Promise<T> {
	const controller = new AbortController();
	const timer = unrefTimer(setTimeout(() => controller.abort(new RequestBudgetExceededError(peer, protocol, budgetMs)), budgetMs));
	try {
		return await request({ signal: controller.signal, dialTimeoutMs: 0, responseTimeoutMs: 0 });
	} finally {
		clearTimeout(timer);
	}
}
