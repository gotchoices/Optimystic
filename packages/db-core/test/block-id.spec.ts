/**
 * `isValidBlockId` — the rule that keeps a block id, which the filesystem backend uses raw as a
 * relative path, from naming somewhere outside the store that was asked to hold it.
 *
 * This is the ONE place the rule's edges are pinned. The backends assert the same rule through
 * `KvRawStorage`, and their suites check that an escaping id is refused and the store survives it;
 * neither restates this table.
 */

import { expect } from 'chai';
import { assertValidBlockId, isValidBlockId, InvalidBlockIdError, type BlockId } from '../src/index.js';

describe('isValidBlockId', () => {
	it('accepts the ids the system actually uses', () => {
		const accepted: Record<string, string> = {
			'default/app/Ledger': 'a nested, human-named collection id — the case that must keep working',
			'a': 'a one-segment id',
			'bXkZ9-xQ_ePm3n1T4rVsLgKdHcBaWoYu0Ij2': 'a base64url-shaped random id',
			'a..b': 'dots INSIDE a segment: only a whole segment of dots can escape',
		};
		for (const [id, reason] of Object.entries(accepted)) {
			expect(isValidBlockId(id), `${JSON.stringify(id)} — ${reason}`).to.equal(true);
		}
	});

	it('rejects every id that would escape the store, or alias another id inside it', () => {
		const rejected: Record<string, string> = {
			'': 'the empty id, which resolves onto the store root itself',
			'..': 'the parent directory',
			'../escaped': 'an escape by a leading `..` segment',
			'a/../..': 'an escape by `..` segments after a real one',
			'/abs': 'an absolute POSIX path',
			'C:/elsewhere': 'a Windows drive prefix with a slash, which leaves the store',
			'C:elsewhere': 'a drive-relative Windows prefix, which means two different places on the two platforms',
			'a\\..\\..\\b': 'a backslash escape, which a `/`-split check alone would miss',
			'a//b': 'an empty interior segment, which aliases `a/b`',
			'./a': 'a leading `.` segment, which aliases `a`',
			'a/./b': 'an interior `.` segment, which aliases `a/b`',
			'a/': 'a trailing slash, which aliases `a`',
			'a\u0000b': 'a NUL, which makes `fs` throw rather than escape',
		};
		for (const [id, reason] of Object.entries(rejected)) {
			expect(isValidBlockId(id), `${JSON.stringify(id)} — ${reason}`).to.equal(false);
		}
	});

	// A block id arrives from a peer, so the declared type is not evidence that it is a string.
	it('rejects a non-string, which the type does not rule out at a network boundary', () => {
		expect(isValidBlockId(undefined as unknown as string)).to.equal(false);
		expect(isValidBlockId(42 as unknown as string)).to.equal(false);
	});

	it('assertValidBlockId throws an InvalidBlockIdError naming the id', () => {
		expect(() => assertValidBlockId('default/app/Ledger' as BlockId)).not.to.throw();
		expect(() => assertValidBlockId('../escaped' as BlockId)).to.throw(InvalidBlockIdError, '"../escaped"');
	});
});
