import type { RepoMessage } from "../network/repo-protocol.js";
import type { ClusterPeers, ClusterRecord, Signature } from "./structs.js";
import { sha256 } from "multiformats/hashes/sha2";
import { base58btc } from "multiformats/bases/base58";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";

/**
 * Membership-binding version a new coordinator emits. A record at this version folds a
 * {@link membershipDigest} of its peer set into `messageHash` / `promiseHash` / `commitHash`, so the
 * responsible peer set is covered by every signature (see `docs/correctness.md` §2). Absent or `1` marks
 * a legacy *unbound* record (pre-binding history) whose hashes must verify byte-identically to before
 * this change.
 */
export const CURRENT_MEMBERSHIP_VERSION = 2 as const;

/** Deterministic JSON: sorts object keys so the hash is independent of key insertion order. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_, v) =>
		v && typeof v === 'object' && !Array.isArray(v)
			? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
			: v
	);
}

/**
 * Canonical membership digest for a peer set: `base64url(SHA256(canonicalJson(sorted peer-id list)))`.
 *
 * Derived from the sorted peer-id list ONLY — not multiaddrs or public keys. Multiaddrs churn and a
 * peer's public key is already a function of its id, so folding either in would make identity unstable
 * without adding agreement value. The set of ids IS the membership. The digest is therefore independent
 * of peer-map key insertion order and of multiaddr / pubkey contents; adding or removing one id changes
 * it. `membershipDigest({})` (the empty set) is a fixed constant.
 */
export async function membershipDigest(peers: ClusterPeers): Promise<string> {
	const ids = Object.keys(peers ?? {}).sort();
	const bytes = new TextEncoder().encode(canonicalJson(ids));
	const hash = await sha256.digest(bytes);
	return uint8ArrayToString(hash.digest, 'base64url');
}

/**
 * The membership digest that participates in a record's hashes, or `undefined` for a legacy (v1 /
 * unversioned) record. `undefined` selects the pre-binding hashing (empty-string concat is a no-op), so
 * a v1 record hashes byte-identically to before this change. A v2 record folds in its declared
 * `membershipDigest`.
 */
export function recordMembershipDigest(record: Pick<ClusterRecord, 'membershipVersion' | 'membershipDigest'>): string | undefined {
	return record.membershipVersion === 2 ? record.membershipDigest : undefined;
}

/**
 * `messageHash` = `base58btc(SHA256(canonicalJson(message) + digest))`.
 *
 * `digest` `undefined` → legacy v1 preimage (`canonicalJson(message)` only); passing the membership
 * digest folds the peer set in (v2). Empty-string concat means the v1 image is byte-identical to the
 * pre-binding implementation.
 */
export async function computeClusterMessageHash(message: RepoMessage, digest?: string): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson(message) + (digest ?? ''));
	const hash = await sha256.digest(bytes);
	return base58btc.encode(hash.digest);
}

/**
 * `promiseHash` = `base64url(SHA256(messageHash + canonicalJson(message) + digest))`.
 *
 * `digest` `undefined` → legacy v1 preimage; passing it folds the peer set in (v2).
 */
export async function computeClusterPromiseHash(messageHash: string, message: RepoMessage, digest?: string): Promise<string> {
	const bytes = new TextEncoder().encode(messageHash + canonicalJson(message) + (digest ?? ''));
	const hash = await sha256.digest(bytes);
	return uint8ArrayToString(hash.digest, 'base64url');
}

/**
 * `commitHash` = `base64url(SHA256(messageHash + canonicalJson(message) + digest + canonicalJson(promises)))`.
 *
 * `digest` `undefined` → legacy v1 preimage; passing it folds the peer set in (v2). The digest sits
 * between the message and the promises image, matching the v2 layout in `docs/correctness.md`.
 */
export async function computeClusterCommitHash(messageHash: string, message: RepoMessage, promises: Record<string, Signature>, digest?: string): Promise<string> {
	const bytes = new TextEncoder().encode(messageHash + canonicalJson(message) + (digest ?? '') + canonicalJson(promises));
	const hash = await sha256.digest(bytes);
	return uint8ArrayToString(hash.digest, 'base64url');
}
