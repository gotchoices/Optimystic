/**
 * Structured error envelope for the cluster protocol.
 *
 * When a cluster member throws while processing an `update` (validation,
 * signature, merge, or consensus failure), the service serializes the error as
 * this envelope and closes the stream normally instead of aborting it. The
 * coordinator's {@link ClusterClient} detects the envelope and rethrows a real
 * `Error` carrying the server's message/name/code — so the genuine cause is
 * visible on the coordinator side (which already enables `optimystic:*` debug)
 * rather than collapsing into an opaque `StreamResetError`.
 *
 * The marker key `__clusterError` cannot collide with a successful response: a
 * {@link ClusterRecord} never carries a top-level field by this name, and the
 * redirect payload is keyed under `redirect`.
 */

/** Top-level key that marks a response as a structured cluster error. */
export const CLUSTER_ERROR_KEY = '__clusterError';

/** Serializable error detail carried in a {@link ClusterErrorEnvelope}. */
export interface ClusterErrorDetail {
	message: string;
	name: string;
	/** Stable error code (e.g. libp2p `ERR_*`) when the source error carries one. */
	code?: string;
}

/** Wire shape of a structured cluster error response. */
export interface ClusterErrorEnvelope {
	__clusterError: ClusterErrorDetail;
}

/** Build a {@link ClusterErrorEnvelope} from any thrown value. */
export function toClusterErrorEnvelope(err: unknown): ClusterErrorEnvelope {
	const error = err instanceof Error ? err : new Error(String(err));
	const rawCode = (error as { code?: unknown }).code;
	const detail: ClusterErrorDetail = {
		message: error.message,
		name: error.name
	};
	if (typeof rawCode === 'string' && rawCode.length > 0) {
		detail.code = rawCode;
	}
	return { __clusterError: detail };
}

/** Type guard: is `value` a structured cluster error envelope (not a record/redirect)? */
export function isClusterErrorEnvelope(value: unknown): value is ClusterErrorEnvelope {
	if (typeof value !== 'object' || value === null) return false;
	const detail = (value as { [CLUSTER_ERROR_KEY]?: unknown })[CLUSTER_ERROR_KEY];
	return typeof detail === 'object' && detail !== null;
}

/**
 * Reconstruct a real `Error` from a cluster error envelope, preserving `name`
 * and `code` so the coordinator's reputation/penalty classification still works.
 */
export function clusterErrorFromEnvelope(envelope: ClusterErrorEnvelope): Error {
	const detail = envelope[CLUSTER_ERROR_KEY];
	const error = new Error(detail.message || 'cluster update failed');
	if (detail.name) error.name = detail.name;
	if (detail.code) (error as { code?: string }).code = detail.code;
	return error;
}
