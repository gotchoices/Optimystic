// @ts-check
/** @type {import('@yarnpkg/types')} */
const { defineConfig } = require('@yarnpkg/types')
const { SHARED_MAJOR } = require('./scripts/shared-majors.cjs')

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
 *
 * Like everything in this file, this pins only what our own workspaces
 * DECLARE. A transitive copy — a dependency of a dependency asking for another
 * major — is invisible to constraints. `scripts/check-libp2p-majors.mjs`
 * covers that side by checking the resolved tree against the same majors, and
 * `yarn lint:deps` runs both.
 */
const SINGLE_RANGE = {
	'@libp2p/peer-id': '^6.0.4',
	// Declared range must match the root `resolutions` override in package.json
	// (which already forces every install to ^6.1.1). This only makes the
	// declaration honest so the guard can pass.
	'uint8arrays': '^6.1.1',
}

/*
 * SHARED_MAJOR — dependencies where only the MAJOR must agree — lives in
 * `scripts/shared-majors.cjs`, together with why each package is on it and why
 * minor drift is allowed. It is shared with the resolved-tree guard so the two
 * lists cannot drift apart; here it is applied to declared ranges.
 *
 * There is no safe autofix for a major mismatch — the guard cannot know which
 * minor a package needs — so this path reports via dep.error(), not
 * dep.update(). `yarn constraints --fix` will NOT silently rewrite it.
 */

/**
 * Extract the leading major integer from a caret/tilde/plain range.
 * @param {string} range
 * @returns {number | null}
 */
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
			// The blessed range has to sit inside the major the resolved-tree guard
			// expects, or the two guards would demand contradictory things. Reported
			// on the root workspace, and never autofixed: `--fix` must not write it.
			if (ident in SHARED_MAJOR && majorOf(range) !== SHARED_MAJOR[ident]) {
				Yarn.workspace().error(
					`yarn.config.cjs pins ${ident} to ${range}, but scripts/shared-majors.cjs expects major ${SHARED_MAJOR[ident]}`
				)
				continue
			}
			for (const dep of Yarn.dependencies({ ident })) {
				dep.update(range)
			}
		}

		for (const [ident, major] of Object.entries(SHARED_MAJOR)) {
			// Already pinned to one exact range above, and autofixably; checking its
			// major as well would only report the same declaration twice.
			if (ident in SINGLE_RANGE) continue
			for (const dep of Yarn.dependencies({ ident })) {
				if (majorOf(dep.range) !== major) {
					dep.error(
						`${ident} must stay within major ^${major} (found ${dep.range}); ` +
						`bumping across a major reintroduces a structural-typing split — see scripts/shared-majors.cjs`
					)
				}
			}
		}
	},
})
