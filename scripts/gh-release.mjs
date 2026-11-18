#!/usr/bin/env node
/**
 * Creates the GitHub release for the version in the root `package.json`, the last step of
 * `yarn release`.
 *
 * The body is that version's section of `.release-notes.pending.md` (`findReleaseSection` in
 * `scripts/release-notes.mjs`), with repository links pointed at the tag. Once GitHub holds it, the
 * section is removed from the file and the removal is committed and pushed, so the file keeps only
 * notes no release page carries yet. With no such section the release takes GitHub's generated
 * notes and the file is left alone.
 *
 * `--dry-run` prints the title and body and changes nothing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import {
	findReleaseSection,
	formatPendingNotes,
	parsePendingNotes,
	releaseBody,
	sectionTitle,
	withoutSection
} from './release-notes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PENDING = '.release-notes.pending.md';

/** @param {string} file @param {string[]} args */
function run(file, args) {
	return execFileSync(file, args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function rootVersion() {
	return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

function readPending() {
	try {
		return readFileSync(join(ROOT, PENDING), 'utf8');
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
		throw error;
	}
}

/** @param {string} tag @param {string | undefined} body */
function createRelease(tag, body) {
	if (body === undefined) {
		run('gh', ['release', 'create', tag, '--title', tag, '--verify-tag', '--generate-notes']);
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), 'optimystic-release-'));
	try {
		const notesFile = join(dir, 'notes.md');
		writeFileSync(notesFile, body);
		run('gh', ['release', 'create', tag, '--title', tag, '--verify-tag', '--notes-file', notesFile]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** @param {string} text @param {string} tag */
function commitRemoval(text, tag) {
	writeFileSync(join(ROOT, PENDING), text);
	run('git', ['add', PENDING]);
	run('git', ['commit', '-m', `docs: ${tag} release notes are on GitHub`]);
	run('git', ['push']);
}

function main() {
	const dryRun = argv.includes('--dry-run');
	const tag = `v${rootVersion()}`;
	const text = readPending();
	const notes = text === undefined ? undefined : parsePendingNotes(text);
	const index = notes === undefined ? -1 : findReleaseSection(notes.sections, tag.slice(1));
	const section = notes !== undefined && index !== -1 ? notes.sections[index] : undefined;
	const repoUrl = section === undefined ? '' : run('gh', ['repo', 'view', '--json', 'url', '--jq', '.url']);
	const body = section === undefined ? undefined : releaseBody(section, repoUrl, tag);

	if (dryRun) {
		stdout.write(`${tag}\n${section === undefined ? '(generated notes)' : `from "${sectionTitle(section)}"`}\n\n${body ?? ''}\n`);
		return;
	}

	stdout.write(section === undefined
		? `Creating release ${tag} with generated notes (no section for it in ${PENDING})\n`
		: `Creating release ${tag} from "${sectionTitle(section)}" in ${PENDING}\n`);
	createRelease(tag, body);
	stdout.write(`Created release ${tag}\n`);

	if (notes !== undefined && index !== -1) {
		commitRemoval(formatPendingNotes(withoutSection(notes, index)), tag);
		stdout.write(`Removed its section from ${PENDING}, committed and pushed\n`);
	}
}

try {
	main();
} catch (error) {
	stdout.write(`gh-release failed: ${error instanceof Error ? error.message : String(error)}\n`);
	exit(1);
}
