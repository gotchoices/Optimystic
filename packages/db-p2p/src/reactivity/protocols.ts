/**
 * Reactivity libp2p protocol IDs (`docs/reactivity.md` §Propagation / §Notification origination).
 *
 * The reactivity family rides the same FRET/libp2p node as the cohort-topic substrate it is layered on:
 *
 * - `notify`            — `NotificationV1` fan-out down the reactivity tree (one-way, fire-and-forget).
 * - `push-state-gossip` — `PushStateGossipV1` intra-cohort push-state convergence (one-way). Declared
 *                         here so one place owns the family; the `reactivity-pushstate-gossip` ticket
 *                         consumes it.
 * - `recover`           — `RecoverRequestV1`/`RecoverReplyV1` backfill/resume recovery RPC
 *                         (request-reply, one frame each way). Consumed by `reactivity-recover-rpc-transport`.
 *
 * The default (network-agnostic) IDs omit the network segment; {@link makeReactivityProtocols} mirrors
 * FRET's `makeProtocols(networkName)` so a named network namespaces its reactivity protocols the same way
 * FRET namespaces its routing protocols (and the cohort-topic family namespaces via
 * {@link import("../cohort-topic/protocols.js").makeCohortTopicProtocols}).
 */

/** Base path for the reactivity protocol family. */
export const REACTIVITY_BASE = "/optimystic/reactivity/1.0.0" as const;

/** `NotificationV1` — change-notification fan-out down the reactivity tree (one-way). */
export const PROTOCOL_REACTIVITY_NOTIFY = `${REACTIVITY_BASE}/notify` as const;
/** `PushStateGossipV1` — intra-cohort push-state convergence (one-way) [used by reactivity-pushstate-gossip]. */
export const PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP = `${REACTIVITY_BASE}/push-state-gossip` as const;
/** `RecoverRequestV1`/`RecoverReplyV1` — backfill/resume recovery RPC (request-reply) [used by reactivity-recover-rpc-transport]. */
export const PROTOCOL_REACTIVITY_RECOVER = `${REACTIVITY_BASE}/recover` as const;

/** The reactivity protocol IDs in registration order. */
export interface ReactivityProtocols {
	readonly notify: string;
	readonly pushStateGossip: string;
	readonly recover: string;
}

/** Default (network-agnostic) protocol IDs, matching `docs/reactivity.md`. */
export const DEFAULT_REACTIVITY_PROTOCOLS: ReactivityProtocols = {
	notify: PROTOCOL_REACTIVITY_NOTIFY,
	pushStateGossip: PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP,
	recover: PROTOCOL_REACTIVITY_RECOVER,
};

/**
 * Namespaced reactivity protocol IDs for `networkName` (mirrors FRET's `makeProtocols`, which inserts the
 * network segment even for `"default"` → `/optimystic/default/...`). Note this does NOT equal
 * {@link DEFAULT_REACTIVITY_PROTOCOLS}: the canonical, network-agnostic IDs omit the segment entirely
 * (`/optimystic/reactivity/1.0.0/...`); use those unless you need per-network namespacing.
 */
export function makeReactivityProtocols(networkName = "default"): ReactivityProtocols {
	const base = `/optimystic/${networkName}/reactivity/1.0.0`;
	return {
		notify: `${base}/notify`,
		pushStateGossip: `${base}/push-state-gossip`,
		recover: `${base}/recover`,
	};
}

/** All reactivity protocol IDs as an array (for `node.handle` / `unhandle` over the set). */
export function reactivityProtocolList(p: ReactivityProtocols): string[] {
	return [p.notify, p.pushStateGossip, p.recover];
}
