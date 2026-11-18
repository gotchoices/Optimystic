import type { RepoMessage } from "../network/repo-protocol.js";
import type { ClusterPeers, ClusterRecord, Signature } from "./structs.js";
import { sha256 } from "multiformats/hashes/sha2";
import { base58btc } from "multiformats/bases/base58";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import { concat } from "uint8arrays/concat";
import { canonicalJson } from "../utility/canonical-json.js";

/**
 * Membership-binding version a new coordinator emits. A record at this version folds a
 * {@link membershipDigest} of its peer set into `messageHash` / `promiseHash` / `commitHash`, so the
 * responsible peer set is covered by every signature (see `docs/correctness.md` §2). Absent or `1` marks
 * a legacy *unbound* record (pre-binding history) whose hashes must verify byte-identically to before
 * this change.
 */
export const CURRENT_MEMBERSHIP_VERSION = 2 as const;

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
	return membershipDigestFromIds(Object.keys(peers ?? {}));
}

/**
 * Canonical membership digest for an explicit peer-id list — the same digest {@link membershipDigest}
 * derives from a peer map's keys. ONE implementation, so a verifier reading a stored `peerIds` list
 * (e.g. a persisted block commit proof) and a coordinator reading live `ClusterPeers` can never
 * disagree. Sorts a copy; the caller's array is not mutated.
 */
export async function membershipDigestFromIds(ids: readonly string[]): Promise<string> {
	const sorted = [...ids].sort();
	const bytes = new TextEncoder().encode(canonicalJson(sorted));
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

const encoder = new TextEncoder();
// The template literal is what keeps a hostile part hashing as the string concatenation did: a record off
// the wire (a dispute's `originalRecord`, a proof) may carry no `messageHash` or `promises` at all, which
// the old `+` spelled "undefined", where `TextEncoder.encode(undefined)` would encode nothing. (Two
// adjacent missing parts the old `+` added to "NaN"; no record that reaches a signer has that shape.)
const utf8 = (text: string | undefined): Uint8Array => encoder.encode(`${text}`);

// NOTE: the memo is sound only because no `RepoMessage` is changed once it has been hashed: a message
// mutated after its first hash would go on hashing as it was, and a signature would then cover content
// the record no longer holds. Build a new message (`{ ...message, field }`) rather than assigning into one.
// NOTE: holds one more copy of each message for as long as the message object lives, which on a member
// is as long as it keeps the record; if member memory under large writes ever matters, drop the entry
// once the record is decided. Weak, so it never outlives its message; and a message received off the
// wire was bounded by the frame cap before it was decoded, so the memo costs no more than the record.
const messageBytes = new WeakMap<RepoMessage, Uint8Array>();

/**
 * The UTF-8 bytes of `canonicalJson(message)`, computed once per message object. A record's `message`
 * is the whole pend or commit, row data included, and one delivery of a record reads it several times —
 * its message, promise and commit hashes, and `mergeRecords`' comparison — so each of those shares these
 * bytes rather than serializing the message again. The bytes are shared: never write to them.
 */
export function canonicalMessageBytes(message: RepoMessage): Uint8Array {
	const held = messageBytes.get(message);
	if (held !== undefined) return held;
	// A record off the wire is hashed before its shape is checked, so `message` may be no object at all;
	// such a message is never memoized (a WeakMap refuses it as a key), and `utf8` spells `canonicalJson`'s
	// `undefined` for a value JSON cannot encode as the string preimage always did.
	const bytes = utf8(canonicalJson(message));
	if (typeof message === 'object' && message !== null) messageBytes.set(message, bytes);
	return bytes;
}

/**
 * SHA-256 over the preimage `parts` spell, joined: the same bytes as encoding the joined string, so the
 * signed layout of `docs/correctness.md` §2 is unchanged. UTF-8 encoding commutes with concatenation
 * except where a part ending in a high surrogate meets one starting with a low surrogate (joined they
 * are one character, apart two replacement characters). Every boundary in these preimages has a JSON
 * text on one side, which begins and ends with an ASCII character, so that never happens — even for a
 * hostile record whose `messageHash` or digest is not well-formed.
 */
async function hashParts(parts: Uint8Array[]): Promise<Uint8Array> {
	return (await sha256.digest(concat(parts))).digest;
}

/**
 * `messageHash` = `base58btc(SHA256(canonicalJson(message) + digest))`.
 *
 * `digest` `undefined` → legacy v1 preimage (`canonicalJson(message)` only); passing the membership
 * digest folds the peer set in (v2). An absent digest contributes no bytes, so the v1 image is
 * byte-identical to the pre-binding implementation.
 */
export async function computeClusterMessageHash(message: RepoMessage, digest?: string): Promise<string> {
	return base58btc.encode(await hashParts([canonicalMessageBytes(message), utf8(digest ?? '')]));
}

/**
 * `promiseHash` = `base64url(SHA256(messageHash + canonicalJson(message) + digest))`.
 *
 * `digest` `undefined` → legacy v1 preimage; passing it folds the peer set in (v2).
 */
export async function computeClusterPromiseHash(messageHash: string, message: RepoMessage, digest?: string): Promise<string> {
	const hash = await hashParts([utf8(messageHash), canonicalMessageBytes(message), utf8(digest ?? '')]);
	return uint8ArrayToString(hash, 'base64url');
}

/**
 * `commitHash` = `base64url(SHA256(messageHash + canonicalJson(message) + digest + canonicalJson(promises)))`.
 *
 * `digest` `undefined` → legacy v1 preimage; passing it folds the peer set in (v2). The digest sits
 * between the message and the promises image, matching the v2 layout in `docs/correctness.md`.
 */
export async function computeClusterCommitHash(messageHash: string, message: RepoMessage, promises: Record<string, Signature>, digest?: string): Promise<string> {
	const hash = await hashParts([utf8(messageHash), canonicalMessageBytes(message), utf8(digest ?? ''), utf8(canonicalJson(promises))]);
	return uint8ArrayToString(hash, 'base64url');
}
