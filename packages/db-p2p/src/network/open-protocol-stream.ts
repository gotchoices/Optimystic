/**
 * The single place in `db-p2p` that opens a libp2p protocol stream.
 *
 * libp2p refuses to open a protocol stream over a *limited* (circuit-relay) connection unless the
 * caller opts in with `runOnLimitedConnection: true`. Omitting it produces no compile error and no
 * obvious failure — only "that peer never answers" — so every peer reachable only through a relay
 * (the steady state for browsers, phones, and NATed peers) silently drops out. The flag is
 * deliberately NOT an option here: a new call site gets relay support without its author needing to
 * know the flag exists, and `test/dial-options-single-site.spec.ts` fails the build if a second
 * source file calls `dialProtocol` / `newStream` directly.
 *
 * NOTE: accepted tradeoff — this duplicates FRET's `rpc/protocols.ts#openRpcStream` (exported since
 * `p2p-fret@1.0.0-beta.3`) rather than delegating to it. FRET's helper pins `negotiateFully: false`
 * with no way to opt out, and `cohort-topic/stream-util.ts` deliberately does not set that option
 * (see the NOTE at its call sites); adopting FRET's would silently reverse a decision a human
 * already made. It also has no hook for the pre-dial check `libp2p-key-network.ts#connect` runs.
 * Revisit — and delete this module in favour of `openRpcStream` — if FRET ever parameterizes
 * `negotiateFully`.
 *
 * Imports here are type-only on purpose: this module is reachable from the react-native entry
 * (`src/rn.ts`) via `libp2p-key-network.ts`, which must not pull node-specific code.
 */

import type { Libp2p } from "libp2p";
import type { Connection, PeerId, Stream } from "@libp2p/interface";

export interface OpenProtocolStreamOptions {
	/** Forwarded to libp2p so a caller's deadline cancels both the connection reuse and the dial. */
	signal?: AbortSignal;
	/**
	 * Omit for libp2p's default (full multistream-select negotiation at stream-open).
	 * Pass `false` to save the round trip, accepting that an unsupported-protocol failure is
	 * deferred to the first read — only safe when the caller always reads a reply.
	 */
	negotiateFully?: boolean;
	/**
	 * Runs immediately before a FRESH dial, and never on the connection-reuse path.
	 * Throwing aborts the open. This is the seam for checks that are only meaningful when no
	 * connection exists yet (see `libp2p-key-network.ts#assertNotSelfRelayOnly`).
	 */
	beforeDial?: () => Promise<void> | void;
}

/**
 * True for a circuit-relay ("limited") connection: libp2p stamps one with per-circuit `limits`
 * (data/duration caps); sniffing `/p2p-circuit` in the remote multiaddr covers transports and
 * versions that leave `limits` unpopulated.
 */
export function isLimitedConnection(c: Connection): boolean {
	if (c.limits != null) return true;
	return c.remoteAddr?.toString?.().includes("/p2p-circuit") ?? false;
}

/**
 * Open `protocol` to `peer`, reusing a healthy existing connection when there is one.
 *
 * Skips connections libp2p has not yet evicted from its index but that are no longer open, and
 * prefers a direct connection over a relayed one — a relayed connection can be reset once the
 * relay's per-circuit cap or reservation lapses, and after DCUtR upgrades a link to direct both
 * briefly coexist. Falls back to the relayed connection when it is the only open path.
 */
export async function openProtocolStream(
	node: Libp2p,
	peer: PeerId,
	protocol: string,
	options?: OpenProtocolStreamOptions,
): Promise<Stream> {
	// Before touching connections: a caller that has already given up is owed its own reason,
	// not whatever libp2p would report several layers down.
	options?.signal?.throwIfAborted();

	const conns = node.getConnections?.(peer) ?? [];
	const open = conns.filter(c => c?.status === "open" && typeof c?.newStream === "function");
	const chosen = open.find(c => !isLimitedConnection(c)) ?? open[0];

	// Keys are OMITTED rather than set to `undefined` when the caller did not supply them, so
	// libp2p applies its own defaults instead of seeing an explicit `undefined`.
	const streamOptions = {
		runOnLimitedConnection: true,
		...(options?.negotiateFully !== undefined ? { negotiateFully: options.negotiateFully } : {}),
		...(options?.signal !== undefined ? { signal: options.signal } : {}),
	};

	if (chosen) return await chosen.newStream([protocol], streamOptions);
	await options?.beforeDial?.();
	return await node.dialProtocol(peer, [protocol], streamOptions);
}
