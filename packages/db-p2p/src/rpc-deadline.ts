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
