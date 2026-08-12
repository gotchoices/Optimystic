import debug from 'debug'

const BASE_NAMESPACE = 'optimystic:db-p2p'

/**
 * Build a `debug` logger under `optimystic:db-p2p:<subNamespace>`, optionally suffixed with the
 * owning node's peer id (`:<first 12 chars>`) so lines from several nodes sharing one process —
 * every integration test — are attributable. Omit `peerId` and the namespace is byte-for-byte the
 * un-suffixed one, so callers that don't know their peer id are unaffected.
 *
 * NOTE: 12 chars matches the truncation the rest of this package already uses in log payloads, but
 * every Ed25519 peer id starts with the constant `12D3KooW`, so only ~4 base58 characters actually
 * distinguish nodes (~11M combinations — ample for the handful of nodes a test process runs).
 * Widen this only if a run ever needs to match a namespace against a full peer id.
 *
 * NOTE: only the two classes the diagnosability ticket named pass a peer id today
 * (`Libp2pKeyPeerNetwork`, `CoordinatorRepo`); the package's other ~30 `createLogger` call sites
 * still log under a flat namespace. Thread a peer id through any of them if a future diagnosis
 * needs per-node attribution from that subsystem — the mechanism is already here.
 */
export function createLogger(subNamespace: string, peerId?: string): debug.Debugger {
	const suffix = peerId ? `:${peerId.substring(0, 12)}` : ''
	return debug(`${BASE_NAMESPACE}:${subNamespace}${suffix}`)
}

export const verbose = typeof process !== 'undefined'
	&& (process.env.OPTIMYSTIC_VERBOSE === '1' || process.env.OPTIMYSTIC_VERBOSE === 'true');
