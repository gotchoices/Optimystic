/**
 * Every out-of-repository link a workspace carries is covered by a watch folder spelled the way the link
 * spells its target. metro-file-map keys a symlink's target by relativizing the literal `readlink` string
 * against the project root with a case-sensitive segment comparison, so a watch folder that spells a
 * segment differently than the link does files the sibling checkout under a key nothing crawled: the
 * portal `../quereus/packages/quereus` beside a `C:\Projects\Quereus` checkout failed `yarn check:rn`
 * with "Unable to resolve module @quereus/quereus" from the Quereus plugin's own `dist/`, because
 * metro.config.cjs derived the watch root with `fs.realpathSync.native` (`..\Quereus`) while Metro looked
 * the target up as `..\quereus`.
 *
 * Only directory-name case can drift: `path.relative` settles the drive letter case-insensitively, and
 * both paths go through the same relativization below the directory holding this repository.
 *
 * This asserts the invariant against whatever this machine's install actually linked. A checkout that
 * installed every dependency from npm links nothing out of the repository and the test finds no links to
 * judge, which is reported rather than passed silently.
 */

import assert from 'node:assert/strict';
import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const WORKSPACE_DIR = realpathSync.native(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = realpathSync.native(path.resolve(WORKSPACE_DIR, '..', '..'));

it('watches each out-of-repository link under the spelling the link itself uses', () => {
	const links = outOfRepoLinks();
	assert.ok(
		links.length > 0,
		'found no links out of this repository, so nothing proved. Expected at least the `@quereus/quereus` ' +
			'portal from the root `resolutions`; if this install really took it from npm, this test has nothing to ' +
			'say and metro.config.cjs\'s `siblingWatchRoots` is unexercised.'
	);

	const { watchFolders } = require('../metro.config.cjs');
	for (const { link, target } of links) {
		assert.ok(
			watchFolders.some((folder) => isInside(folder, target)),
			`${path.relative(REPO_ROOT, link)} resolves to ${target}, which no watch folder covers under that ` +
				`exact spelling (watching ${watchFolders.join(', ')}). Metro looks the target up by the literal ` +
				'spelling the link carries, so metro.config.cjs must derive the watch root with `fs.realpathSync` ' +
				'rather than `fs.realpathSync.native` (see `linkTarget` there).'
		);
	}
});

/** Every symlink directly under a workspace's `node_modules` whose target leaves this repository. */
function outOfRepoLinks() {
	const packagesDir = path.join(REPO_ROOT, 'packages');
	return listDir(packagesDir).flatMap((workspace) =>
		packageEntries(path.join(packagesDir, workspace, 'node_modules')).flatMap((link) => {
			const target = metroTargetOf(link);
			return target === undefined || isInside(REPO_ROOT, target) ? [] : [{ link, target }];
		})
	);
}

/**
 * The absolute target of `link` as Metro reads it: the literal `readlink` string, resolved against the
 * link's own directory when it is relative (Yarn writes absolute targets on Windows and relative ones
 * elsewhere), with no spelling correction. `undefined` for a real directory.
 */
function metroTargetOf(link) {
	if (!lstatSync(link).isSymbolicLink()) return undefined;
	const literal = readlinkSync(link);
	return path.resolve(path.dirname(link), literal);
}

/** `node_modules/<name>` and `node_modules/@scope/<name>`; dot-entries (`.bin`, `.cache`) skipped. */
function packageEntries(nodeModules) {
	return listDir(nodeModules)
		.filter((name) => !name.startsWith('.'))
		.flatMap((name) => name.startsWith('@')
			? listDir(path.join(nodeModules, name)).map((scoped) => path.join(nodeModules, name, scoped))
			: [path.join(nodeModules, name)]);
}

function listDir(dir) {
	try {
		return readdirSync(dir);
	} catch (error) {
		if (error.code === 'ENOENT') return [];
		throw error;
	}
}

/** Whether `target` is `root` or lies under it, compared the way metro-file-map compares: by segment, case-sensitively. */
function isInside(root, target) {
	const rootParts = root.split(path.sep);
	const targetParts = target.split(path.sep);
	// The drive letter (or the empty leading segment of a POSIX path) never decides this; everything below it does.
	return targetParts.length >= rootParts.length &&
		rootParts.slice(1).every((part, index) => part === targetParts[index + 1]) &&
		rootParts[0].toLowerCase() === targetParts[0].toLowerCase();
}
