#!/usr/bin/env node
/**
 * Documentation citation checker — keeps prose pointers into the source tree honest.
 *
 * Prose used to cite code by file *and line number* (`ring-selector.ts:79`). Nothing verified
 * those, and an edit above the cited line left the citation looking valid while pointing at
 * unrelated code. The convention (documented in AGENTS.md § Documentation citations) replaces the
 * line number with an *anchor* — a symbol name, or a short quoted fragment where no symbol fits —
 * bound to a path. An anchor survives edits above it and, when it does break, breaks loudly.
 *
 * This script enforces that convention:
 *   - no line-number citations in prose,
 *   - every path-shaped token names a file that is actually tracked,
 *   - every anchored citation's anchor is actually present in the file it names,
 *   - every doc-to-doc link resolves, including its `#section` anchor.
 *
 * Following `release-preflight.mjs`: plain .mjs, no build step, no dependencies.
 * Wired as `yarn lint:docs`, and chained into `yarn check`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stdout, stderr, exit, argv } from 'node:process';

// -- Scope -------------------------------------------------------------------------------------

// NOTE: `tickets/**` is excluded deliberately, not by oversight. Tickets carry hundreds of
// line-number citations and are point-in-time work records — a ticket in `complete/` is *supposed*
// to describe the tree as it stood when it was written. Active tickets in `backlog/`, `plan/` and
// `fix/` do carry the same rot, but the ticket workflow already instructs agents to re-derive line
// numbers rather than trust them. If ticket citations ever start actually misleading agents in
// practice, the fix is to widen this scope — not to write a second checker.
const EXCLUDED = [
	(p) => p.startsWith('tickets/'),
	(p) => p.split('/').includes('node_modules'),
	(p) => p === 'CHANGELOG.md' || p.endsWith('/CHANGELOG.md')
];

/** Extensions a path-shaped token may end in. Anything else is prose, not a file reference. */
const PATH_EXTENSIONS = new Set([
	'ts', 'tsx', 'mts', 'cts', 'js', 'mjs', 'cjs', 'jsx',
	'json', 'md', 'yml', 'yaml', 'toml', 'proto', 'sql',
	'sh', 'html', 'css', 'txt', 'svg'
]);

/**
 * Extensions whose existence is actually policed: the source and documentation this repo authors.
 * Everything else in `PATH_EXTENSIONS` still *reads* as a path (so it is never mistaken for a
 * symbol anchor) but is not required to exist, because a `.js`/`.json`/`.yml` token in prose here
 * is nearly always an illustrative user file (`node --inspect app.js`), a product name (`Node.js`),
 * a runtime artifact (the `meta.json` a storage backend writes, `coordinator/key1.json`), or a
 * config from another toolchain — not something tracked here. Only two `.js` files are tracked in
 * the whole repository, so policing that extension would be almost pure false positives, and a
 * check that cries wolf is a check people learn to ignore.
 */
const CHECKED_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'mjs', 'md']);

/** NodeNext import specifiers are written `./foo.js` while the file on disk is `foo.ts`. */
const SPECIFIER_FALLBACKS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts', '.ts'], '.cjs': ['.cts', '.ts'] };

// -- Tracked-file index --------------------------------------------------------------------------

/**
 * Tracked paths, straight from git. Never a filesystem walk: an untracked `node_modules` walk pulls
 * in thousands of vendored markdown files. Never `existsSync` either — on Windows and macOS a
 * case-insensitive lookup reports `packages/db-p2p/README.md` as present when the tracked file is
 * `readme.md`, silently masking a link that is broken on Linux and on github.com.
 */
function trackedFiles() {
	let raw;
	try {
		// `--others --exclude-standard` includes files that exist but are not committed yet, so a
		// document may cite a file added in the same change without the check failing until it is
		// staged. `--exclude-standard` still honours .gitignore, which is what keeps `node_modules`
		// and `dist` out.
		raw = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	} catch (err) {
		stderr.write('check-doc-citations: could not run `git ls-files`. This check needs a git working\n');
		stderr.write('tree (a tarball export will not do). Underlying error:\n');
		stderr.write(`  ${err && err.message ? err.message : String(err)}\n`);
		exit(1);
	}
	// git reports POSIX separators already; normalize anyway so nothing downstream has to care.
	return raw.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
}

/**
 * Index every tracked path by each of its `/`-boundary suffixes, so package-relative citations
 * (`cluster/cluster-policy.ts`) and bare filenames (`ring-selector.ts`) resolve without forcing
 * every mention in flowing prose to spell out a repo-relative path.
 */
function buildSuffixIndex(paths) {
	const index = new Map();
	for (const path of paths) {
		const segments = path.split('/');
		for (let i = 0; i < segments.length; i++) {
			const suffix = segments.slice(i).join('/');
			const bucket = index.get(suffix);
			if (bucket) bucket.push(path);
			else index.set(suffix, [path]);
		}
	}
	return index;
}

// -- Fenced-block handling -----------------------------------------------------------------------

/**
 * Blank every fenced code block, preserving line count so reported line numbers stay correct. A
 * fence is a transcript or a snippet, not prose making a claim about where code lives.
 *
 * Returns the blanked text plus a finding if a fence was never closed — an unterminated fence must
 * not silently blank the remainder of the file and turn real breakage into a pass.
 */
// A fence delimiter is 3+ backticks/tildes at line start; list indentation and blockquote markers
// are allowed before it, so a fence nested inside a `>` quote is still a fence.
const FENCE_RE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/;

function blankFences(text) {
	const lines = text.split('\n');
	const out = lines.slice();
	const findings = [];
	let open = null;
	for (let i = 0; i < lines.length; i++) {
		const match = FENCE_RE.exec(lines[i]);
		if (open !== null) {
			// Every line of an open block is blanked, delimiter and content alike. Blanking only
			// the delimiters would leave the block's body being read as prose — which is the
			// opposite of the exemption this function exists to provide.
			out[i] = '';
			if (match && match[1][0] === open.char && match[1].length >= open.length && match[2].trim() === '') open = null;
			continue;
		}
		if (!match) continue;
		// CommonMark: a backtick opener's info string may not itself contain a backtick. That rule
		// is what keeps an inline span from being read as an opener.
		if (match[1][0] === '`' && match[2].includes('`')) continue;
		open = { char: match[1][0], length: match[1].length, line: i };
		out[i] = '';
	}
	if (open !== null) {
		findings.push({ line: open.line + 1, message: 'unterminated code fence — close it, or everything below it goes unchecked' });
		// Restore the region rather than leaving it blanked: an unterminated fence is an authoring
		// bug, and swallowing everything after it is exactly the silent pass this check exists to
		// prevent.
		for (let i = open.line; i < lines.length; i++) out[i] = lines[i];
	}
	return { text: out.join('\n'), findings };
}

/**
 * Replace line-leading blockquote markers with spaces, preserving every offset so reported line
 * numbers stay correct. A citation wrapped across a line inside a block quote otherwise has a `>`
 * sitting between its anchor and its path, and would be silently skipped — a false pass.
 */
function blankQuoteMarkers(text) {
	return text.replace(/^[ \t]*(?:>[ \t]?)+/gm, (marker) => ' '.repeat(marker.length));
}

// -- GitHub heading slugs ------------------------------------------------------------------------

/**
 * Slugify a heading the way GitHub does: drop every character that is neither a word character,
 * whitespace, nor a hyphen; lowercase; then replace **each** remaining whitespace character with a
 * hyphen. Runs of whitespace are deliberately NOT collapsed — the em-dash in
 * `## Part 1 — Damping the ring-shift decision` is stripped and leaves two adjacent spaces, so the
 * real anchor is `part-1--damping-the-ring-shift-decision`, with two hyphens.
 */
function slugifyHeading(heading) {
	return heading
		.replace(/[^\p{L}\p{N}_\s-]/gu, '')
		.toLowerCase()
		.replace(/\s/g, '-');
}

/** All heading slugs in a document, including GitHub's `-1`, `-2`, ... suffixes for duplicates. */
function headingSlugs(text) {
	const slugs = new Set();
	const seen = new Map();
	for (const line of blankFences(text).text.split('\n')) {
		const match = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
		if (!match) continue;
		const base = slugifyHeading(match[1]);
		if (base === '') continue;
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		slugs.add(count === 0 ? base : `${base}-${count}`);
	}
	return slugs;
}

// -- Path tokens ---------------------------------------------------------------------------------

/**
 * A path-shaped token, anchored: the whole string must be the path. Anchoring is what keeps
 * `github:user/repo/path/to/plugin.js` and `https://example.com/plugin.js` from being read as
 * repo-relative paths.
 */
const TOKEN_RE = /^((?:\.{1,2}\/)*[A-Za-z0-9_@][A-Za-z0-9_@./-]*\.[A-Za-z0-9]{1,6})$/;

/** Does this token look like a claim about a file at all? */
function isPathShaped(token) {
	const clean = token.replace(/^\.\//, '');
	// A token with a directory component is a path even without an extension. This is what stops
	// `(`packages/substrate-simulator`, `walk.ts`)` from reading as "symbol in file".
	if (clean.includes('/')) return true;
	const dot = clean.lastIndexOf('.');
	if (dot < 0) return false;
	return PATH_EXTENSIONS.has(clean.slice(dot + 1).toLowerCase());
}

/**
 * Path tokens that are not claims about *this* repository, and so are not ours to verify. Returns a
 * reason string when the token should be skipped, otherwise null.
 */
function skipReason(token) {
	if (/^[a-z][a-z0-9+.-]*:/i.test(token)) return 'uri-scheme';
	if (token.startsWith('../')) return 'sibling-repo';          // ../../Fret/docs/fret.md
	// NOTE: skipping `@scope/`-prefixed paths is a real blind spot, not just a simplification —
	// `docs/transactions.md` cited two `@quereus/quereus/src/...` files that do not exist and the
	// check passed. Widening it is tracked as `debt-external-citations-unverified`.
	if (token.startsWith('@')) return 'npm-scope';               // @quereus/quereus/src/parser/parser.ts
	if (/[*<>{}\s]/.test(token)) return 'glob-or-placeholder';
	const segments = token.replace(/^\.\//, '').split('/');
	if (segments.includes('dist') || segments.includes('node_modules')) return 'build-output';
	const basename = segments[segments.length - 1];
	// `.d.ts` used as a category noun has no stem before its extension.
	if (!/^[A-Za-z0-9_]/.test(basename)) return 'no-stem';
	// NOTE: `tess/` is a submodule — its contents are not in this repository's index — and
	// `tickets/` holds transient work records that get swept once they age out, the same reason the
	// document scope above skips them. Neither is ours to keep in sync.
	if (segments[0] === 'tess' || segments[0] === 'tickets') return 'external-tooling';
	if (!CHECKED_EXTENSIONS.has(basename.slice(basename.lastIndexOf('.') + 1).toLowerCase())) return 'unpoliced-extension';
	return null;
}

/** Every tracked path a token could name. Empty when it names nothing tracked. */
function resolvePath(token, index) {
	const clean = token.replace(/^\.\//, '');
	const direct = index.get(clean);
	if (direct) return direct;
	for (const [specifier, fallbacks] of Object.entries(SPECIFIER_FALLBACKS)) {
		if (!clean.endsWith(specifier)) continue;
		const stem = clean.slice(0, -specifier.length);
		const matches = [];
		for (const fallback of fallbacks) {
			const hit = index.get(stem + fallback);
			if (hit) matches.push(...hit);
		}
		if (matches.length) return matches;
	}
	return [];
}

// -- Anchored citations --------------------------------------------------------------------------

/**
 * A citation binds an anchor to a path. Exactly two connectors are recognised, because a looser
 * rule turns every incidental neighbouring pair of a symbol and a filename into a citation and
 * buries the real findings under noise:
 *
 *   `determineRing` in `packages/db-p2p/src/storage/ring-selector.ts`
 *   (`disputeEnabled`, `packages/db-p2p/src/dispute/types.ts`)
 *
 * The parenthesised form is accepted in either order — `(`.../block-latch.ts`, `blockWriteLatchKey`)`
 * is house style too. Both tolerate a newline between anchor and path: a citation wrapped across a
 * line break is still a citation, and skipping it would be a false *pass* — worse than a false
 * failure, because nothing signals it.
 *
 * NOTE: a citation written in some third shape degrades quietly to an unverified bare mention —
 * its path is still required to exist, but its anchor is never checked. That is the deliberate
 * trade for keeping the false-positive rate at zero. If anchor rot ever slips through in practice,
 * add the shape here rather than loosening the connectors into a proximity heuristic; a proximity
 * rule was tried during this ticket and produced roughly a dozen false failures across the tree.
 */
const BACKTICK_SPAN_RE = /`([^`\n]+)`/g;
const QUOTED_SPAN_RE = /[“"]([^”"\n]{3,})[”"]/g;
const IN_CONNECTOR_RE = /^[^`.;:!?,]{0,40}\bin\s+$/s;
const COMMA_CONNECTOR_RE = /^[^`.;:!?\n]{0,48},\s+$/s;

/** All inline code spans and double-quoted fragments, in document order. */
function findSpans(text) {
	const spans = [];
	for (const re of [BACKTICK_SPAN_RE, QUOTED_SPAN_RE]) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(text)) !== null) {
			spans.push({ start: m.index, end: m.index + m[0].length, value: m[1], quoted: re === QUOTED_SPAN_RE });
		}
	}
	return spans.sort((a, b) => a.start - b.start);
}

/** Are these two spans the entire contents of one `(...)` group? */
function sharesParenGroup(text, start, end) {
	let open = -1;
	for (let i = start - 1; i >= 0 && start - i <= 200; i--) {
		const c = text[i];
		if (c === ')') return false;
		if (c === '(') { open = i; break; }
	}
	if (open < 0) return false;
	let j = end;
	while (j < text.length && /\s/.test(text[j])) j++;
	return text[j] === ')';
}

/**
 * A backticked anchor must be symbol-shaped: an identifier, optionally dotted, optionally with a
 * call's argument list. Anything else in backticks beside a filename is incidental neighbouring
 * prose — a shell command (`yarn typecheck`), a ticket slug, a wire-field placeholder
 * (`@<actionId>`) — and reading it as an anchor produces noise, not findings. The convention's
 * escape hatch for non-symbol anchors is the double-quoted fragment, which skips this test.
 *
 * A span that is itself a path is never an anchor either: `(`walk.ts`, `promotion.ts`)` is a
 * two-file list, not a citation of one inside the other.
 */
const SYMBOL_ANCHOR_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function usableAnchor(span) {
	if (span.quoted) return true;
	if (isPathShaped(span.value)) return false;
	const bare = /^(.*?)\s*\([^()]*\)\s*$/.exec(span.value);
	return SYMBOL_ANCHOR_RE.test(bare ? bare[1] : span.value);
}

function findCitations(text, spans) {
	const citations = [];
	for (let i = 0; i < spans.length; i++) {
		const path = spans[i];
		// A line-number citation is reported by the ban below; do not also report it here as an
		// unresolvable path, which would be the same defect counted twice.
		if (path.quoted || !TOKEN_RE.test(path.value) || !isPathShaped(path.value)) continue;

		const before = spans[i - 1];
		if (before && before.end <= path.start && usableAnchor(before)) {
			const connector = text.slice(before.end, path.start);
			if (IN_CONNECTOR_RE.test(connector)
				|| (COMMA_CONNECTOR_RE.test(connector) && sharesParenGroup(text, before.start, path.end))) {
				citations.push({ anchor: before, path });
				continue;
			}
		}
		const after = spans[i + 1];
		if (after && path.end <= after.start && usableAnchor(after)) {
			const connector = text.slice(path.end, after.start);
			if (COMMA_CONNECTOR_RE.test(connector) && sharesParenGroup(text, path.start, after.end)) {
				citations.push({ anchor: after, path });
			}
		}
	}
	return citations;
}

const normalize = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Progressively looser renderings of a backticked anchor, most literal first. The reduction is
 * required, not cosmetic: docs write `ClusterCoordinator.executeTransaction` and
 * `buildNotificationV1(event, commitCert, ctx)` where the source carries only the bare name, or
 * carries it with type annotations the doc omits.
 *
 * `randomBytes(16)` and `randomBytes(32)` deliberately keep their argument and match literally —
 * the distinction between the two is the entire point of those citations.
 */
function anchorCandidates(anchor) {
	const candidates = [anchor];
	const withoutArgs = /^(.*?)\s*\([^()]*\)\s*$/.exec(anchor);
	if (withoutArgs) candidates.push(withoutArgs[1]);
	for (const candidate of candidates.slice()) {
		const unqualified = /^(?:[A-Za-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)$/.exec(candidate);
		if (unqualified) candidates.push(unqualified[1]);
	}
	return [...new Set(candidates.map(normalize).filter(Boolean))];
}

// -- The check -----------------------------------------------------------------------------------

const LINE_NUMBER_RE = /(?<![A-Za-z0-9_@:./-])([A-Za-z0-9_@./-]*[A-Za-z0-9_]\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|md)):(\d+(?:-\d+)?)/g;
// NOTE: only inline `[text](target)` links are checked. A link carrying a title
// (`](target "title")`) or written reference-style (`[text][ref]` plus a `[ref]: target`
// definition) is silently skipped; neither shape appears anywhere in this tree today. If one is
// introduced, extend this regex rather than assuming those links are covered.
const LINK_RE = /\[(?:[^\]\n]*)\]\(\s*([^)\s]+?)\s*\)/g;

/** The repository facts every check needs: what exists, and how to read it. */
function buildRepoIndex() {
	const tracked = trackedFiles();
	const directories = new Set();
	for (const path of tracked) {
		const segments = path.split('/');
		for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join('/'));
	}
	const caches = new Map();
	const cached = (kind, path, build) => {
		const key = `${kind}\0${path}`;
		if (!caches.has(key)) {
			let text = '';
			try { text = readFileSync(path, 'utf8'); } catch { /* unreadable: treat as empty */ }
			caches.set(key, build(text));
		}
		return caches.get(key);
	};
	return {
		index: buildSuffixIndex(tracked),
		trackedSet: new Set(tracked),
		directories,
		docs: tracked.filter((p) => p.endsWith('.md') && !EXCLUDED.some((skip) => skip(p))),
		/** Whitespace-normalized source text, for anchor searches. */
		sourceText: (path) => cached('text', path, normalize),
		slugsFor: (path) => cached('slugs', path, headingSlugs)
	};
}

/** Character offset to 1-based line number, without re-splitting the document at every lookup. */
function lineLookup(text) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
	return (offset) => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
}

/**
 * No allowlist and no per-citation escape marker: the convention keeps zero line numbers, so an
 * exception mechanism would only be a place for drift to hide. Fenced blocks are the entire escape
 * hatch, and a stack trace or tool transcript belongs in a fence anyway.
 */
function checkLineNumbers(text, lineOf, report) {
	LINE_NUMBER_RE.lastIndex = 0;
	let match;
	while ((match = LINE_NUMBER_RE.exec(text)) !== null) {
		if (!TOKEN_RE.test(match[1]) || !isPathShaped(match[1])) continue;
		report(lineOf(match.index), `line-number citation \`${match[0]}\`\n  — line numbers rot silently; cite a symbol or a quoted fragment instead, e.g. \`someSymbol\` in \`${match[1]}\``);
	}
}

/**
 * The path must resolve to exactly one file, and the anchor must still be findable in it. Returns
 * how many citations were actually checked, for the summary line.
 */
function checkCitations(citations, repo, lineOf, report) {
	let checked = 0;
	for (const { anchor, path } of citations) {
		const token = path.value;
		if (skipReason(token)) continue;
		checked++;
		const matches = resolvePath(token, repo.index);
		if (matches.length === 0) {
			report(lineOf(path.start), `citation names \`${token}\`, which is not a tracked file`);
			continue;
		}
		if (matches.length > 1) {
			const shown = matches.slice(0, 3).join(', ') + (matches.length > 3 ? ', ...' : '');
			report(lineOf(path.start), `citation path \`${token}\` is ambiguous — ${matches.length} tracked files match (${shown})\n  — add leading path segments so the anchor can be checked against one file`);
			continue;
		}
		const target = matches[0];
		const haystack = repo.sourceText(target);
		if (anchor.quoted) {
			if (!haystack.includes(normalize(anchor.value))) {
				report(lineOf(anchor.start), `quoted anchor "${anchor.value}" not found in ${target}\n  — the quotation has drifted from the source; re-read it and requote`);
			}
			continue;
		}
		const candidates = anchorCandidates(anchor.value);
		if (!candidates.some((c) => haystack.includes(c))) {
			report(lineOf(anchor.start), `anchor \`${anchor.value}\` not found in ${target}\n  — searched for ${candidates.map((c) => `\`${c}\``).join(', ')}; the symbol was renamed, moved, or never lived there`);
		}
	}
	return checked;
}

/**
 * A filename in flowing prose is a mention, not a citation, but it still has to name something that
 * exists. One-or-more matches is enough — only an anchored citation needs to pin down a single
 * file. Only inline code spans count: unmarked prose says "Node.js, browsers, and React Native are
 * first-class", which is not a claim about a file.
 */
function checkMentions(spans, citedSpans, repo, lineOf, report) {
	let checked = 0;
	for (const span of spans) {
		if (span.quoted || citedSpans.has(span.start)) continue;
		const token = span.value.trim();
		if (!TOKEN_RE.test(token) || !isPathShaped(token) || skipReason(token)) continue;
		checked++;
		if (resolvePath(token, repo.index).length === 0) {
			report(lineOf(span.start), `\`${token}\` does not name any tracked file\n  — the file was renamed, moved, or never existed`);
		}
	}
	return checked;
}

/** Resolve a link target against the citing document. Null when it climbs above the repo root. */
function resolveLinkTarget(doc, rawTarget) {
	if (rawTarget === '') return doc;                        // a bare `#section` links this document
	const resolved = [];
	for (const segment of [...doc.split('/').slice(0, -1), ...rawTarget.split('/')]) {
		if (segment === '.' || segment === '') continue;
		if (segment !== '..') resolved.push(segment);
		else if (resolved.length) resolved.pop();
		else return null;                                      // points at a sibling checkout
	}
	return resolved.join('/');
}

/**
 * The target must resolve relative to *this* document, and a `#section` must match a heading in the
 * target. Compared case-sensitively against git's index — a link to `packages/db-p2p/README.md`
 * when the tracked file is `readme.md` works on Windows and breaks on Linux and on github.com, and
 * that is exactly the class this catches.
 */
function checkLinks(doc, text, repo, lineOf, report) {
	let checked = 0;
	LINK_RE.lastIndex = 0;
	let link;
	while ((link = LINK_RE.exec(text)) !== null) {
		const raw = link[1].replace(/^</, '').replace(/>$/, '');
		if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
		const hash = raw.indexOf('#');
		const rawTarget = hash < 0 ? raw : raw.slice(0, hash);
		const fragment = hash < 0 ? '' : raw.slice(hash + 1);

		const target = resolveLinkTarget(doc, rawTarget);
		if (target === null) continue;
		checked++;
		if (!repo.trackedSet.has(target)) {
			// A link may legitimately name a directory (`[tickets/](tickets/)`, a source module
			// folder). Accept it when the tree actually has one.
			if (repo.directories.has(target)) continue;
			report(lineOf(link.index), `link target \`${rawTarget || raw}\` does not resolve to a tracked file or directory (looked for \`${target}\`)`);
			continue;
		}
		if (!fragment || !target.endsWith('.md')) continue;
		if (!repo.slugsFor(target).has(fragment.toLowerCase())) {
			report(lineOf(link.index), `link \`${rawTarget}#${fragment}\` names no heading in ${target}\n  — the heading was renamed; check its GitHub anchor slug`);
		}
	}
	return checked;
}

function run() {
	const repo = buildRepoIndex();
	if (repo.docs.length === 0) {
		stderr.write('check-doc-citations: the scope filter matched zero documents. That is a bug in this\n');
		stderr.write('script, not a clean tree — refusing to report success.\n');
		exit(1);
	}

	const findings = [];
	const counts = { citations: 0, mentions: 0, links: 0 };

	for (const doc of repo.docs) {
		const { text: defenced, findings: fenceFindings } = blankFences(readFileSync(doc, 'utf8'));
		const text = blankQuoteMarkers(defenced);
		const lineOf = lineLookup(text);
		const report = (line, message) => findings.push({ doc, line, message });
		for (const f of fenceFindings) report(f.line, f.message);

		const spans = findSpans(text);
		const citations = findCitations(text, spans);
		const citedSpans = new Set(citations.map((c) => c.path.start));

		checkLineNumbers(text, lineOf, report);
		counts.citations += checkCitations(citations, repo, lineOf, report);
		counts.mentions += checkMentions(spans, citedSpans, repo, lineOf, report);
		counts.links += checkLinks(doc, text, repo, lineOf, report);
	}

	// The same broken name often appears as both link text and link target on one line; report it
	// once so the output stays a to-do list rather than a transcript.
	const unique = [...new Map(findings.map((f) => [`${f.doc} ${f.line} ${f.message}`, f])).values()];
	unique.sort((a, b) => (a.doc === b.doc ? a.line - b.line : a.doc.localeCompare(b.doc)));
	for (const f of unique) stdout.write(`${f.doc}:${f.line}: ${f.message}\n`);

	if (unique.length) {
		stdout.write(`\ncheck-doc-citations: ${unique.length} finding(s) across ${repo.docs.length} documents.\n`);
		stdout.write('See AGENTS.md § Documentation citations for the convention.\n');
		exit(1);
	}
	stdout.write(`check-doc-citations: ${repo.docs.length} documents, ${counts.citations} anchored citations, ${counts.mentions} file mentions, ${counts.links} links — all resolve.\n`);
}

if (argv.includes('--help') || argv.includes('-h')) {
	stdout.write('Usage: node scripts/check-doc-citations.mjs\n\n');
	stdout.write('Verifies that documentation citations point at code that still exists.\n');
	stdout.write('Exits non-zero and prints every finding when any citation is broken.\n');
	stdout.write('See AGENTS.md § Documentation citations for the convention it enforces.\n');
	exit(0);
}

run();
