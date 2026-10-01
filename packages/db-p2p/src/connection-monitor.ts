import type { ConnectionManagerInit } from 'libp2p';

// Re-exported so an app can build a `NodeOptions.connectionMonitor` without depending on `libp2p`
// itself at the major this package is built against.
export type { ConnectionMonitorInit as Libp2pConnectionMonitorInit } from 'libp2p';

/** The connection-manager deadlines `NodeOptions.connectionManager` passes through to libp2p. */
export type Libp2pConnectionTimeouts = Pick<ConnectionManagerInit, 'dialTimeout' | 'inboundUpgradeTimeout' | 'addressDialTimeout'>;
