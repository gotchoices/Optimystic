// Re-exported so an app can build a `NodeOptions.connectionMonitor` without depending on `libp2p`
// itself at the major this package is built against.
export type { ConnectionMonitorInit as Libp2pConnectionMonitorInit } from 'libp2p';
