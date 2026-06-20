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
	computeTargetHash,
	applyInvalidation,
	DEFERRED_DELETE_RESTORE,
	type CertificateTarget,
} from '../src/dispute/invalidation.js';
import type { ArbitrationVote, DisputeResolution } from '../src/dispute/types.js';

// ─── Crypto helpers ───

type Arb = { peerId: PeerId; privateKey: PrivateKey };

async function makeArb(): Promise<Arb> {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
}

// A target-bound (v2) vote: the signature commits to `targetHash`, so it only verifies when the
// verifier recomputes the same target.
async function makeVote(arb: Arb, disputeId: string, vote: ArbitrationVote['vote'], computedHash: string, targetHash: string): Promise<ArbitrationVote> {
	const payload = new TextEncoder().encode(`v2:${disputeId}:${vote}:${computedHash}:${targetHash}`);
	const sig = await arb.privateKey.sign(payload);
	return {
		version: 'v2',
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
	// The transaction the votes are bound to. The verifier recomputes targetHash from (messageHash, target).
	const MSG = 'msg-1';
	const TARGET: CertificateTarget = { invalidatedActionId: 'a2', blockIds: ['B'] };

	// Build N target-bound votes of one verdict, plus the matching proof, for the default (MSG, TARGET).
	async function boundVotes(arbs: Arb[], disputeId: string, vote: ArbitrationVote['vote'], target: CertificateTarget = TARGET, messageHash = MSG): Promise<ArbitrationVote[]> {
		const targetHash = await computeTargetHash(messageHash, target);
		return Promise.all(arbs.map(a => makeVote(a, disputeId, vote, 'h', targetHash)));
	}

	it('accepts a challenger-wins resolution with a 2/3 super-majority of signed votes (bound to the matching target)', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await boundVotes(arbs, 'd1', 'agree-with-challenger');
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', votes), MSG);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true);
	});

	it('rejects a genuine proof replayed against a different target (#2 target binding)', async () => {
		// A real challenger-wins proof bound to TARGET (action a2, block B)…
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await boundVotes(arbs, 'd1', 'agree-with-challenger');
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', votes), MSG);
		// …verifies against its own target, but NOT against an unrelated (innocent) transaction Y.
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true);
		expect(await verifyInvalidationCertificate(proof, { invalidatedActionId: 'innocent', blockIds: ['Y'] })).to.equal(false);
		// Same action id, different blocks → still bound, still rejected.
		expect(await verifyInvalidationCertificate(proof, { invalidatedActionId: 'a2', blockIds: ['B', 'C'] })).to.equal(false);
	});

	it('binding is block-order independent (blockIds sorted)', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await boundVotes(arbs, 'd1', 'agree-with-challenger', { invalidatedActionId: 'a2', blockIds: ['B', 'A'] });
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', votes), MSG);
		// Verifier given the same blocks in a different order still recomputes the same targetHash.
		expect(await verifyInvalidationCertificate(proof, { invalidatedActionId: 'a2', blockIds: ['A', 'B'] })).to.equal(true);
	});

	it('counts a duplicated arbitrator vote only once (#3 dedup)', async () => {
		// One genuine agree-with-challenger vote replicated 3× must NOT reach the super-majority: it is a
		// single arbitrator. Add two genuine majority votes → 1 challenger vs 2 majority ⇒ reject.
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const targetHash = await computeTargetHash(MSG, TARGET);
		const dup = await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash);
		const votes = [
			dup, { ...dup }, { ...dup }, // same arbitrator, replicated → counts once
			await makeVote(a2!, 'd1', 'agree-with-majority', 'h', targetHash),
			await makeVote(a3!, 'd1', 'agree-with-majority', 'h', targetHash),
		];
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', votes), MSG);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);

		// Sanity: three DISTINCT arbitrators agreeing with the challenger still pass.
		const distinct = await boundVotes([a1!, a2!, a3!], 'd1', 'agree-with-challenger');
		const okProof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', distinct), MSG);
		expect(await verifyInvalidationCertificate(okProof, TARGET)).to.equal(true);
	});

	it('drops an equivocating arbitrator from both sides', async () => {
		// a1 equivocates (challenger AND majority) → dropped entirely; a2,a3 are genuine challenger votes.
		// Counted decisive set = {a2, a3} → 2 challenger / 0 majority ⇒ pass. The equivocation cannot be
		// used to inflate either tally.
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const targetHash = await computeTargetHash(MSG, TARGET);
		const votes = [
			await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash),
			await makeVote(a1!, 'd1', 'agree-with-majority', 'h', targetHash),
			await makeVote(a2!, 'd1', 'agree-with-challenger', 'h', targetHash),
			await makeVote(a3!, 'd1', 'agree-with-challenger', 'h', targetHash),
		];
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', votes), MSG);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true);
	});

	it('rejects an unversioned / v1 vote before counting', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await boundVotes(arbs, 'd1', 'agree-with-challenger');
		// Strip the version marker (simulate a legacy/v1 vote) → all dropped → 0 decisive → reject.
		const unversioned = votes.map(v => { const { version, ...rest } = v; return rest as ArbitrationVote; });
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', unversioned), MSG);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects a majority-wins resolution', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await boundVotes(arbs, 'd1', 'agree-with-majority');
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'majority-wins', votes), MSG);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects an inconclusive resolution', async () => {
		const arbs = await Promise.all([makeArb(), makeArb()]);
		const votes = await boundVotes(arbs, 'd1', 'inconclusive');
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'inconclusive', votes), MSG);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects a challenger-wins claim that does not actually meet the 2/3 threshold', async () => {
		// 1 challenger + 2 majority → challenger 1/3 < ceil(3*2/3)=2 ⇒ forged outcome must be rejected.
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const targetHash = await computeTargetHash(MSG, TARGET);
		const votes = [
			await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash),
			await makeVote(a2!, 'd1', 'agree-with-majority', 'h', targetHash),
			await makeVote(a3!, 'd1', 'agree-with-majority', 'h', targetHash),
		];
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', votes), MSG);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('drops votes with forged/invalid signatures before counting', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await boundVotes(arbs, 'd1', 'agree-with-challenger');
		// Corrupt every signature → all dropped → 0 decisive votes → reject.
		const forged = votes.map(v => ({ ...v, signature: uint8ArrayToString(new Uint8Array(64), 'base64url') }));
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', forged), MSG);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects when the signed vote payload is tampered (computedHash mismatch)', async () => {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = await boundVotes(arbs, 'd1', 'agree-with-challenger');
		// Signature was over computedHash 'h'; claim a different hash → verification fails.
		const tampered = votes.map(v => ({ ...v, evidence: { ...v.evidence, computedHash: 'tampered' } }));
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'challenger-wins', tampered), MSG);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
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
	// Build a challenger-wins proof whose votes are bound to `target` (defaults to the a2/B target the
	// apply tests revert), so the certificate verifies against the matching apply target.
	async function challengerWinsProof(disputeId: string, messageHash: string, target: CertificateTarget = { invalidatedActionId: 'a2', blockIds: ['B'] }) {
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const targetHash = await computeTargetHash(messageHash, target);
		const votes = await Promise.all(arbs.map(a => makeVote(a, disputeId, 'agree-with-challenger', 'h', targetHash)));
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
		const targetHash = await computeTargetHash('msg-1', { invalidatedActionId: 'a2', blockIds: ['B'] });
		const votes = await Promise.all(arbs.map(a => makeVote(a, 'd1', 'agree-with-majority', 'h', targetHash)));
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

	it('rejects a genuine proof replayed against a different action/blocks and writes nothing (#2 apply-path replay)', async () => {
		// A genuine challenger-wins proof bound to the REAL target (a2 / block B)…
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'original', rev: 1 },
			{ actionId: 'a2', value: 'tinv', rev: 2 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a2', blockIds: ['B'] });

		// …carried in an apply against an UNRELATED innocent action 'innocent'/block 'B' → rejected,
		// no revision and no log entry written.
		const result = await applyInvalidation({ log, createBlockStorage }, {
			invalidatedActionId: 'innocent', invalidatedRev: 2, blockIds: ['B'], proof,
		});

		expect(result.applied).to.equal(false);
		expect(result.reason).to.equal('invalid-certificate');
		expect(await log.findInvalidation('innocent')).to.be.undefined;
		// Block content untouched (still T_inv's value) — nothing was reverted.
		expect(((await createBlockStorage('B').getBlock())!.block as ValueBlock).value).to.equal('tinv');
	});

	it('records a deferred sentinel when T_inv created the block (delete-restore)', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'created-by-tinv', rev: 1 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a1', blockIds: ['B'] });

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
