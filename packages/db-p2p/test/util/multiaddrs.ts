/**
 * Shared multiaddr selection for specs that dial one spawned node from another.
 *
 * Every integration spec that boots a real node needs the same thing — "give me an address I can
 * dial from this process" — and each had grown its own copy. The copies had drifted (one required a
 * `/p2p/` suffix on the loopback branch, the rest did not), so a node whose address list differed
 * slightly would fail in one spec and pass in another for no reason a reader could see.
 */
import type { Libp2p } from 'libp2p';

/**
 * A dialable TCP multiaddr for `node`, preferring loopback.
 *
 * Nodes in these specs listen on `/ip4/0.0.0.0/tcp/0`, which libp2p expands per interface, so the
 * loopback entry is normally present and is the one that dials fastest and most predictably. The
 * fallback covers listen configurations that produce no loopback entry at all.
 *
 * Throws rather than returning undefined: a spec that cannot find an address is broken, not
 * degraded, and the message carries the full list so the reason is visible without a re-run.
 *
 * For relay specs see `pickRelayTcpAddr` in `./relay-topology.js` — it deliberately EXCLUDES
 * WebSocket and circuit addresses and returns a `Multiaddr`, so it is not the same function.
 */
export function pickLocalTcpMultiaddr(node: Libp2p): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
		?? addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No usable TCP multiaddr on node; have: ${addrs.join(', ')}`);
	return local;
}
