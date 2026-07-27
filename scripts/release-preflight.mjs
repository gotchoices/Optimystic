#!/usr/bin/env node
/**
 * Release preflight — the reminder gate in front of `yarn bump && yarn pub`.
 *
 * `yarn pub` publishes to npm: irreversible for a given version number. This script does NOT
 * run the checks itself (a release should not silently spend ten minutes rebuilding what you
 * just built); it states what `yarn check` covers, reports the tree state it *can* determine
 * cheaply, and requires an explicit typed confirmation.
 *
 * Bypass for automation: `--yes` (or CI=1 in the environment). Without a TTY and without an
 * explicit bypass it aborts rather than assuming consent.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, env, exit } from 'node:process';
import { execFileSync } from 'node:child_process';

const CONFIRM_WORD = 'release';

/** Cheap, objectively-determinable facts worth putting in front of the user before they confirm. */
function gitFacts() {
	const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
	try {
		return {
			ok: true,
			branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
			dirty: git('status', '--porcelain').length > 0,
			// A release from a branch behind its remote publishes code that isn't what origin has.
			ahead: git('rev-list', '--count', '@{upstream}..HEAD'),
			behind: git('rev-list', '--count', 'HEAD..@{upstream}')
		};
	} catch {
		// No repo, no upstream configured, or git absent — report rather than fail the release.
		return { ok: false };
	}
}

function report() {
	const facts = gitFacts();
	stdout.write('\nRelease preflight\n');
	stdout.write('─────────────────\n\n');
	stdout.write('`yarn pub` publishes to npm. A published version cannot be replaced.\n\n');
	stdout.write('Run `yarn check` first if you have not already. It covers:\n');
	stdout.write('  • yarn lint              eslint across the monorepo\n');
	stdout.write('  • yarn build             every package compiles\n');
	stdout.write('  • yarn test              unit suites (fast, always-run)\n');
	stdout.write('  • yarn test:integration  real-socket libp2p suites (env-gated, NOT in `yarn test`)\n\n');

	if (facts.ok) {
		stdout.write(`Working tree: ${facts.dirty ? 'DIRTY — uncommitted changes present' : 'clean'}\n`);
		stdout.write(`Branch:       ${facts.branch}\n`);
		if (facts.behind !== '0') stdout.write(`Upstream:     ${facts.behind} commit(s) BEHIND origin\n`);
		else if (facts.ahead !== '0') stdout.write(`Upstream:     ${facts.ahead} commit(s) ahead of origin (bump will push)\n`);
		else stdout.write('Upstream:     in sync\n');
		stdout.write('\n');
	}

	return facts;
}

const bypass = argv.includes('--yes') || argv.includes('-y') || env['CI'] === '1' || env['CI'] === 'true';

if (bypass) {
	report();
	stdout.write('Preflight bypassed (--yes / CI). Proceeding.\n\n');
	exit(0);
}

const facts = report();

if (!stdin.isTTY) {
	stdout.write('No interactive terminal available, and no --yes flag. Aborting rather than\n');
	stdout.write('assuming consent to publish. Re-run with `--yes` if this is intentional.\n\n');
	exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
try {
	if (facts.ok && facts.dirty) {
		stdout.write('The working tree is dirty. `yarn bump` will commit whatever is staged.\n\n');
	}
	const answer = await rl.question(`Type "${CONFIRM_WORD}" to bump, tag, push, and publish: `);
	if (answer.trim().toLowerCase() !== CONFIRM_WORD) {
		stdout.write('\nAborted. Nothing was bumped or published.\n\n');
		exit(1);
	}
	stdout.write('\n');
} finally {
	rl.close();
}
