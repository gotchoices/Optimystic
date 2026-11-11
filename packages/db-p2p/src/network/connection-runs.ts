/**
 * Which connection run each connected remote peer is on.
 *
 * A **connection run** is the span during which a remote peer has at least one open connection to
 * this node. It starts when a connection opens to a peer that had none, and ends when the peer's last
 * connection closes; the next connection starts a new run with a new id. A second connection opened
 * alongside the first keeps the run, so a relayed connection upgraded to a direct one (DCUtR) keeps
 * its run when the direct connection opens before the relayed one closes, and starts a new one when
 * it opens after. Two readings of a peer's run that agree prove its connectivity to this node did not
 * break between them, which is what `IKeyNetwork.connectedCohort` reports.
 *
 * Whether a peer still has a connection when one closes is asked of libp2p (`getConnections`), never
 * kept as a private open/close count that a missed or doubled event would leave wrong. libp2p's
 * connection manager drops a closing connection from that list in its own `connection:close`
 * listener, which it registers in its `start()`; this class is built after the node starts, so that
 * listener has already run. The closing connection is excluded by id anyway, so the answer does not
 * depend on listener order.
 *
 * The map holds connected peers only, so it is bounded by the connection count and needs no eviction.
 *
 * Imports here are type-only, like `peer-record-cache.ts`: this module is reachable from the
 * react-native entry (`src/rn.ts`) through `libp2p-key-network.ts`.
 */

import type { Connection, Libp2p } from "@libp2p/interface";

/** The node whose connections are tracked. `getConnections` may be absent at runtime: several test doubles build a node without one. */
export type ConnectionRunHost = Pick<Libp2p, "addEventListener"> & { getConnections?: Libp2p["getConnections"] };

export class ConnectionRuns {
	private readonly runs = new Map<string, number>();
	private lastRun = 0;

	constructor(private readonly host: ConnectionRunHost) {
		host.addEventListener("connection:open", evt => this.opened(evt.detail));
		host.addEventListener("connection:close", evt => this.closed(evt.detail));
		for (const connection of host.getConnections?.() ?? []) this.opened(connection);
	}

	/** The id of `peerId`'s current run, or `undefined` when it has no open connection to this node. */
	runOf(peerId: string): number | undefined {
		return this.runs.get(peerId);
	}

	private opened(connection: Connection): void {
		const peer = connection.remotePeer.toString();
		if (!this.runs.has(peer)) this.runs.set(peer, ++this.lastRun);
	}

	private closed(closing: Connection): void {
		const peer = closing.remotePeer.toString();
		if (this.runs.has(peer) && !this.connectedOtherThan(closing)) this.runs.delete(peer);
	}

	/** Does the closing connection's peer hold another connection libp2p still tracks? Filtered by peer too, for a double whose `getConnections` ignores its argument. */
	private connectedOtherThan(closing: Connection): boolean {
		const peer = closing.remotePeer.toString();
		return (this.host.getConnections?.(closing.remotePeer) ?? [])
			.some(c => c.id !== closing.id && c.remotePeer.toString() === peer);
	}
}
