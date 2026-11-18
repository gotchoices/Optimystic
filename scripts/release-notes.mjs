/**
 * The pure half of `scripts/gh-release.mjs`: finding one release's notes in `.release-notes.pending.md`
 * and taking them out again once GitHub holds them. Nothing here touches the file system, git or gh.
 *
 * The pending file is a preamble, then sections separated by lines holding exactly `---`, newest
 * first. Each section opens with a level-one heading: `# v1.28.0` for a release whose notes are
 * written but not yet published as a GitHub release page, or `# Unreleased — since v1.27.0` for the
 * notes collected during the current cycle.
 */

/** The line that separates sections. */
const SEPARATOR = /^---$/m;

/**
 * Splits the file into its preamble and its sections. Joining `[preamble, ...sections]` with `---`
 * gives back the text exactly.
 *
 * @param {string} text
 * @returns {{ preamble: string, sections: string[] }}
 */
export function parsePendingNotes(text) {
	const [preamble, ...sections] = text.split(SEPARATOR);
	return { preamble: preamble ?? '', sections };
}

/**
 * @param {{ preamble: string, sections: string[] }} notes
 * @returns {string}
 */
export function formatPendingNotes(notes) {
	return [notes.preamble, ...notes.sections].join('---');
}

/**
 * The section's level-one heading, without the `# `, or `undefined` when it has none.
 *
 * @param {string} section
 * @returns {string | undefined}
 */
export function sectionTitle(section) {
	const heading = section.split('\n').find(line => line.startsWith('# '));
	return heading?.slice(2).trim();
}

/**
 * Which section holds `version`'s notes: one titled `v{version}` (optionally followed by a space
 * and a remark), or else the first section when it is the cycle's `Unreleased` one, since that is
 * what a release made straight from the cycle publishes. `-1` when neither exists.
 *
 * @param {string[]} sections
 * @param {string} version
 * @returns {number}
 */
export function findReleaseSection(sections, version) {
	const tag = `v${version}`;
	const named = sections.findIndex(section => {
		const title = sectionTitle(section);
		return title === tag || (title?.startsWith(`${tag} `) ?? false);
	});
	if (named !== -1) return named;
	return sections.length > 0 && (sectionTitle(sections[0]) ?? '').startsWith('Unreleased') ? 0 : -1;
}

/**
 * The release page's body: the section without its heading, with each link to a file in this
 * repository pointed at that file as of `tag`, since a release page resolves no relative link.
 *
 * @param {string} section
 * @param {string} repoUrl  e.g. `https://github.com/gotchoices/Optimystic`
 * @param {string} tag      e.g. `v1.28.0`
 * @returns {string}
 */
export function releaseBody(section, repoUrl, tag) {
	const lines = section.split('\n');
	const headingAt = lines.findIndex(line => line.startsWith('# '));
	const body = lines.filter((_line, i) => i !== headingAt).join('\n').trim();
	return absoluteRepositoryLinks(body, repoUrl, tag);
}

/**
 * Rewrites markdown links whose target is a repository path (`](docs/x.md#y)`) to the file at
 * `tag` on GitHub. A target with a scheme, a leading `#`, `/` or `../` is left alone.
 *
 * @param {string} markdown
 * @param {string} repoUrl
 * @param {string} tag
 * @returns {string}
 */
export function absoluteRepositoryLinks(markdown, repoUrl, tag) {
	const base = `${repoUrl.replace(/\/+$/, '')}/blob/${tag}/`;
	return markdown.replace(/\]\(([^)\s]+)\)/g, (match, target) =>
		isRepositoryPath(target) ? `](${base}${target})` : match);
}

/** @param {string} target */
function isRepositoryPath(target) {
	return !/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^(#|\/|\.\.\/)/.test(target);
}

/**
 * The pending file with section `index` removed.
 *
 * @param {{ preamble: string, sections: string[] }} notes
 * @param {number} index
 * @returns {{ preamble: string, sections: string[] }}
 */
export function withoutSection(notes, index) {
	return { preamble: notes.preamble, sections: notes.sections.filter((_s, i) => i !== index) };
}
