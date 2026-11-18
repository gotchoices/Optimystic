/**
 * Tests for `scripts/release-notes.mjs`, the pure half of `scripts/gh-release.mjs`, run by node's
 * built-in test runner (`yarn test:harness` at the repository root). Nothing here calls gh or git.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	absoluteRepositoryLinks,
	findReleaseSection,
	formatPendingNotes,
	parsePendingNotes,
	releaseBody,
	sectionTitle,
	withoutSection
} from '../scripts/release-notes.mjs';

const REPO = 'https://github.com/gotchoices/Optimystic';

const PENDING = [
	'# Release notes — pending',
	'',
	'Notes not yet published.',
	'',
	'---',
	'',
	'# v1.28.0',
	'',
	'Intro.',
	'',
	'## A change',
	'',
	'See [the doc](docs/internals.md#client-nodes).',
	'',
	'---',
	'',
	'# v1.12.0 — published to npm, no GitHub release page yet',
	'',
	'Older.',
	''
].join('\n');

describe('parsePendingNotes', () => {
	it('splits on separator lines and formats back to the same text', () => {
		const notes = parsePendingNotes(PENDING);
		assert.equal(notes.sections.length, 2);
		assert.equal(formatPendingNotes(notes), PENDING);
	});

	it('does not split on a horizontal rule inside a line', () => {
		const notes = parsePendingNotes('pre\n---\n# v1.0.0\na --- b\n');
		assert.equal(notes.sections.length, 1);
	});
});

describe('findReleaseSection', () => {
	const { sections } = parsePendingNotes(PENDING);

	it('finds the section titled with the version', () => {
		assert.equal(findReleaseSection(sections, '1.28.0'), 0);
	});

	it('finds a titled section that carries a remark after the version', () => {
		assert.equal(findReleaseSection(sections, '1.12.0'), 1);
	});

	it('does not take a longer version for a shorter one', () => {
		assert.equal(findReleaseSection(sections, '1.2'), -1);
		assert.equal(findReleaseSection(sections, '1.28'), -1);
	});

	it('falls back to a leading Unreleased section', () => {
		const unreleased = parsePendingNotes('pre\n---\n# Unreleased — since v1.27.0\nx\n---\n# v1.27.0\ny\n');
		assert.equal(findReleaseSection(unreleased.sections, '1.28.0'), 0);
	});

	it('does not take an Unreleased section that is not first', () => {
		const later = parsePendingNotes('pre\n---\n# v1.27.0\ny\n---\n# Unreleased — since v0.25.1\nx\n');
		assert.equal(findReleaseSection(later.sections, '1.28.0'), -1);
	});
});

describe('releaseBody', () => {
	it('drops the heading and points repository links at the tag', () => {
		const { sections } = parsePendingNotes(PENDING);
		const body = releaseBody(sections[0], REPO, 'v1.28.0');
		assert.ok(!body.includes('# v1.28.0'));
		assert.ok(body.startsWith('Intro.'));
		assert.ok(body.includes(`](${REPO}/blob/v1.28.0/docs/internals.md#client-nodes)`));
	});
});

describe('absoluteRepositoryLinks', () => {
	it('leaves links with a scheme, an anchor, an absolute or a parent path alone', () => {
		const text = '[a](https://x.org/y) [b](#here) [c](/root) [d](../sib/x.md) [e](mailto:a@b.c)';
		assert.equal(absoluteRepositoryLinks(text, REPO, 'v1.0.0'), text);
	});

	it('tolerates a trailing slash on the repository URL', () => {
		assert.equal(absoluteRepositoryLinks('[a](docs/x.md)', `${REPO}/`, 'v1.0.0'), `[a](${REPO}/blob/v1.0.0/docs/x.md)`);
	});
});

describe('withoutSection', () => {
	it('removes one section and keeps the rest verbatim', () => {
		const notes = parsePendingNotes(PENDING);
		const rest = formatPendingNotes(withoutSection(notes, 0));
		assert.ok(!rest.includes('# v1.28.0'));
		assert.equal(sectionTitle(parsePendingNotes(rest).sections[0]), 'v1.12.0 — published to npm, no GitHub release page yet');
		assert.ok(rest.startsWith('# Release notes — pending'));
	});
});
