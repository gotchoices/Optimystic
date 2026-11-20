/**
 * Shared multiaddr selection for the specs here that dial one spawned libp2p node from another.
 *
 * Three specs had grown their own identical copy of it (`two-node-blob-reference`,
 * `network-change-notification`, `two-node-secondary-index-libp2p`). `packages/db-p2p` keeps the same
 * function for its own specs in `test/util/multiaddrs.ts`, whose own history says why: the copies
 * there had drifted, so one node's address list failed in one spec and passed in another for no
 * reason a reader could see. That file is not importable from here — db-p2p publishes `src/testing`,
 * not its test tree — so this is the second copy in the repo rather than the fourth.
 */
import type { Libp2p } from 'libp2p';

/**
 * A dialable TCP multiaddr for `node`, preferring loopback.
 *
 * Nodes in these specs listen on `/ip4/0.0.0.0/tcp/0`, which libp2p expands per interface, so the
 * loopback entry is normally present and is the one that dials fastest. The fallback covers listen
 * configurations that produce no loopback entry at all.
 *
 * Throws rather than returning undefined, with the whole list in the message: a spec that cannot find
 * an address is broken, not degraded, and the reason should be visible without a re-run.
 */
export function pickLocalTcpMultiaddr(node: Libp2p): string {
	const addrs = node.getMultiaddrs().map(a => a.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/'))
		?? addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No usable TCP multiaddr; have: ${addrs.join(', ')}`);
	return local;
}
