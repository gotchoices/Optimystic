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
export type LinkDeadlines = RpcDeadlineDefaults & {
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
 */
const CONNECTION_ROUND_TRIPS = 10;
const DIAL_ROUND_TRIPS = CONNECTION_ROUND_TRIPS + 1;
const INBOUND_UPGRADE_ROUND_TRIPS = 5;
const RESPONSE_ROUND_TRIPS = 3;
const COHORT_QUERY_ROUND_TRIPS = 3;
const TRANSACTION_DIALS = 4;
const BOOTSTRAP_CONTACT_ROUND_TRIPS = CONNECTION_ROUND_TRIPS + 2;

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
 * {@link DEFAULT_DIAL_TIMEOUT_MS} the default dial deadline fails every request, and a larger
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
