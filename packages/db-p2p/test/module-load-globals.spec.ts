import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneDecoded } from '../src/storage/raw-store-codec.js';

// Regression guard: loading the React Native entry must not make first-party code touch the globals
// Hermes (React Native's JavaScript engine) lacks.
//
// `storage/raw-store-codec.ts` used to run `new TextDecoder()` at module scope. Because `rn.ts`
// loads that module, `import '@optimystic/db-p2p/rn'` itself threw on a phone whose `TextDecoder`
// polyfill was not yet installed — before the importing app's own code could run. Four db-core
// modules and `cohort-topic/peer-codec.ts` did the same. Neither existing check could see it:
// `entry-parity.spec.ts` compares which modules the entries load, not what those modules evaluate,
// and `yarn check:rn` only bundles and compiles, and a call to a missing global compiles fine.
//
// This loads the entry in a fresh child process (see `support/module-load-globals-probe.ts` for why
// fresh, and why the globals are wrapped rather than deleted) and fails on any first-party use during
// the load. The lint rule `NO_MODULE_SCOPE_TEXT_DECODER` in eslint.config.js is the static guard for
// the same class; it also covers packages this runtime check never loads (db-p2p-storage-rn).
//
// Scope: this does NOT make the package run on a bare Hermes. multiformats and cborg still construct
// `TextDecoder` at their own module load, and db-core calls `structuredClone` on ordinary paths, so a
// host must still install both polyfills (readme.md § React Native). What it pins is narrower: our
// own code adds no load-time failure on top of that.
//
// "First-party" means a file under this repository and outside any `node_modules` — db-p2p's `src`
// and db-core's `dist`. The load runs under Node's package conditions, not React Native's, which
// changes which third-party builds load but not which first-party modules do.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const PROBE = path.join(packageRoot, 'test', 'support', 'module-load-globals-probe.ts');
const RESULT_PREFIX = 'module-load-globals-probe:';

type GlobalUse = { global: 'TextDecoder' | 'structuredClone'; phase: 'load' | 'calibrate' | 'use'; file: string };
type ProbeResult = { uses: GlobalUse[]; decoded: unknown[]; actionId: string };

function isFirstParty(file: string): boolean {
	if (!path.isAbsolute(file)) return false;
	const relative = path.relative(repoRoot, file);
	return !relative.startsWith('..') && !path.isAbsolute(relative)
		&& !relative.split(path.sep).includes('node_modules');
}

const display = (file: string): string =>
	path.isAbsolute(file) ? path.relative(repoRoot, file).split(path.sep).join('/') : file;

describe('React Native entry: globals Hermes lacks, at module load', function () {
	// One child process loading the whole entry graph through ts-node: ~5s locally.
	this.timeout(180_000);

	let result: ProbeResult;

	before(() => {
		const run = spawnSync(process.execPath, ['--import', './register.mjs', PROBE], {
			cwd: packageRoot,
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024,
		});
		const line = run.stdout?.split('\n').find(candidate => candidate.startsWith(RESULT_PREFIX));
		if (run.status !== 0 || line === undefined) {
			throw new Error(
				`module-load-globals probe failed (exit ${String(run.status)}${run.error ? `, ${run.error.message}` : ''}):\n` +
				`${run.stderr ?? ''}\n${run.stdout ?? ''}`
			);
		}
		result = JSON.parse(line.slice(RESULT_PREFIX.length)) as ProbeResult;
	});

	const firstPartyUses = (global: GlobalUse['global'], phase: GlobalUse['phase']): string[] =>
		result.uses
			.filter(use => use.global === global && use.phase === phase && isFirstParty(use.file))
			.map(use => display(use.file))
			.sort();

	it('records a use and attributes it to the calling file (the probe is not vacuous)', () => {
		const probe = display(PROBE);
		expect(firstPartyUses('TextDecoder', 'calibrate')).to.deep.equal([probe]);
		expect(firstPartyUses('structuredClone', 'calibrate')).to.deep.equal([probe]);
	});

	it('constructs no TextDecoder from first-party code while the entry loads', () => {
		expect(
			firstPartyUses('TextDecoder', 'load'),
			'these first-party modules construct TextDecoder at module load, which makes importing the ' +
				'React Native entry throw on Hermes before the host can install its polyfill. Build it on ' +
				'first use instead — see decoder() in src/storage/raw-store-codec.ts'
		).to.deep.equal([]);
	});

	it('calls no structuredClone from first-party code while the entry loads', () => {
		expect(
			firstPartyUses('structuredClone', 'load'),
			'these first-party modules call structuredClone at module load, which Hermes does not provide'
		).to.deep.equal([]);
	});

	it('the storage codec builds its decoder on first use, once, and still round-trips', () => {
		expect(
			firstPartyUses('TextDecoder', 'use'),
			'three decodeJson calls and one decodeActionId should share a single lazily-built decoder'
		).to.deep.equal(['packages/db-p2p/src/storage/raw-store-codec.ts']);
		expect(result.decoded).to.deep.equal([
			{ n: 1, list: ['a', 'b'] },
			{ n: 1, list: ['a', 'b'] },
			{ n: 1, list: ['a', 'b'] },
		]);
		expect(result.actionId).to.equal('probe-action');
	});
});

describe('cloneDecoded (the structuredClone replacement on the commit-preview path)', () => {
	it('returns an independent deep copy', () => {
		const original = { header: { id: 'b1' }, items: [['k', 1], ['j', 2]] };
		const copy = cloneDecoded(original);
		expect(copy).to.deep.equal(original);
		copy.header.id = 'changed';
		(copy.items[0] as unknown[]).push('extra');
		expect(original).to.deep.equal({ header: { id: 'b1' }, items: [['k', 1], ['j', 2]] });
	});

	it('passes undefined through (a preview with no base block)', () => {
		expect(cloneDecoded(undefined)).to.equal(undefined);
	});

	it('does not call structuredClone', () => {
		const native = globalThis.structuredClone;
		globalThis.structuredClone = () => { throw new Error('structuredClone called'); };
		try {
			expect(cloneDecoded({ a: [1, 2] })).to.deep.equal({ a: [1, 2] });
		} finally {
			globalThis.structuredClone = native;
		}
	});
});
