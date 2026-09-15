// @ts-check
/**
 * The single list of packages whose MAJOR version must be uniform across this project.
 *
 * Two consumers read it, and they check different things:
 *
 *   - `yarn.config.cjs` (Yarn 4 constraints) checks the ranges *we declare* in our own
 *     workspaces' package.json files. It cannot see anything below that — a dependency of a
 *     dependency is invisible to it.
 *   - `scripts/check-libp2p-majors.mjs` checks what actually got *installed*, transitive
 *     packages included.
 *
 * The list lives here, in one file, because two copies would drift — and a silent version
 * split is exactly the bug both guards exist to catch.
 *
 * WHY THESE PACKAGES. libp2p is split across dozens of small npm packages that share one
 * package of common type definitions and base classes, `@libp2p/interface`. Two libp2p
 * components interoperate only if they were built against the same major of it. When they are
 * not, a stream, peer id or key minted by one copy is structurally incompatible with the class
 * from the other, `instanceof` quietly returns false, and TypeScript does not reliably object.
 * That shipped once already: `@chainsafe/libp2p-gossipsub@14` was built against major 2 while
 * the rest of this tree was on major 3, so gossipsub threw on every message it sent and
 * swallowed its own error (gotchoices/Optimystic#9).
 *
 * WHAT IS DELIBERATELY NOT HERE — do not add these, they fail on the first run:
 *
 *   - `multiformats` (resolves to both 13 and 14)
 *   - `uint8arraylist` (resolves to both 2 and 3)
 *
 * Both splits are the downstream consequence of a deliberate decision: `@libp2p/interface`
 * 3.1.x and 3.2.x are the same major but pull different transitive majors of those two
 * packages, and db-p2p's it-length-prefixed / uint8arraylist@^2 stack builds only against the
 * 3.1 line. The completed ticket `optimystic-db-p2p-libp2p-dep-skew` left that minor split in
 * place on purpose; see the `SHARED_MAJOR` notes in `yarn.config.cjs` for the full reasoning.
 */
const SHARED_MAJOR = {
  // The failure class described above, first-hand.
  '@libp2p/interface': 3,
  // Same type definitions, same 3.1/3.2 minor split, currently single-major.
  '@libp2p/interface-internal': 3,
  // Carries the key and peer-id shapes that cross the interface boundary.
  '@libp2p/crypto': 5,
  // Two majors here make `instanceof` fail across copies -> intermittent identity/routing bugs.
  '@libp2p/peer-id': 6,
  // Already forced single by the root `resolutions` entry; guarding makes that honest.
  'uint8arrays': 6,
}

module.exports = { SHARED_MAJOR }
