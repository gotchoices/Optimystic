/**
 * The pure half of the resolved-major guard: parse `yarn info` output, find the guarded packages that
 * are installed at an unexpected major or not installed at all, and render the report.
 *
 * Nothing here runs yarn, reads a file or exits. `scripts/check-libp2p-majors.mjs` does that, and is
 * the place to read about why the guard exists. The two are separate files so that the tests
 * (`test-harness/libp2p-majors.test.mjs`) import these functions without the entry script needing to
 * work out whether it was run directly — a check that can get that wrong, and then exit 0 having
 * checked nothing.
 */
import { PACKAGE_NAME_RE, cliCommand } from './cli-command.mjs';

/**
 * @typedef {object} Resolution  One installed version of a guarded package.
 * @property {string} ident         Package name, e.g. `@libp2p/interface`.
 * @property {string} version       The version Yarn resolved, e.g. `3.1.0`.
 * @property {string[]} dependents  Yarn locators of the packages that pull this version in.
 *
 * @typedef {object} MajorGroup  The resolutions of one package that share a major.
 * @property {number | null} major  Null when the version is not readable as semver.
 * @property {Resolution[]} resolutions
 *
 * @typedef {{ kind: 'not-installed', ident: string, expected: number }
 *   | { kind: 'wrong-major', ident: string, expected: number, groups: MajorGroup[] }} MajorProblem
 */

// -- Reading yarn's answer -----------------------------------------------------------------------

/**
 * Yarn's own locator grammar (`tryParseLocator` in `@yarnpkg/core`'s structUtils): an optional
 * `@scope/`, a name, then `@` and the reference. The name cannot contain `@`, so the first `@` after
 * it ends the ident; the reference may contain more (a `patch:` reference embeds a second locator).
 */
const LOCATOR_RE = /^((?:@[^/]+?\/)?[^@/]+?)@(.+)$/;

/** Split a Yarn locator into its package name and reference. Null when it is not a locator. */
export function parseLocator(locator) {
	const match = LOCATOR_RE.exec(locator);
	return match ? { ident: match[1], reference: match[2] } : null;
}

/**
 * Parse `yarn info --json --dependents` output: NDJSON, one record per resolved version, shaped
 * `{ value: <locator>, children: { Version, Dependents: [<locator>, ...] } }`.
 *
 * @param {string} text
 * @returns {Resolution[]}
 */
export function parseYarnInfo(text) {
	return text.split(/\r?\n/).filter((line) => line.trim() !== '').map(parseInfoRecord);
}

/**
 * The version comes from `children.Version`, the resolved manifest's own field — never from the
 * locator, because a `portal:`, `workspace:` or `patch:` reference carries no version at all.
 *
 * Anything else on stdout (a corepack download notice, say) throws: it means yarn was not answering
 * the question asked, and reading past it is how a guard ends up passing on output it never
 * understood.
 */
function parseInfoRecord(line) {
	let record;
	try {
		record = JSON.parse(line);
	} catch (err) {
		throw new Error(`yarn info printed a line that is not JSON: ${line}`, { cause: err });
	}
	const locator = typeof record?.value === 'string' ? parseLocator(record.value) : null;
	const version = record?.children?.Version;
	const dependents = record?.children?.Dependents ?? [];
	if (!locator || typeof version !== 'string' || !Array.isArray(dependents)) {
		throw new Error(`yarn info printed a record this script does not understand: ${line}`);
	}
	return { ident: locator.ident, version, dependents };
}

/** Semver `MAJOR.MINOR.PATCH`, with an optional prerelease and build suffix. */
const SEMVER_RE = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/** The major of a resolved version — `3.2.4-rc.1` is 3, `10.0.0` is 10 — or null if it is not semver. */
export function majorOf(version) {
	const match = SEMVER_RE.exec(version);
	return match ? Number(match[1]) : null;
}

// -- The check -----------------------------------------------------------------------------------

/**
 * Every guarded package that is installed at any major other than its expected one, or that is not
 * installed at all.
 *
 * The expected major is declared rather than inferred: a "more than one distinct major" rule would
 * pass a tree that had moved wholesale onto a major nothing here is built for. And a guarded package
 * that resolves to nothing is a problem, not a pass — a guard watching a package that is no longer
 * installed stays green whatever the tree contains, which is worse than having no guard.
 *
 * @param {Resolution[]} resolutions
 * @param {Record<string, number>} expectedMajors
 * @returns {MajorProblem[]}
 */
export function findMajorProblems(resolutions, expectedMajors) {
	const problems = [];
	for (const [ident, expected] of Object.entries(expectedMajors)) {
		const groups = groupByMajor(resolutions.filter((r) => r.ident === ident), expected);
		if (groups.length === 0) problems.push({ kind: 'not-installed', ident, expected });
		else if (groups.some((group) => group.major !== expected)) problems.push({ kind: 'wrong-major', ident, expected, groups });
	}
	return problems;
}

/** Resolutions grouped by major: the expected major first, then the others ascending, then unreadable versions. */
function groupByMajor(resolutions, expected) {
	const byMajor = new Map();
	for (const resolution of resolutions) {
		const major = majorOf(resolution.version);
		byMajor.set(major, [...(byMajor.get(major) ?? []), resolution]);
	}
	const rank = (major) => (major === expected ? -1 : major ?? Number.MAX_SAFE_INTEGER);
	return [...byMajor]
		.map(([major, members]) => ({ major, resolutions: members.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })) }))
		.sort((a, b) => rank(a.major) - rank(b.major));
}

/**
 * The problems plus the report to print for them. `message` is empty exactly when `problems` is.
 *
 * @param {Resolution[]} resolutions
 * @param {Record<string, number>} expectedMajors
 */
export function checkResolvedMajors(resolutions, expectedMajors) {
	const problems = findMajorProblems(resolutions, expectedMajors);
	return { problems, message: renderMajorProblems(problems) };
}

// -- The report ----------------------------------------------------------------------------------

/**
 * How many dependents to name for one resolved version before summarizing the rest as "+N more".
 * Under an unexpected major the dependents are the list of things to fix, so more are shown; under
 * the expected major they are context, and a row like `@libp2p/interface@3.1.0` has 27 of them.
 */
const SHOWN_DEPENDENTS = { expected: 3, unexpected: 10 };

const WHY_IT_MATTERS = [
	'A package on a major other than the expected one cannot interoperate with the rest of this',
	'stack: a stream, peer id or key minted against one copy is structurally incompatible with the',
	'class from the other, and TypeScript does not reliably say so. Replace or remove the dependents',
	'listed under an UNEXPECTED major — or, if the whole tree has deliberately moved to a new major,',
	'update the expected major in scripts/shared-majors.cjs.'
].join('\n');

// NOTE: this paragraph is load-bearing, and a test fails if it is removed. The gossipsub failure
// arrived over a connection, and a green run must not be read as "a libp2p major mismatch cannot
// reach us". A peer on another build — a relay or bootstrap node from another repository, say — has
// its own lockfile, which no check in this repository can see.
const SCOPE = [
	'Scope: this guard covers packages resolved inside THIS workspace, including portal-linked',
	'sibling repositories. It says NOTHING about the libp2p version running on the other end of',
	'a live connection — a peer can still be a major behind and this check stays green.'
].join('\n');

/** The full report for a set of problems; empty when there are none. */
export function renderMajorProblems(problems) {
	if (problems.length === 0) return '';
	const sections = problems.map((problem) => (problem.kind === 'not-installed' ? renderNotInstalled(problem) : renderWrongMajor(problem)));
	if (problems.some((problem) => problem.kind === 'wrong-major')) sections.push(WHY_IT_MATTERS, SCOPE);
	return `${sections.join('\n\n')}\n`;
}

function renderNotInstalled({ ident, expected }) {
	return [
		`${ident} is guarded by scripts/shared-majors.cjs (expected major ${expected}), but is not installed anywhere in this project.`,
		'',
		'  The list is stale. Remove the entry if the package was dropped on purpose, or correct the name',
		'  if it is mistyped: a guard watching a package that is not installed passes no matter what the',
		'  tree contains.'
	].join('\n');
}

function renderWrongMajor({ ident, expected, groups }) {
	const header = groups.length === 1
		? `${ident} resolves only to ${majorLabel(groups[0].major)} in this project; expected major ${expected}.`
		: `${ident} resolves to ${groups.length} majors in this project; expected only major ${expected}.`;
	const width = Math.max(...groups.flatMap((group) => group.resolutions.map((r) => r.version.length))) + 2;
	const lines = [header];
	for (const group of groups) {
		const isExpected = group.major === expected;
		const limit = isExpected ? SHOWN_DEPENDENTS.expected : SHOWN_DEPENDENTS.unexpected;
		lines.push('', `  ${majorLabel(group.major)} (${isExpected ? 'expected' : 'UNEXPECTED'})`);
		for (const resolution of group.resolutions) {
			lines.push(`    ${resolution.version.padEnd(width)}${summarizeDependents(resolution.dependents, limit)}`);
		}
	}
	lines.push('', `  yarn why ${ident}    # full dependency paths (note: yarn prunes repeats)`);
	return lines.join('\n');
}

function majorLabel(major) {
	return major === null ? 'a version that is not semver' : `major ${major}`;
}

/** A readable, truncated dependent list — our own workspaces first, since those are the declarations a reader can change. */
function summarizeDependents(dependents, limit) {
	if (dependents.length === 0) return '(no dependents reported)';
	const ordered = [...dependents.filter(isWorkspaceLocator), ...dependents.filter((d) => !isWorkspaceLocator(d))];
	const shown = ordered.slice(0, limit).map(describeLocator).join(', ');
	return ordered.length > limit ? `${shown}, +${ordered.length - limit} more` : shown;
}

/**
 * A reference with its `virtual:` wrapper and `::` bindings removed, leaving the part that says
 * where the package came from. A `virtual:<hash>#` prefix marks one peer-dependency instance of the
 * reference after it; bindings (`::locator=...`, `::version=...`) are URL-encoded bookkeeping.
 */
function unwrapReference(reference) {
	return reference.replace(/^virtual:[^#]*#/, '').replace(/::.*$/, '');
}

function isWorkspaceLocator(locator) {
	const parsed = parseLocator(locator);
	return parsed !== null && unwrapReference(parsed.reference).startsWith('workspace:');
}

/**
 * A dependent locator as a reader would write it. Raw locators are unreadable in places: the
 * portal-linked `p2p-fret` comes back as a `virtual:` hash wrapping a `portal:` path with a
 * URL-encoded `::locator=` binding, about two hundred characters in all.
 */
export function describeLocator(locator) {
	const parsed = parseLocator(locator);
	if (!parsed) return locator;
	const reference = unwrapReference(parsed.reference);
	const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(reference)?.[1];
	switch (protocol) {
		case 'npm': return `${parsed.ident}@${reference.slice('npm:'.length)}`;
		case 'workspace': return `${parsed.ident} (workspace)`;
		case 'portal':
		case 'link':
		case 'file': return `${parsed.ident} (${reference})`;
		case 'patch': return `${parsed.ident} (patched)`;
		case undefined: return `${parsed.ident}@${reference}`;
		default: return `${parsed.ident} (${protocol})`;
	}
}

// -- The yarn command ----------------------------------------------------------------------------

/**
 * The `yarn info` call, as an executable plus an argument array (see `cliCommand` for why Windows
 * goes through cmd.exe). The package-name check is what makes that safe: no argument that passes it
 * can carry a character cmd.exe would interpret.
 *
 * @param {string[]} idents
 * @param {string} [os]  `process.platform`, injectable for tests.
 */
export function yarnInfoCommand(idents, os) {
	for (const ident of idents) {
		if (!PACKAGE_NAME_RE.test(ident)) throw new Error(`${JSON.stringify(ident)} is not a package name — check scripts/shared-majors.cjs`);
	}
	return cliCommand('yarn', ['info', '--all', '--recursive', '--json', '--dependents', ...idents], os);
}
