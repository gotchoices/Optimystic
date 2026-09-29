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
 * Default per-peer dial deadline. Matches `spread-on-churn.ts` `pushDialTimeoutMs`
 * (3000ms) — an unreachable peer fails the dial fast so the caller can re-pick a
 * different coordinator rather than blocking on a dead route.
 */
export const DEFAULT_DIAL_TIMEOUT_MS = 3000;

/**
 * Default per-peer response deadline. Matches `spread-on-churn.ts`
 * `pushResponseTimeoutMs` (10000ms) — a peer that connects then never writes a
 * reply is abandoned instead of hanging the caller forever.
 */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 10000;

/**
 * Merge caller-supplied deadline options with the client-level defaults. An
 * explicitly-supplied value wins (including a deliberate `0`, which
 * {@link ProtocolClient.processMessage} reads as "no cap"); an absent key falls
 * back to the default so a caller that passes nothing still gets a deadline.
 * `signal` has no default — cancellation is always caller-driven.
 *
 * Unlike `BlockTransferClient` (which leaves its defaults to the owning
 * `SpreadOnChurnMonitor` config), these clients have many callers and no single
 * owning monitor, so the deadline default belongs here on the client.
 */
export function withRpcDeadlineDefaults(options?: RpcDeadlineOptions): RpcDeadlineOptions {
	return {
		dialTimeoutMs: options?.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS,
		responseTimeoutMs: options?.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
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
