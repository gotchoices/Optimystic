/**
 * Deterministic JSON: sorts object keys so the encoding — and therefore any hash over it — is
 * independent of key insertion order. Arrays keep their order (position is meaning).
 *
 * The ONE implementation behind every db-core agreement hash: block content
 * ({@link canonicalBlockHash}) and cluster record/membership hashes ({@link membershipDigest},
 * `computeMessageHash` and friends). Two nodes that encode differently disagree on honest data, so
 * a second copy is a correctness hazard, not a style nit — import this rather than re-deriving it.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}
