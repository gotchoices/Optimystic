// @ts-check
/** @type {import('@yarnpkg/types')} */
const { defineConfig } = require('@yarnpkg/types')

/**
 * Dependencies that MUST resolve to a single range across every workspace.
 * Divergence here has bitten us before: two majors of `@libp2p/peer-id`
 * loading at once makes a peer-id minted by one copy fail `instanceof`
 * against the class from the other copy -> intermittent, hard-to-diagnose
 * identity/routing failures.
 *
 * `yarn constraints` fails if any workspace declares a different range;
 * `yarn constraints --fix` rewrites the offending package.json to the
 * shared range (these are safe to autofix — one blessed range).
 */
const SINGLE_RANGE = {
  // NOTE: This pins only the WORKSPACE-DECLARED range. Transitive copies of
  // @libp2p/peer-id (v4 via @libp2p/peer-id-factory, and v5 via the libp2p
  // stack) can still resolve in yarn.lock even after this — they come from
  // dependencies of dependencies, not from our package.json files, so this
  // guard cannot reach them. That residual transitive skew is fine today
  // (workspace-authored code is single-major). It only becomes work if a
  // runtime instanceof/identity failure is ever traced to a
  // transitive-vs-workspace peer-id copy; at that point, dedupe via a root
  // `resolutions` entry for @libp2p/peer-id.
  '@libp2p/peer-id': '^6.0.4',
  // Declared range must match the root `resolutions` override in package.json
  // (which already forces every install to ^6.1.1). This only makes the
  // declaration honest so the guard can pass.
  'uint8arrays': '^6.1.1',
}

/**
 * Dependencies where only the MAJOR must agree; minor drift is allowed and,
 * for @libp2p/interface, is DELIBERATE.
 *
 * @libp2p/interface 3.1.x and 3.2.x are both major 3, but pull DIFFERENT
 * transitive majors: 3.1.0 -> uint8arraylist@^2 + multiformats@^13, while
 * 3.2.4 -> uint8arraylist@^3 + multiformats@^14. db-p2p and its it-length-
 * prefixed / uint8arraylist@^2 dependencies build only against the 3.1.x
 * line; db-core builds against 3.2.x. Forcing both onto one minor resurfaces
 * a structural-typing split (Uint8ArrayList v2 vs v3) in db-p2p's build/tests
 * — the split the completed ticket `optimystic-db-p2p-libp2p-dep-skew`
 * deliberately left in place. So we enforce only "stays within major 3" here;
 * a future ^4 bump (a real, cross-major skew) still trips the guard.
 *
 * There is no safe autofix for a major mismatch — the guard cannot know which
 * minor a package needs — so this path reports via dep.error(), not
 * dep.update(). `yarn constraints --fix` will NOT silently rewrite it.
 */
const SHARED_MAJOR = {
  '@libp2p/interface': 3,
  '@libp2p/crypto': 5,
}

/** Extract the leading major integer from a caret/tilde/plain range. */
function majorOf(range) {
  const m = /^\D*(\d+)/.exec(range)
  return m ? Number(m[1]) : null
}

module.exports = defineConfig({
  async constraints({ Yarn }) {
    // Yarn.dependencies() spans dependencies + devDependencies +
    // peerDependencies across all workspaces. workspace:^ deps have a
    // different ident, so internal @optimystic/* links are never touched.
    for (const [ident, range] of Object.entries(SINGLE_RANGE)) {
      for (const dep of Yarn.dependencies({ ident })) {
        dep.update(range)
      }
    }

    for (const [ident, major] of Object.entries(SHARED_MAJOR)) {
      for (const dep of Yarn.dependencies({ ident })) {
        if (majorOf(dep.range) !== major) {
          dep.error(
            `${ident} must stay within major ^${major} (found ${dep.range}); ` +
            `bumping across a major reintroduces a structural-typing split — see yarn.config.cjs`
          )
        }
      }
    }
  },
})
