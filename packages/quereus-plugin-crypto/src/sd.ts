/**
 * Salted-leaf SET COMMITMENT for per-attribute selective disclosure.
 *
 * An authority commits to a whole set of attributes as a single root value (which
 * it signs / persists), then later reveals only a chosen *subset* to a recipient —
 * with a proof that the revealed values are genuinely the committed ones — without
 * leaking the values of the withheld attributes. A flat `digest(whole set)` cannot
 * do this (verifying one field needs the whole pre-image, so it is all-or-nothing);
 * this construction supports *partial opening*.
 *
 * ## Construction (flat salted-leaf set commitment, NOT a Merkle tree)
 *
 * Each disclosable attribute is a salted leaf, and the commitment (root) is the
 * digest of all leaf digests in canonical order:
 *
 * ```
 * leafDigest = digest([SD_LEAF_DOMAIN_V1, name, value, salt])   // raw digest bytes
 * root       = digest([SD_SET_DOMAIN_V1, sortedLeaf_0, sortedLeaf_1, ...])
 * ```
 *
 * Both layers compose on the existing canonical {@link encodeFields} framing
 * (injective, type-tagged, length-prefixed, replicable) — the same layering the CID
 * work uses — so a *generic* salted-set primitive is simultaneously reusable and
 * fully DB-enforceable. This is the same shape the IETF SD-JWT standard settled on
 * (flat salted hashes, not a tree); we are NOT wire-compatible with SD-JWT (we reuse
 * Optimystic's own `encodeFields` framing for cross-peer replicability) — SD-JWT is
 * cited only as conceptual precedent that the smaller construction is the right one.
 *
 * Voter selective-disclosure field sets are small (a handful to a few dozen fields),
 * so a tree's only advantage — O(log n) proof size — is marginal, while a tree drags
 * in real footguns we would have to hand-roll and pin (arity, odd-node handling /
 * the CVE-2012-2459 duplicate-leaf forgery class, leaf-vs-internal domain separation,
 * and a separate audit-path proof format). A flat construction avoids all of them.
 *
 * ## Why these specific choices
 *
 * - **`name` is hashed into the leaf** so a disclosed `(value, salt)` proof cannot be
 *   replayed against a different attribute slot (e.g. presenting an `over18=true`
 *   proof as the `citizen` field). The binding is free given `encodeFields` framing.
 * - **`salt` is per-leaf and mandatory** — low-entropy attributes (DOB, booleans, ZIP)
 *   are brute-forceable from a bare hash, and independent salts also defeat cross-
 *   registrant equality correlation. Salts come from `random_bytes` (≥128 bits).
 * - **Canonical order is by raw leaf-digest bytes (lexicographic), and this is FORCED,
 *   not a preference.** In a disclosure the verifier learns the *names* of only the
 *   disclosed leaves; the withheld leaves arrive as opaque digests with no name. So the
 *   verifier can re-derive the root only if the ordering key is something it holds for
 *   *every* leaf — the leaf digest itself. Sorting by name would be unverifiable for
 *   hidden leaves. Do NOT "tidy" this into a name sort.
 * - Sort is over **raw digest bytes**, never over encoded strings — an encoding-
 *   dependent ordering would break cross-peer agreement. Output encoding applies only
 *   to the final root.
 *
 * Because leaf and root reuse `encodeFields`, a future `DIGEST_FORMAT_V1` bump changes
 * `setCommit` output too; this coupling is intentional (one canonical framing).
 */

import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import {
	encodeFields,
	resolveHasher,
	resolveOutputEncoder,
	type DigestField,
	type DigestHasher,
	type OutputEncoder,
} from './crypto.js';

/**
 * Fixed domain-separation constants — the leading string field of each layer's
 * {@link encodeFields} tuple. They are pinned EXACTLY like `DIGEST_FORMAT_V1`:
 *
 * - the two strings MUST be distinct, so a leaf hash can never equal a root hash;
 * - neither may change without a deliberate, breaking version bump — which would
 *   change every committed root and every signature taken over it.
 *
 * Do not "tidy" or shorten these.
 */
const SD_LEAF_DOMAIN_V1 = 'optimystic/sd-leaf/v1';
const SD_SET_DOMAIN_V1 = 'optimystic/sd-set/v1';

/** Hidden leaf digests travel as base64url text — the plugin's canonical text encoding. */
const HIDDEN_ENCODING = 'base64url';

/** One disclosable attribute. `value` spans the SQL value space ({@link DigestField}). */
export interface SaltedLeaf {
	readonly name: string;
	readonly value: DigestField;
	/** base64url text (e.g. from `random_bytes`) or raw bytes. Mandatory, non-empty. */
	readonly salt: string | Uint8Array;
}

/** A disclosure payload sent to a recipient. */
export interface SetDisclosure {
	/** The opened `(name, value, salt)` triples. */
	readonly disclosed: readonly SaltedLeaf[];
	/** Opaque leaf digests (base64url) of the withheld leaves — no name, no value, no salt. */
	readonly hidden: readonly string[];
}

// --- internal helpers --- //

/** Lexicographic compare of two byte arrays (the canonical leaf ordering key). */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const d = a[i]! - b[i]!;
		if (d !== 0) return d;
	}
	return a.length - b.length;
}

/** Constant-shape byte equality (length first, then content). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Normalize a leaf's salt to raw bytes — a base64url string (the form `random_bytes`
 * returns) decodes to bytes, raw bytes pass through — so the two representations of the
 * same salt commit identically. THROWS on a missing or empty salt (unsalted leaves are
 * brute-forceable, an invalid state we make impossible).
 */
function requireSaltBytes(leaf: SaltedLeaf): Uint8Array {
	const { salt } = leaf;
	if (salt == null) {
		throw new Error(`set commitment: leaf '${leaf.name}' is missing a salt (an unsalted leaf is brute-forceable)`);
	}
	const bytes = salt instanceof Uint8Array ? salt : uint8ArrayFromString(salt, HIDDEN_ENCODING);
	if (bytes.length === 0) {
		throw new Error(`set commitment: leaf '${leaf.name}' has an empty salt (an unsalted leaf is brute-forceable)`);
	}
	return bytes;
}

/**
 * THROW on a duplicate `name`. Two leaves with the same name would let a holder
 * selectively present whichever value suits them; the authority side (which holds all
 * names) is the only place uniqueness can be enforced — the verifier never sees the
 * hidden names — so the primitive must fail-fast.
 */
function assertUniqueNames(leaves: readonly SaltedLeaf[]): void {
	const seen = new Set<string>();
	for (const leaf of leaves) {
		if (seen.has(leaf.name)) {
			throw new Error(`set commitment: duplicate leaf name '${leaf.name}'`);
		}
		seen.add(leaf.name);
	}
}

// --- public API --- //

/**
 * Raw leaf digest bytes for one salted leaf: `digest([SD_LEAF_DOMAIN_V1, name,
 * value, salt])`. Domain-separated (can never equal a root) and name-bound (a
 * `(value, salt)` proof cannot be replayed under another attribute name). THROWS on
 * a missing/empty salt.
 */
export function leafDigest(leaf: SaltedLeaf, hasher: DigestHasher): Uint8Array {
	const saltBytes = requireSaltBytes(leaf);
	return hasher(encodeFields([SD_LEAF_DOMAIN_V1, leaf.name, leaf.value, saltBytes]));
}

/**
 * Commit to a SET of salted leaves → a single root (the signed/persisted value).
 * Sorts leaves by raw leaf-digest bytes, then digests them under `SD_SET_DOMAIN_V1`.
 * Like `digest`, this emits a BARE digest — apply `cid()` on top for the self-
 * describing column representation (`cid(set_commit(...))`).
 *
 * The empty set is well-defined (the digest of `[SD_SET_DOMAIN_V1]`), not an error.
 * THROWS on a duplicate `name` or a missing/empty `salt` (invalid states made
 * impossible). Resolve `hasher`/`encode` once and reuse — no per-call branching.
 */
export function setCommit(
	leaves: readonly SaltedLeaf[],
	hasher: DigestHasher = resolveHasher('sha256'),
	encode: OutputEncoder = resolveOutputEncoder('base64url'),
): string | Uint8Array {
	assertUniqueNames(leaves);
	const leafDigests = leaves.map((leaf) => leafDigest(leaf, hasher));
	leafDigests.sort(compareBytes);
	return encode(hasher(encodeFields([SD_SET_DOMAIN_V1, ...leafDigests])));
}

/**
 * Split a leaf set into the revealed `(name, value, salt)` triples plus the opaque
 * leaf digests (base64url) of the rest. Withheld `value`/`salt` never appear in the
 * output. Names in `revealNames` that match no leaf are simply not disclosed.
 * THROWS on a duplicate `name` or a missing/empty salt of a withheld leaf.
 */
export function setDisclose(
	leaves: readonly SaltedLeaf[],
	revealNames: readonly string[],
	hasher: DigestHasher = resolveHasher('sha256'),
): SetDisclosure {
	assertUniqueNames(leaves);
	const reveal = new Set(revealNames);
	const disclosed: SaltedLeaf[] = [];
	const hidden: string[] = [];
	for (const leaf of leaves) {
		if (reveal.has(leaf.name)) {
			disclosed.push(leaf);
		} else {
			hidden.push(uint8ArrayToString(leafDigest(leaf, hasher), HIDDEN_ENCODING));
		}
	}
	return { disclosed, hidden };
}

/**
 * Verify a disclosure against a signed root. Recomputes the disclosed leaves'
 * digests, unions them with the supplied hidden digests, sorts by bytes, recomputes
 * the root, and compares to `root`. This reconstructs the ENTIRE root, so it proves
 * the disclosed leaves belong to *exactly* this committed set — the holder cannot
 * add, drop, or swap a leaf (the leaf count is bound too).
 *
 * `encode` is how the signed `root` is rendered (so the recomputed root is encoded
 * the same way before comparison); for a `Uint8Array` root the raw bytes are compared
 * directly. Returns `false` on mismatch or malformed input — mirroring `verify`'s
 * forgiving contract rather than throwing.
 */
export function setVerify(
	root: string | Uint8Array,
	disclosure: SetDisclosure,
	hasher: DigestHasher = resolveHasher('sha256'),
	encode: OutputEncoder = resolveOutputEncoder('base64url'),
): boolean {
	try {
		const { disclosed, hidden } = disclosure;
		const digests: Uint8Array[] = [];
		for (const leaf of disclosed) {
			digests.push(leafDigest(leaf, hasher));
		}
		for (const h of hidden) {
			digests.push(uint8ArrayFromString(h, HIDDEN_ENCODING));
		}
		digests.sort(compareBytes);
		const recomputed = hasher(encodeFields([SD_SET_DOMAIN_V1, ...digests]));
		if (root instanceof Uint8Array) {
			return bytesEqual(recomputed, root);
		}
		const encoded = encode(recomputed);
		return typeof encoded === 'string' && encoded === root;
	} catch {
		return false;
	}
}
