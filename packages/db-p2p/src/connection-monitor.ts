import type { ConnectionManagerInit } from 'libp2p';

// Re-exported so an app can build a `NodeOptions.connectionMonitor` without depending on `libp2p`
// itself at the major this package is built against.
export type { ConnectionMonitorInit as Libp2pConnectionMonitorInit } from 'libp2p';

/** The connection-manager deadlines `NodeOptions.connectionManager` passes through to libp2p. */
export type Libp2pConnectionTimeouts = Pick<ConnectionManagerInit, 'dialTimeout' | 'inboundUpgradeTimeout'> & {
	/**
	 * The most one address of a peer may take to connect, inside any dial — including one that carries
	 * its own signal. Read by libp2p 3.3.0 and later (default 6000 ms there); stated here rather than
	 * picked from `ConnectionManagerInit` because the libp2p line this package builds against (3.1.x)
	 * predates the field and ignores it.
	 */
	addressDialTimeout?: number;
};
