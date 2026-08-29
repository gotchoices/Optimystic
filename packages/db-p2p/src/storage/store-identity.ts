/**
 * A stable, process-scoped name for what a store is backed by — a resolved directory, an
 * open database handle, and so on.
 *
 * Compared for EQUALITY ONLY. Never parsed, never split on its scheme prefix, and never used
 * as a cache key for values — it names the store, not its contents.
 */
export type StoreIdentity = string;

/**
 * Per-scheme tag maps. Weak, so tagging a handle never keeps it alive: once the handle is
 * unreachable its entry goes with it.
 */
const handleTags = new Map<string, WeakMap<object, StoreIdentity>>();
let nextHandleOrdinal = 0;

/**
 * A stable identity for a backend reachable only as an already-open handle object (a SQLite
 * db, an IndexedDB handle, a LevelDB instance). Returns the same string for the same object
 * for the life of the process, and a different one for every other object.
 *
 * `scheme` prefixes the result so identities from different backends can never collide.
 *
 * Object identity is the whole contract here: two handles opened over the SAME underlying
 * file/name/path read as two DIFFERENT identities. That is a deliberate under-approximation —
 * see the `NOTE:` at each handle-based driver for why it is the reachable case in practice.
 */
export function identityForHandle(scheme: string, handle: object): StoreIdentity {
	let tags = handleTags.get(scheme);
	if (!tags) {
		tags = new WeakMap<object, StoreIdentity>();
		handleTags.set(scheme, tags);
	}
	const existing = tags.get(handle);
	if (existing !== undefined) return existing;
	// The ordinal is global rather than per-scheme so the same handle under two schemes gets
	// two visibly different suffixes as well as two different prefixes.
	const identity = `${scheme}:${nextHandleOrdinal++}`;
	tags.set(handle, identity);
	return identity;
}
