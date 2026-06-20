import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type { BlockStore, IBlock, BlockOperation, BlockId } from '@optimystic/db-core';
import { Log, applyOperation } from '@optimystic/db-core';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import {
	buildDisputeResolutionProof,
	verifyInvalidationCertificate,
	computeRevertedBlock,
	applyInvalidation,
	DEFERRED_DELETE_RESTORE,
} from '../src/dispute/invalidation.js';
import type { ArbitrationVote, DisputeResolution } from '../src/dispute/types.js';

// ─── Crypto helpers ───

type Arb = { peerId: PeerId; privateKey: PrivateKey };

async function makeArb(): Promise<Arb> {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
}

async function makeVote(arb: Arb, disputeId: string, vote: ArbitrationVote['vote'], computedHash: string): Promise<ArbitrationVote> {
	const payload = new TextEncoder().encode(`${disputeId}:${vote}:${computedHash}`);
	const sig = await arb.privateKey.sign(payload);
	return {
		disputeId,
		arbitratorPeerId: arb.peerId.toString(),
		vote,
		evidence: { computedHash, engineId: 'engine', schemaHash: 'schema', blockStateHashes: {} },
		signature: uint8ArrayToString(sig, 'base64url'),
	};
}

function makeResolution(disputeId: string, outcome: DisputeResolution['outcome'], votes: ArbitrationVote[]): DisputeResolution {
	return { disputeId, outcome, votes, affectedPeers: [], timestamp: 1 };
}

// ─── In-memory log store (Chain BlockStore for the collection Log) ───

class MemLogStore implements BlockStore<IBlock> {
	private blocks = new Map<string, IBlock>();
	private nextId = 1;
	createBlockHeader(type: string, newId?: string) { return { id: newId ?? `log-${this.nextId++}`, type, collectionId: 'log' }; }
	insert(block: IBlock): void { this.blocks.set(block.header.id, structuredClone(block)); }
	async tryGet(id: string): Promise<IBlock | undefined> { return structuredClone(this.blocks.get(id)); }
	update(id: string, op: BlockOperation): void { const b = this.blocks.get(id); if (!b) throw new Error(`Block ${id} not found`); applyOperation(b, op); }
	delete(id: string): void { this.blocks.delete(id); }
	generateId(): string { return `log-${this.nextId++}`; }
}

// ─── Block content helpers ───

type ValueBlock = IBlock & { value: string };

function valueBlock(id: BlockId, value: string): ValueBlock {
	return { header: { id, type: 'TST', collectionId: 'C' }, value };
}

/**
 * Seeds a block through the real StorageRepo commit path: rev 1 inserts `original`, rev 2 (T_inv)
 * updates the value, then optional later revisions. Returns the wired repo + storage factory.
 */
async function seedBlock(raw: MemoryRawStorage, blockId: BlockId, revisions: { actionId: string; value: string; rev: number }[]) {
	const createBlockStorage = (id: BlockId) => new BlockStorage(id, raw);
	const repo = new StorageRepo(createBlockStorage);
	let first = true;
	for (const { actionId, value, rev } of revisions) {
		const transforms = first
			? { inserts: { [blockId]: valueBlock(blockId, value) } }
			: { updates: { [blockId]: [['value', 0, 0, value] as BlockOperation] } };
		await repo.pend({ actionId, transforms, rev } as Parameters<StorageRepo['pend']>[0]);
		await repo.commit({ actionId, rev, blockIds: [blockId], tailId: 'log' });
		first = false;
	}
	return { repo, createBlockStorage };
}

describe('Invalidation certificate verification', () => {
	it('accepts a challenger-wins resolution with a 2/3 super-majority of signed votes', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await Promise.all(arbs.map(a => makeVote(a, 'd1', 'agree-with-challenger', 'h')));
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', votes), 'msg-1');
		expect(await verifyInvalidationCertificate(proof)).to.equal(true);
	});

	it('rejects a majority-wins resolution', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await Promise.all(arbs.map(a => makeVote(a, 'd1', 'agree-with-majority', 'h')));
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'majority-wins', votes), 'msg-1');
		expect(await verifyInvalidationCertificate(proof)).to.equal(false);
	});

	it('rejects an inconclusive resolution', async () => {
		const arbs = await Promise.all([makeArb(), makeArb()]);
		const votes = await Promise.all(arbs.map(a => makeVote(a, 'd1', 'inconclusive', 'h')));
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'inconclusive', votes), 'msg-1');
		expect(await verifyInvalidationCertificate(proof)).to.equal(false);
	});

	it('rejects a challenger-wins claim that does not actually meet the 2/3 threshold', async () => {
		// 1 challenger + 2 majority → challenger 1/3 < ceil(3*2/3)=2 ⇒ forged outcome must be rejected.
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = [
			await makeVote(a1!, 'd1', 'agree-with-challenger', 'h'),
			await makeVote(a2!, 'd1', 'agree-with-majority', 'h'),
			await makeVote(a3!, 'd1', 'agree-with-majority', 'h'),
		];
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', votes), 'msg-1');
		expect(await verifyInvalidationCertificate(proof)).to.equal(false);
	});

	it('drops votes with forged/invalid signatures before counting', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await Promise.all(arbs.map(a => makeVote(a, 'd1', 'agree-with-challenger', 'h')));
		// Corrupt every signature → all dropped → 0 decisive votes → reject.
		const forged = votes.map(v => ({ ...v, signature: uint8ArrayToString(new Uint8Array(64), 'base64url') }));
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', forged), 'msg-1');
		expect(await verifyInvalidationCertificate(proof)).to.equal(false);
	});

	it('rejects when the signed vote payload is tampered (computedHash mismatch)', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await Promise.all(arbs.map(a => makeVote(a, 'd1', 'agree-with-challenger', 'h')));
		// Signature was over computedHash 'h'; claim a different hash → verification fails.
		const tampered = votes.map(v => ({ ...v, evidence: { ...v.evidence, computedHash: 'tampered' } }));
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', tampered), 'msg-1');
		expect(await verifyInvalidationCertificate(proof)).to.equal(false);
	});
});

describe('Compensating-state computation', () => {
	it('restores the pre-T_inv content for a single-block T_inv', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const result = await computeRevertedBlock(createBlockStorage('B'), 2);
		expect(result.kind).to.equal('restore');
		if (result.kind === 'restore') {
			expect((result.block as ValueBlock).value).to.equal('original');
			expect(result.fromRev).to.equal(2);
			expect(result.laterActions).to.equal(0);
		}
	});

	it('replays surviving later actions on the rolled-back base (T_inv superseded)', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
			{ actionId: 'a3', value: 'later', rev: 3 },
		]);
		const result = await computeRevertedBlock(createBlockStorage('B'), 2);
		expect(result.kind).to.equal('restore');
		if (result.kind === 'restore') {
			// a3 overwrote the block after T_inv, so the as-if-absent content is a3's content.
			expect((result.block as ValueBlock).value).to.equal('later');
			expect(result.laterActions).to.equal(1);
		}
	});

	it('reports a deletion when T_inv created the block (no prior revision)', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'created-by-tinv', rev: 1 },
		]);
		const result = await computeRevertedBlock(createBlockStorage('B'), 1);
		expect(result.kind).to.equal('delete');
	});
});

describe('applyInvalidation', () => {
	async function challengerWinsProof(disputeId: string, messageHash: string) {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await Promise.all(arbs.map(a => makeVote(a, disputeId, 'agree-with-challenger', 'h')));
		return buildDisputeResolutionProof(makeResolution(disputeId, 'challenger-wins', votes), messageHash);
	}

	it('writes a new revision restoring pre-T_inv content and appends a durable invalidation entry', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1');

		const result = await applyInvalidation({ log, createBlockStorage }, {
			invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['B'], proof,
		});

		expect(result.applied).to.equal(true);
		expect(result.rev).to.equal(3);
		// The block's current content is restored to the pre-T_inv value.
		const current = await createBlockStorage('B').getBlock();
		expect((current!.block as ValueBlock).value).to.equal('original');
		expect(current!.actionRev.rev).to.equal(3);
		// Durable committed-invalidated status, discoverable from the log.
		const inv = await log.findInvalidation('a2');
		expect(inv?.resolution.disputeId).to.equal('d1');
		expect(inv?.reverted[0]?.blockId).to.equal('B');
	});

	it('is idempotent: re-applying the same resolution yields one entry and one revision', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1');
		const ctx = { log, createBlockStorage };
		const params = { invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['B'], proof } as const;

		const first = await applyInvalidation(ctx, params);
		const second = await applyInvalidation(ctx, params);

		expect(first.applied).to.equal(true);
		expect(second.applied).to.equal(false);
		expect(second.reason).to.equal('already-applied');

		// Exactly one invalidation entry in the log.
		let invCount = 0;
		for await (const entry of log.select()) {
			if (entry.invalidation) invCount++;
		}
		expect(invCount).to.equal(1);
		// Block still at the single compensating revision (no second revision written).
		expect((await createBlockStorage('B').getLatest())!.rev).to.equal(3);
	});

	it('rejects an invalid certificate and appends nothing', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		// majority-wins is not a valid invalidation certificate.
		const arbs = await Promise.all([makeArb(), makeArb()]);
		const votes = await Promise.all(arbs.map(a => makeVote(a, 'd1', 'agree-with-majority', 'h')));
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'majority-wins', votes), 'msg-1');

		const result = await applyInvalidation({ log, createBlockStorage }, {
			invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['B'], proof,
		});

		expect(result.applied).to.equal(false);
		expect(result.reason).to.equal('invalid-certificate');
		expect(await log.findInvalidation('a2')).to.be.undefined;
		// Block content untouched (still T_inv's value).
		expect(((await createBlockStorage('B').getBlock())!.block as ValueBlock).value).to.equal('tinv');
	});

	it('records a deferred sentinel when T_inv created the block (delete-restore)', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'created-by-tinv', rev: 1 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1');

		const result = await applyInvalidation({ log, createBlockStorage }, {
			invalidatedActionId: 'a1', invalidatedRev: 1, blockIds: ['B'], proof,
		});

		expect(result.applied).to.equal(true);
		expect(result.reverted[0]?.restoredContentHash).to.equal(DEFERRED_DELETE_RESTORE);
	});

	it('converges: independent members compute the same restored hash and revision', async () => {
		// Two independent storages/logs, seeded identically, apply the same proof.
		const proof = await challengerWinsProof('d1', 'msg-1');
		const seedRevs = [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		];

		async function applyOnMember() {
			const raw = new MemoryRawStorage();
			const { createBlockStorage } = await seedBlock(raw, 'B', seedRevs);
			const log = await Log.create<unknown>(new MemLogStore());
			return applyInvalidation({ log, createBlockStorage }, {
				invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['B'], proof,
			});
		}

		const [m1, m2] = await Promise.all([applyOnMember(), applyOnMember()]);
		expect(m1.rev).to.equal(m2.rev);
		expect(m1.reverted[0]?.restoredContentHash).to.equal(m2.reverted[0]?.restoredContentHash);
		expect(m1.reverted[0]?.restoredContentHash).to.be.a('string').and.not.equal(DEFERRED_DELETE_RESTORE);
	});
});
