import { DEFAULT_COHORT_QUERY_TIMEOUT_MS } from '@optimystic/db-core';
import { MAX_COHORT_QUERY_TIMEOUT_MS } from './cluster/cluster-policy.js';

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
 * libp2p's connection-manager `dialTimeout` and `inboundUpgradeTimeout` on a node that declares no
 * link round trip, and the floor of the derived one. Equal to libp2p's own defaults, but stated here
 * so the fallback does not move with libp2p.
 */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Per-peer deadline, on the dial and again on the reply, for the rebalance reaction's pushes and
 * confirms (`BlockTransferCoordinator`), on a node that declares no link round trip; the floor of
 * the derived one.
 */
export const DEFAULT_TRANSFER_TIMEOUT_MS = 30_000;

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
 * (`NodeOptions.linkRoundTripMs`). All in milliseconds.
 */
export type LinkDeadlines = RpcDeadlineDefaults & {
	/** libp2p's connection-manager `dialTimeout` and `inboundUpgradeTimeout`: opening a connection, both ends. */
	connectionTimeoutMs: number;
	/** `clusterPolicy.cohortQueryTimeoutMs` when that field is not declared. */
	cohortQueryTimeoutMs: number;
	/** `BlockTransferCoordinator`'s per-peer `transferTimeoutMs`. */
	transferTimeoutMs: number;
};

/**
 * How many link round trips each derived deadline allows. Opening a relayed connection costs about
 * four (eight one-way delays), and opening a stream on it costs one more, even on a connection that
 * is already open (`test/stream-open-costs-a-round-trip.spec.ts`).
 *
 * - dial: connection open (4) + stream negotiation (1) + one of margin.
 * - response: request plus reply is one; the rest covers payload transfer and the peer's own work.
 * - connection: connection open only (4) + one of margin.
 * - cohort query: negotiation plus request is two on a reused connection. A fresh relayed connection
 *   does not fit, which is safe: the peer is counted silent and the read is flagged, not misreported.
 */
const DIAL_ROUND_TRIPS = 6;
const RESPONSE_ROUND_TRIPS = 3;
const CONNECTION_ROUND_TRIPS = 5;
const COHORT_QUERY_ROUND_TRIPS = 3;

/**
 * The largest `linkRoundTripMs` a node accepts, in milliseconds (about 1.66 days). The largest delay
 * derived from it is the reconcile pass bound built on the derived cohort budget, which has to fit
 * the 32-bit delay `setTimeout` accepts — the same limit {@link MAX_COHORT_QUERY_TIMEOUT_MS} states
 * for a declared cohort budget. So the ceiling is that cohort ceiling divided by the cohort budget's
 * multiple, and every derived value (the dial deadline's six round trips included) then fits too.
 */
export const MAX_LINK_ROUND_TRIP_MS = Math.floor(MAX_COHORT_QUERY_TIMEOUT_MS / COHORT_QUERY_ROUND_TRIPS);

/**
 * Derive every network deadline from the slowest round trip, in milliseconds, between any two
 * nodes that will talk to each other, relayed hops included. Undeclared (`undefined`) yields
 * exactly the undeclared constants, because every derived value floors at the constant it replaces:
 * a node that declares nothing, or declares a round trip fast enough that no multiple exceeds its
 * floor, behaves as it did before the declaration existed.
 *
 * NOTE: a declared value that is not a finite number above zero, or is above
 * {@link MAX_LINK_ROUND_TRIP_MS}, THROWS rather than falling back to the undeclared deadlines, for
 * the reason `resolveCohortQueryTimeoutMs` gives: the one deployment that declared this field did so
 * to escape the LAN deadlines, and a silent fallback would keep them. A fractional value is accepted.
 */
export function resolveLinkDeadlines(linkRoundTripMs?: number): LinkDeadlines {
	const roundTripMs = linkRoundTripMs === undefined ? 0 : validLinkRoundTripMs(linkRoundTripMs);
	const dialTimeoutMs = Math.max(DEFAULT_DIAL_TIMEOUT_MS, DIAL_ROUND_TRIPS * roundTripMs);
	return {
		dialTimeoutMs,
		responseTimeoutMs: Math.max(DEFAULT_RESPONSE_TIMEOUT_MS, RESPONSE_ROUND_TRIPS * roundTripMs),
		connectionTimeoutMs: Math.max(DEFAULT_CONNECTION_TIMEOUT_MS, CONNECTION_ROUND_TRIPS * roundTripMs),
		cohortQueryTimeoutMs: Math.max(DEFAULT_COHORT_QUERY_TIMEOUT_MS, COHORT_QUERY_ROUND_TRIPS * roundTripMs),
		// A transfer is a dial like any other, so it may never be the shorter of the two.
		transferTimeoutMs: Math.max(DEFAULT_TRANSFER_TIMEOUT_MS, dialTimeoutMs),
	};
}

function validLinkRoundTripMs(declared: number): number {
	if (!Number.isFinite(declared) || declared <= 0 || declared > MAX_LINK_ROUND_TRIP_MS) {
		throw new Error(
			`linkRoundTripMs must be a finite number of milliseconds above 0 and no greater than ${MAX_LINK_ROUND_TRIP_MS}; got ${String(declared)}`
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
	const timer = setTimeout(() => controller.abort(new RequestBudgetExceededError(peer, protocol, budgetMs)), budgetMs);
	(timer as { unref?: () => void }).unref?.();
	try {
		return await request({ signal: controller.signal, dialTimeoutMs: 0, responseTimeoutMs: 0 });
	} finally {
		clearTimeout(timer);
	}
}
