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
 * MINOR DRIFT IS ALLOWED, though none is left: every workspace declares `@libp2p/interface@^3.3.0`
 * and the lockfile holds one copy, the minor `libp2p@3.3` itself requires. The guards still enforce
 * only "stays within the major", because a minor split is a build failure rather than a silent one.
 * It matters which minor: 3.1.0 pulls uint8arraylist@^2 + multiformats@^13, while 3.2.4 and later
 * pull uint8arraylist@^3 + multiformats@^14, and a stream typed by one does not unify with a
 * length-prefixed codec typed by the other. db-p2p sat on the 3.1 line for that reason until it moved
 * its own `it-length-prefixed` and `uint8arraylist` to the majors the 3.3 line uses.
 *
 * WHAT IS DELIBERATELY NOT HERE — do not add these; both fail on the first run:
 *
 *   - `uint8arraylist`, which resolves to both 2 and 3
 *   - `multiformats`, which resolves to both 13 and 14
 *
 * Neither split is ours any longer: our workspaces are on uint8arraylist 3 and multiformats 14. The
 * older majors come from dependencies whose newest releases still declare them —
 * `@chainsafe/libp2p-noise@17.0.0` and `@chainsafe/libp2p-yamux@8.0.1` (uint8arraylist@^2), and
 * `p2p-fret@1.0.0` (uint8arraylist@^2, multiformats@^13). The two majors of `uint8arraylist` mark a
 * list with the same global symbol and read each other's lists, so that split is one of declared
 * types, not of behaviour. Both become guardable when those three packages move.
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
