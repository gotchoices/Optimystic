// @ts-check
/**
 * The single list of packages whose MAJOR version must be uniform across this project, and the major
 * each must be on.
 *
 * Two guards read it, and they check different things:
 *
 *   - `yarn.config.cjs` (Yarn 4 constraints) checks the ranges our own workspaces DECLARE in their
 *     package.json files. It cannot see below that: a dependency of a dependency is invisible to it.
 *   - `scripts/check-libp2p-majors.mjs` checks what actually got INSTALLED — every transitive
 *     package, and the portal-linked sibling repositories.
 *
 * `yarn lint:deps` runs both. The list lives here, in one file, because two copies would drift — and
 * a silent version split is exactly the bug both guards exist to catch. CommonJS because Yarn loads
 * `yarn.config.cjs` as CommonJS, and it has to `require` this.
 *
 * WHY THESE PACKAGES. libp2p is split across dozens of small npm packages that share one package of
 * common type definitions and base classes, `@libp2p/interface`. Two libp2p components interoperate
 * only if they were built against the same major of it. When they were not, a stream, peer id or key
 * minted by one copy is structurally incompatible with the class from the other, `instanceof` quietly
 * returns false, and TypeScript does not reliably object. That shipped once:
 * `@chainsafe/libp2p-gossipsub@14` was built against major 2 while the rest of this tree was on major
 * 3, so gossipsub threw on every message it sent and swallowed its own error (gotchoices/Optimystic#9).
 * The package manager reported success throughout — gossipsub declared `@libp2p/interface` as a plain
 * dependency, so it simply got a private second copy.
 *
 * MINOR DRIFT IS ALLOWED, and for `@libp2p/interface` it is DELIBERATE. 3.1.x and 3.2.x are both major
 * 3, but pull different transitive majors: 3.1.0 -> uint8arraylist@^2 + multiformats@^13, while 3.2.4
 * -> uint8arraylist@^3 + multiformats@^14. db-p2p and its it-length-prefixed / uint8arraylist@^2
 * dependencies build only against the 3.1.x line; db-core builds against 3.2.x. Forcing both onto one
 * minor resurfaces a structural-typing split (Uint8ArrayList v2 vs v3) in db-p2p's build and tests —
 * the split the completed ticket `optimystic-db-p2p-libp2p-dep-skew` deliberately left in place. So the
 * guards enforce only "stays within the major"; a move to another major, by us or by any dependency,
 * still trips them.
 *
 * WHAT IS DELIBERATELY NOT HERE — do not add these; both fail on the first run:
 *
 *   - `multiformats`, which resolves to both 13 and 14
 *   - `uint8arraylist`, which resolves to both 2 and 3
 *
 * Both splits are downstream consequences of the 3.1-versus-3.2 drift above, not independent
 * mismatches. They become guardable once that drift is gone.
 *
 * @type {Record<string, number>}
 */
const SHARED_MAJOR = {
	// The failure class described above.
	'@libp2p/interface': 3,
	// The same kind of shared type definitions, with the same 3.1/3.2 minor split.
	'@libp2p/interface-internal': 3,
	// Carries the key and peer-id shapes that cross the interface boundary.
	'@libp2p/crypto': 5,
	// Two majors here make `instanceof` fail across copies -> intermittent identity/routing bugs.
	'@libp2p/peer-id': 6,
	// Already forced to one version by the root `resolutions` entry; guarding it makes that honest.
	'uint8arrays': 6,
}

module.exports = { SHARED_MAJOR }
