import { expect } from 'chai'
import {
	computeClusterCommitHash,
	computeClusterMessageHash,
	computeClusterPromiseHash,
	membershipDigestFromIds,
} from '../src/cluster/membership.js'
import type { Signature } from '../src/cluster/structs.js'
import type { BlockId, RepoMessage } from '../src/index.js'

/**
 * The signed preimage layout of `docs/correctness.md` §2, pinned to literal values computed before
 * the hashes were built from memoized message bytes. Every stored `BlockCommitProof` and every
 * mixed-version cohort verifies against these exact bytes, so no change to how the preimage is
 * produced may move any of them.
 */
describe('cluster record hash layout', () => {
	// A non-ASCII string (Latin-1, BMP CJK, and an astral-plane character encoded as a surrogate pair)
	// so the UTF-8 encoding of the canonical JSON is exercised, not just its ASCII subset.
	const message = (): RepoMessage => ({
		operations: [{
			pend: {
				actionId: 'action-1',
				rev: 4,
				policy: 'c',
				transforms: {
					inserts: { ['b1' as BlockId]: { header: { id: 'b1' as BlockId, type: 'T', collectionId: 'c1' as BlockId }, value: 'héllo 日本 🦉' } as never },
					updates: { ['b2' as BlockId]: [['entries', 0, 0, ['ünïcødé ✓']]] },
					deletes: [],
				},
				baseRevs: { ['b2' as BlockId]: 3 },
			},
		}],
		expiration: 1_700_000_000_000,
	})
	const promises: Record<string, Signature> = {
		'peer-B': { type: 'reject', signature: 'sig-b', rejectReason: 'stale ✗' },
		'peer-A': { type: 'approve', signature: 'sig-a' },
	}

	it('derives the membership digest from the sorted id list', async () => {
		expect(await membershipDigestFromIds(['peer-B', 'peer-A'])).to.equal('UjoxCXLZkeVCub8QNaxIUOKYgsasbCoZAplQabn_pzo')
	})

	it('hashes a v1 (unbound) record exactly as before', async () => {
		const m = message()
		const messageHash = await computeClusterMessageHash(m)
		expect(messageHash, 'messageHash').to.equal('z82mtgdVATHJ18SXKWJVkagEpuwyQGB8fvcbjUieJv1rh')
		expect(await computeClusterPromiseHash(messageHash, m), 'promiseHash').to.equal('azADjT30NLVD9HW0UrdV-37LGGLd66yCpoH076CsFww')
		expect(await computeClusterCommitHash(messageHash, m, promises), 'commitHash').to.equal('Z2TOFVBadJdRkpZSe29c_IOSn9HSGGmAz19DXSmJsgA')
	})

	it('hashes a v2 (membership-bound) record exactly as before', async () => {
		const digest = await membershipDigestFromIds(['peer-B', 'peer-A'])
		const m = message()
		const messageHash = await computeClusterMessageHash(m, digest)
		expect(messageHash, 'messageHash').to.equal('zDQ3qTb5NbQhKJ4ACGRWgNK4PuR7fGxZYpjHMG8AtKrGk')
		expect(await computeClusterPromiseHash(messageHash, m, digest), 'promiseHash').to.equal('e0K4fC-mZQTUQmX7rLWaa-DemN-xOGtPWOp1BaPwOC8')
		expect(await computeClusterCommitHash(messageHash, m, promises, digest), 'commitHash').to.equal('5gEnKyWS6XXTHkYnlmA5R-vXlEFKwZpcJZWva__eQ-k')
	})
})
