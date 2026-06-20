import { expect } from 'chai'
import { Log } from '../src/log/index.js'
import type { LogBlock, DisputeResolutionProof, RevertedBlock } from '../src/log/index.js'
import { TestLogStore } from './test-log-store.js'
import { generateNumericActionId } from './generate-numeric-action-id.js'

function makeProof(disputeId: string, messageHash: string): DisputeResolutionProof {
	// A structurally-complete v3 proof (these tests exercise log persistence, not crypto verification —
	// signatures are placeholders).
	return {
		disputeId,
		messageHash,
		outcome: 'challenger-wins',
		challengerPeerId: 'challenger-1',
		arbitratorSet: ['arb-1', 'arb-2'],
		arbitratorSetSignature: 'set-sig',
		votes: [
			{ version: 'v3', arbitratorPeerId: 'arb-1', vote: 'agree-with-challenger', computedHash: 'h', signature: 'sig-1' },
			{ version: 'v3', arbitratorPeerId: 'arb-2', vote: 'agree-with-challenger', computedHash: 'h', signature: 'sig-2' },
		],
	}
}

describe('Log invalidation entries', () => {
	let store: TestLogStore

	beforeEach(() => {
		store = new TestLogStore()
	})

	it('appends an invalidation entry that round-trips through the chain', async () => {
		const log = await Log.create<string>(store)
		const invId = generateNumericActionId(1)

		// Commit the action that will later be invalidated.
		await log.addActions(['create'], invId, 1, () => [])

		const reverted: RevertedBlock[] = [{ blockId: 'block-A', fromRev: 1, restoredContentHash: 'hash-pre-Tinv' }]
		const proof = makeProof('dispute-1', 'msg-hash-1')

		const { entry } = await log.addInvalidation(invId, 1, proof, reverted, 2)

		expect(entry.rev).to.equal(2)
		expect(entry.invalidation?.invalidatedActionId).to.equal(invId)
		expect(entry.invalidation?.invalidatedRev).to.equal(1)
		expect(entry.invalidation?.resolution.outcome).to.equal('challenger-wins')
		expect(entry.invalidation?.reverted).to.deep.equal(reverted)
		// No accidental action/checkpoint arm.
		expect(entry.action).to.be.undefined
		expect(entry.checkpoint).to.be.undefined

		// Reverse iteration sees the invalidation entry as the tip.
		const iterated: typeof entry[] = []
		for await (const e of log.select(undefined, false)) {
			iterated.push(e)
		}
		expect(iterated[0]?.invalidation?.invalidatedActionId).to.equal(invId)
		expect(iterated[1]?.action?.actionId).to.equal(invId)
	})

	it('keeps the priorHash chain intact across an invalidation entry', async () => {
		const log = await Log.create<string>(store)

		// Fill the first block (32 entries) so the invalidation lands as the head of block two,
		// where priorHash linkage is observable.
		const results = []
		for (let i = 0; i < 32; i++) {
			results.push(await log.addActions([`a${i}`], generateNumericActionId(i + 1), i + 1, () => []))
		}
		const invResult = await log.addInvalidation(
			generateNumericActionId(1), 1, makeProof('d', 'm'),
			[{ blockId: 'b', fromRev: 32, restoredContentHash: 'h' }], 33
		)

		const firstBlock = (await store.tryGet(results[0]!.tailPath.block.header.id))! as LogBlock<string>
		const secondBlock = (await store.tryGet(invResult.tailPath.block.header.id))! as LogBlock<string>

		expect(firstBlock.priorHash).to.be.undefined
		expect(secondBlock.priorHash).to.be.a('string')
	})

	it('findInvalidation discovers the durable committed-invalidated status', async () => {
		const log = await Log.create<string>(store)
		const invalidatedId = generateNumericActionId(1)
		const survivingId = generateNumericActionId(2)

		await log.addActions(['a1'], invalidatedId, 1, () => [])
		await log.addActions(['a2'], survivingId, 2, () => [])

		// Before the invalidation lands, nothing is reported invalid.
		expect(await log.findInvalidation(invalidatedId)).to.be.undefined

		const proof = makeProof('dispute-7', 'msg-7')
		await log.addInvalidation(invalidatedId, 1, proof, [{ blockId: 'b', fromRev: 2, restoredContentHash: 'h' }], 3)

		const found = await log.findInvalidation(invalidatedId)
		expect(found?.invalidatedActionId).to.equal(invalidatedId)
		expect(found?.resolution.disputeId).to.equal('dispute-7')
		// A non-invalidated action is still reported clean.
		expect(await log.findInvalidation(survivingId)).to.be.undefined
	})

	it('does not disturb action context / getFrom when interleaved with actions', async () => {
		const log = await Log.create<string>(store)
		const id1 = generateNumericActionId(1)
		const id2 = generateNumericActionId(2)
		const id3 = generateNumericActionId(3)

		await log.addActions(['a1'], id1, 1, () => [])
		await log.addActions(['a2'], id2, 2, () => [])
		// Invalidate a1 — takes rev slot 3.
		await log.addInvalidation(id1, 1, makeProof('d', 'm'), [{ blockId: 'b', fromRev: 2, restoredContentHash: 'h' }], 3)
		await log.addActions(['a3'], id3, 4, () => [])

		// getFrom should return only the three *action* entries, skipping the invalidation.
		const fromStart = await log.getFrom(0)
		expect(fromStart.entries.map(e => e.actionId)).to.deep.equal([id1, id2, id3])
		// Latest rev tracks the most recent entry (the action at rev 4).
		expect(fromStart.context?.rev).to.equal(4)

		// getActionContext stays consistent and does not throw on the invalidation entry.
		const context = await log.getActionContext()
		expect(context?.rev).to.equal(4)
		expect(context?.committed.map(c => c.actionId)).to.include(id1)
		expect(context?.committed.map(c => c.actionId)).to.include(id3)
	})

	it('getInvalidationsFrom surfaces only invalidations after the given rev (newest-first)', async () => {
		const log = await Log.create<string>(store)
		const id1 = generateNumericActionId(1)
		const id2 = generateNumericActionId(2)

		await log.addActions(['a1'], id1, 1, () => [])
		await log.addActions(['a2'], id2, 2, () => [])
		// Two invalidations at rev 3 and 4.
		await log.addInvalidation(id1, 1, makeProof('d1', 'm'), [{ blockId: 'block-A', fromRev: 2, restoredContentHash: 'h1' }], 3)
		await log.addInvalidation(id2, 2, makeProof('d2', 'm'), [{ blockId: 'block-B', fromRev: 2, restoredContentHash: 'h2' }], 4)

		// A client synced through rev 2 sees both reversals; getFrom (actions only) sees none of them.
		const sinceRev2 = await log.getInvalidationsFrom(2)
		expect(sinceRev2.map(i => i.invalidatedActionId)).to.deep.equal([id2, id1])

		// A client already synced through rev 3 sees only the later reversal.
		const sinceRev3 = await log.getInvalidationsFrom(3)
		expect(sinceRev3.map(i => i.invalidatedActionId)).to.deep.equal([id2])

		// Up to date — nothing to react to.
		expect(await log.getInvalidationsFrom(4)).to.deep.equal([])

		// undefined start ⇒ all invalidations in the log.
		expect((await log.getInvalidationsFrom(undefined)).map(i => i.invalidatedActionId)).to.deep.equal([id2, id1])
	})

	it('returns the most recent invalidation when an action is invalidated more than once', async () => {
		// Defensive: cascade re-invalidation could append a second entry for the same action.
		const log = await Log.create<string>(store)
		const invalidatedId = generateNumericActionId(1)

		await log.addActions(['a1'], invalidatedId, 1, () => [])
		await log.addInvalidation(invalidatedId, 1, makeProof('dispute-A', 'm'), [{ blockId: 'b', fromRev: 1, restoredContentHash: 'h1' }], 2)
		await log.addInvalidation(invalidatedId, 1, makeProof('dispute-B', 'm'), [{ blockId: 'b', fromRev: 1, restoredContentHash: 'h2' }], 3)

		const found = await log.findInvalidation(invalidatedId)
		expect(found?.resolution.disputeId).to.equal('dispute-B')
	})
})
