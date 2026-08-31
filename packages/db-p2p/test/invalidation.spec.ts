import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId, PrivateKey } from '@libp2p/interface';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type { BlockStore, IBlock, BlockOperation, BlockId } from '@optimystic/db-core';
import { Log, applyOperation, Latches } from '@optimystic/db-core';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { withBlockWriteLatch, blockWriteLatchKey } from '../src/storage/block-latch.js';
import { delay } from '@optimystic/db-core/test';
import {
	buildDisputeResolutionProof,
	verifyInvalidationCertificate,
	computeRevertedBlock,
	hashBlockContent,
	computeTargetHash,
	computeArbitratorSetHash,
	voteSigningPayload,
	arbitratorSetSigningPayload,
	applyInvalidation,
	DELETED_BLOCK_RESTORE,
	type CertificateTarget,
	type ArbitratorSetRecompute,
	type UnanchoredAcceptanceInfo,
} from '../src/dispute/invalidation.js';
import type { ArbitrationVote, DisputeResolution } from '../src/dispute/types.js';

// ─── Crypto helpers ───

type Arb = { peerId: PeerId; privateKey: PrivateKey };

async function makeArb(): Promise<Arb> {
	const privateKey = await generateKeyPair('Ed25519');
	return { peerId: peerIdFromPrivateKey(privateKey), privateKey };
}

// A target- and set-bound (v3) vote: the signature commits to BOTH `targetHash` (the reversed
// transaction, #2) and `setHash` (the legitimately-selected arbitrator set, #1).
async function makeVote(arb: Arb, disputeId: string, vote: ArbitrationVote['vote'], computedHash: string, targetHash: string, setHash: string): Promise<ArbitrationVote> {
	const sig = await arb.privateKey.sign(voteSigningPayload(disputeId, vote, computedHash, targetHash, setHash));
	return {
		version: 'v3',
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

function setEquals(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	const A = new Set(a);
	return a.length === b.length && b.every(x => A.has(x));
}

/** Layer-2 recompute that says the genuine set is legitimate and anything else is not. */
function recomputeMatching(genuineSet: ReadonlyArray<string>): ArbitratorSetRecompute {
	return async (ctx) => ({ feasible: true, legitimate: setEquals(ctx.arbitratorSet, genuineSet) });
}

/** Layer-2 recompute that cannot reconstruct the historical topology (late-joiner / churn). */
const recomputeInfeasible: ArbitratorSetRecompute = async () => ({ feasible: false });

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

/**
 * Seeds arbitrary per-revision writes across possibly-different blocks through the real StorageRepo
 * commit path: each step inserts a block the first time its id is written and updates it thereafter.
 * Lets a test create one block at rev 1 and a DIFFERENT block fresh at rev 2 (the case-2 repro).
 */
async function seedWrites(raw: MemoryRawStorage, steps: { actionId: string; rev: number; blockId: BlockId; value: string }[]) {
	const createBlockStorage = (id: BlockId) => new BlockStorage(id, raw);
	const repo = new StorageRepo(createBlockStorage);
	const seen = new Set<BlockId>();
	for (const { actionId, rev, blockId, value } of steps) {
		const transforms = seen.has(blockId)
			? { updates: { [blockId]: [['value', 0, 0, value] as BlockOperation] } }
			: { inserts: { [blockId]: valueBlock(blockId, value) } };
		await repo.pend({ actionId, transforms, rev } as Parameters<StorageRepo['pend']>[0]);
		await repo.commit({ actionId, rev, blockIds: [blockId], tailId: 'log' });
		seen.add(blockId);
	}
	return { repo, createBlockStorage };
}

describe('Invalidation certificate verification', () => {
	// The transaction the votes are bound to. The verifier recomputes targetHash from (messageHash, target).
	const MSG = 'msg-1';
	const TARGET: CertificateTarget = { invalidatedActionId: 'a2', blockIds: ['B'] };

	// The challenger's base64url signature over `(disputeId, target, arbitratorSet)`.
	async function challengerSetSig(challenger: Arb, disputeId: string, arbitratorSet: ReadonlyArray<string>, target: CertificateTarget = TARGET, messageHash = MSG): Promise<string> {
		const targetHash = await computeTargetHash(messageHash, target);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		return uint8ArrayToString(await challenger.privateKey.sign(arbitratorSetSigningPayload(disputeId, targetHash, setHash)), 'base64url');
	}

	// Assemble a v3 proof from already-built votes + an explicit arbitrator set (allows the set to differ
	// from the voters, for the non-member / sybil cases).
	async function proofFrom(challenger: Arb, arbitratorSet: string[], disputeId: string, outcome: DisputeResolution['outcome'], votes: ArbitrationVote[], target: CertificateTarget = TARGET, messageHash = MSG) {
		const arbitratorSetSignature = await challengerSetSig(challenger, disputeId, arbitratorSet, target, messageHash);
		return buildDisputeResolutionProof(makeResolution(disputeId, outcome, votes), messageHash, {
			arbitratorSet,
			challengerPeerId: challenger.peerId.toString(),
			arbitratorSetSignature,
		});
	}

	// The common case: every arb casts the same verdict, the carried set IS the voters, the challenger
	// signs that set. A genuine, self-consistent v3 certificate.
	async function genuineProof(challenger: Arb, arbs: Arb[], disputeId: string, outcome: DisputeResolution['outcome'], verdict: ArbitrationVote['vote'], target: CertificateTarget = TARGET, messageHash = MSG) {
		const arbitratorSet = arbs.map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(messageHash, target);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = await Promise.all(arbs.map(a => makeVote(a, disputeId, verdict, 'h', targetHash, setHash)));
		return proofFrom(challenger, arbitratorSet, disputeId, outcome, votes, target, messageHash);
	}

	it('accepts a challenger-wins resolution with a 2/3 super-majority of signed votes (bound to the matching target + set)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true);
	});

	it('rejects a genuine proof replayed against a different target (#2 target binding)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// Verifies against its own target, but NOT against an unrelated (innocent) transaction Y.
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true);
		expect(await verifyInvalidationCertificate(proof, { invalidatedActionId: 'innocent', blockIds: ['Y'] })).to.equal(false);
		// Same action id, different blocks → still bound, still rejected.
		expect(await verifyInvalidationCertificate(proof, { invalidatedActionId: 'a2', blockIds: ['B', 'C'] })).to.equal(false);
	});

	it('binding is block-order independent (blockIds sorted)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger', { invalidatedActionId: 'a2', blockIds: ['B', 'A'] });
		// Verifier given the same blocks in a different order still recomputes the same targetHash.
		expect(await verifyInvalidationCertificate(proof, { invalidatedActionId: 'a2', blockIds: ['A', 'B'] })).to.equal(true);
	});

	it('counts a duplicated arbitrator vote only once (#3 dedup)', async () => {
		// One genuine agree-with-challenger vote replicated 3× must NOT reach the super-majority: it is a
		// single arbitrator. Add two genuine majority votes → 1 challenger vs 2 majority ⇒ reject.
		const challenger = await makeArb();
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = [a1!, a2!, a3!].map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(MSG, TARGET);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const dup = await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash);
		const votes = [
			dup, { ...dup }, { ...dup }, // same arbitrator, replicated → counts once
			await makeVote(a2!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			await makeVote(a3!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
		];
		const proof = await proofFrom(challenger, arbitratorSet, 'd1', 'challenger-wins', votes);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);

		// Sanity: three DISTINCT arbitrators agreeing with the challenger still pass.
		const okProof = await genuineProof(challenger, [a1!, a2!, a3!], 'd1', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(okProof, TARGET)).to.equal(true);
	});

	it('drops an equivocating arbitrator from both sides', async () => {
		// a1 equivocates (challenger AND majority) → dropped entirely; a2,a3 are genuine challenger votes.
		const challenger = await makeArb();
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = [a1!, a2!, a3!].map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(MSG, TARGET);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = [
			await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
			await makeVote(a1!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			await makeVote(a2!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
			await makeVote(a3!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
		];
		const proof = await proofFrom(challenger, arbitratorSet, 'd1', 'challenger-wins', votes);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true);
	});

	it('rejects an unversioned / v1 / v2 vote before counting', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// Strip the version marker (simulate a legacy vote) → all dropped → 0 decisive → reject.
		const unversioned = {
			...proof,
			votes: proof.votes.map(v => { const { version, ...rest } = v; return rest as typeof v; }),
		};
		expect(await verifyInvalidationCertificate(unversioned, TARGET)).to.equal(false);
	});

	it('rejects a majority-wins resolution', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'majority-wins', 'agree-with-majority');
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects an inconclusive resolution', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'inconclusive', 'inconclusive');
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects a challenger-wins claim that does not actually meet the 2/3 threshold', async () => {
		// 1 challenger + 2 majority → challenger 1/3 < ceil(3*2/3)=2 ⇒ forged outcome must be rejected.
		const challenger = await makeArb();
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = [a1!, a2!, a3!].map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(MSG, TARGET);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = [
			await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
			await makeVote(a2!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			await makeVote(a3!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
		];
		const proof = await proofFrom(challenger, arbitratorSet, 'd1', 'challenger-wins', votes);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('drops votes with forged/invalid signatures before counting', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// Corrupt every vote signature → all dropped → 0 decisive votes → reject.
		const forged = {
			...proof,
			votes: proof.votes.map(v => ({ ...v, signature: uint8ArrayToString(new Uint8Array(64), 'base64url') })),
		};
		expect(await verifyInvalidationCertificate(forged, TARGET)).to.equal(false);
	});

	it('rejects when the signed vote payload is tampered (computedHash mismatch)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// Signature was over computedHash 'h'; claim a different hash → verification fails.
		const tampered = {
			...proof,
			votes: proof.votes.map(v => ({ ...v, computedHash: 'tampered' })),
		};
		expect(await verifyInvalidationCertificate(tampered, TARGET)).to.equal(false);
	});

	// ─── #1 arbitrator-set binding ───

	it('rejects a proof missing the arbitrator-set binding', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		// A pre-set-binding (no arbitratorSet / challenger) proof is rejected, never accepted-by-default.
		expect(await verifyInvalidationCertificate({ ...proof, arbitratorSet: [] }, TARGET)).to.equal(false);
		expect(await verifyInvalidationCertificate({ ...proof, arbitratorSetSignature: '' }, TARGET)).to.equal(false);
		expect(await verifyInvalidationCertificate({ ...proof, challengerPeerId: '' }, TARGET)).to.equal(false);
	});

	it('does not count signature-valid votes from peers outside the arbitrator set (#1)', async () => {
		// The carried set is {a1,a2,a3}: a1 challenger, a2/a3 majority → 1 vs 2 ⇒ sub-threshold. Three sybils
		// also cast cryptographically-valid challenger votes over the SAME (targetHash,setHash) but are NOT
		// members → dropped. If they counted, challenger would be 4 vs 2 and pass; instead it stays 1 vs 2.
		const challenger = await makeArb();
		const [a1, a2, a3] = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = [a1!, a2!, a3!].map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(MSG, TARGET);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const sybils = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const votes = [
			await makeVote(a1!, 'd1', 'agree-with-challenger', 'h', targetHash, setHash),
			await makeVote(a2!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			await makeVote(a3!, 'd1', 'agree-with-majority', 'h', targetHash, setHash),
			...await Promise.all(sybils.map(s => makeVote(s, 'd1', 'agree-with-challenger', 'h', targetHash, setHash))),
		];
		const proof = await proofFrom(challenger, arbitratorSet, 'd1', 'challenger-wins', votes);
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(false);
	});

	it('rejects a proof whose arbitrator set was tampered after signing (#1)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(proof, TARGET)).to.equal(true); // baseline
		// Inject a sybil into the carried set → it no longer matches the challenger-signed digest → reject.
		const sybil = await makeArb();
		const tampered = { ...proof, arbitratorSet: [...proof.arbitratorSet, sybil.peerId.toString()] };
		expect(await verifyInvalidationCertificate(tampered, TARGET)).to.equal(false);
	});

	it('rejects sybil-key votes when recompute exposes a forged arbitrator set (#1 headline)', async () => {
		// The forgery part 1 left open: an attacker mints fresh keypairs, declares them the arbitrator set,
		// self-signs the set as "challenger", and signs a 2/3 super-majority. This is layer-1-consistent…
		const attacker = await makeArb();
		const sybils = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const forged = await genuineProof(attacker, sybils, 'd1', 'challenger-wins', 'agree-with-challenger');
		// …so on layer 1 ALONE (no recompute) it is accepted — the documented residual until a trust anchor.
		expect(await verifyInvalidationCertificate(forged, TARGET)).to.equal(true);
		// But a member that CAN reconstruct the genuine topology (some other selected set) rejects it.
		const genuineSet = (await Promise.all([makeArb(), makeArb(), makeArb()])).map(a => a.peerId.toString());
		expect(await verifyInvalidationCertificate(forged, TARGET, { recomputeArbitratorSet: recomputeMatching(genuineSet) })).to.equal(false);
	});

	it('recompute path: the genuine set verifies and a forged set fails (#1 layer 2)', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const genuineSet = arbs.map(a => a.peerId.toString());
		const recompute = recomputeMatching(genuineSet);

		const genuine = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(genuine, TARGET, { recomputeArbitratorSet: recompute })).to.equal(true);

		// A different (sybil) set fails the recompute match even though it is layer-1-consistent.
		const attacker = await makeArb();
		const sybils = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const forged = await genuineProof(attacker, sybils, 'd2', 'challenger-wins', 'agree-with-challenger');
		expect(await verifyInvalidationCertificate(forged, TARGET, { recomputeArbitratorSet: recompute })).to.equal(false);
	});

	it('degradation path: a layer-1-valid cert is accepted and reported as not-fully-anchored', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');

		// No recompute capability → accept on layer 1 + report reason 'no-recompute-capability'.
		const seen: UnanchoredAcceptanceInfo[] = [];
		expect(await verifyInvalidationCertificate(proof, TARGET, { onUnanchored: (i) => seen.push(i) })).to.equal(true);
		expect(seen).to.have.lengthOf(1);
		expect(seen[0]!.reason).to.equal('no-recompute-capability');
		expect(seen[0]!.disputeId).to.equal('d1');

		// Recompute present but infeasible (late-joiner / churn) → still accept, reason 'recompute-infeasible'.
		const seen2: UnanchoredAcceptanceInfo[] = [];
		expect(await verifyInvalidationCertificate(proof, TARGET, { recomputeArbitratorSet: recomputeInfeasible, onUnanchored: (i) => seen2.push(i) })).to.equal(true);
		expect(seen2).to.have.lengthOf(1);
		expect(seen2[0]!.reason).to.equal('recompute-infeasible');
	});

	it('does not report unanchored when the recompute fully anchors the set', async () => {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const proof = await genuineProof(challenger, arbs, 'd1', 'challenger-wins', 'agree-with-challenger');
		const genuineSet = arbs.map(a => a.peerId.toString());
		const seen: UnanchoredAcceptanceInfo[] = [];
		expect(await verifyInvalidationCertificate(proof, TARGET, { recomputeArbitratorSet: recomputeMatching(genuineSet), onUnanchored: (i) => seen.push(i) })).to.equal(true);
		expect(seen).to.have.lengthOf(0);
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

	it('reports a deletion (no throw) when T_inv created the block at rev > 1', async () => {
		// The case-2 repro: A created at rev 1, then B created FRESH at rev 2 (B has no rev-1 content).
		// Previously this threw `Failed to find materialized block B for revision 1`.
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedWrites(raw, [
			{ actionId: 'a1', rev: 1, blockId: 'A', value: 'a' },
			{ actionId: 'a2', rev: 2, blockId: 'B', value: 'b-created' },
		]);
		const result = await computeRevertedBlock(createBlockStorage('B'), 2);
		expect(result.kind).to.equal('delete');
	});

	it('handles sparse revisions: restore to the highest prior rev, or delete at the creation rev', async () => {
		const raw = new MemoryRawStorage();
		// B created at rev 2, updated at rev 5 (revs 1, 3, 4 are absent for B).
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a2', value: 'created', rev: 2 },
			{ actionId: 'a5', value: 'updated', rev: 5 },
		]);

		// Invalidate the update @5 → roll back to the created content at the highest prior rev (2).
		const restored = await computeRevertedBlock(createBlockStorage('B'), 5);
		expect(restored.kind).to.equal('restore');
		if (restored.kind === 'restore') {
			expect((restored.block as ValueBlock).value).to.equal('created');
		}

		// Invalidate the creation @2 → no prior revision → delete (later actions are NOT replayed).
		const deleted = await computeRevertedBlock(createBlockStorage('B'), 2);
		expect(deleted.kind).to.equal('delete');
	});
});

describe('applyInvalidation', () => {
	// Build a challenger-wins proof whose votes are bound to `target` (defaults to the a2/B target the
	// apply tests revert) AND to the legitimately-selected set; the certificate verifies against the
	// matching apply target on layer 1 (applyInvalidation runs no recompute).
	async function challengerWinsProof(disputeId: string, messageHash: string, target: CertificateTarget = { invalidatedActionId: 'a2', blockIds: ['B'] }) {
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb(), makeArb()]);
		const arbitratorSet = arbs.map(a => a.peerId.toString());
		const targetHash = await computeTargetHash(messageHash, target);
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = await Promise.all(arbs.map(a => makeVote(a, disputeId, 'agree-with-challenger', 'h', targetHash, setHash)));
		const arbitratorSetSignature = uint8ArrayToString(await challenger.privateKey.sign(arbitratorSetSigningPayload(disputeId, targetHash, setHash)), 'base64url');
		return buildDisputeResolutionProof(makeResolution(disputeId, 'challenger-wins', votes), messageHash, {
			arbitratorSet,
			challengerPeerId: challenger.peerId.toString(),
			arbitratorSetSignature,
		});
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
		const challenger = await makeArb();
		const arbs = await Promise.all([makeArb(), makeArb()]);
		const arbitratorSet = arbs.map(a => a.peerId.toString());
		const targetHash = await computeTargetHash('msg-1', { invalidatedActionId: 'a2', blockIds: ['B'] });
		const setHash = await computeArbitratorSetHash(arbitratorSet);
		const votes = await Promise.all(arbs.map(a => makeVote(a, 'd1', 'agree-with-majority', 'h', targetHash, setHash)));
		const arbitratorSetSignature = uint8ArrayToString(await challenger.privateKey.sign(arbitratorSetSigningPayload('d1', targetHash, setHash)), 'base64url');
		const proof = buildDisputeResolutionProof(makeResolution('d1', 'majority-wins', votes), 'msg-1', {
			arbitratorSet, challengerPeerId: challenger.peerId.toString(), arbitratorSetSignature,
		});

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

	it('physically removes the block when T_inv created it at rev <= 1 (delete-restore)', async () => {
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
		expect(result.reverted[0]?.restoredContentHash).to.equal(DELETED_BLOCK_RESTORE);
		// The created block is physically gone — getBlock() reads back as absent (not a placeholder).
		expect(await createBlockStorage('B').getBlock()).to.equal(undefined);
		// Durable invalidation entry recorded.
		expect((await log.findInvalidation('a1'))?.resolution.disputeId).to.equal('d1');
	});

	it('physically removes a block created at rev > 1 (delete-restore, no throw)', async () => {
		// The previously-throwing path: A created @1, B created FRESH @2; reverting B's creation deletes it.
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedWrites(raw, [
			{ actionId: 'a1', rev: 1, blockId: 'A', value: 'a' },
			{ actionId: 'a2', rev: 2, blockId: 'B', value: 'b-created' },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a2', blockIds: ['B'] });

		const result = await applyInvalidation({ log, createBlockStorage }, {
			invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['B'], proof,
		});

		expect(result.applied).to.equal(true);
		expect(result.reverted[0]?.restoredContentHash).to.equal(DELETED_BLOCK_RESTORE);
		expect(await createBlockStorage('B').getBlock()).to.equal(undefined);
		// Block A (created by an unrelated action) is untouched.
		expect(((await createBlockStorage('A').getBlock())!.block as ValueBlock).value).to.equal('a');
	});

	it('is idempotent for a creation reversal: one entry, one tombstone revision', async () => {
		const raw = new MemoryRawStorage();
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'created-by-tinv', rev: 1 },
		]);
		const log = await Log.create<unknown>(new MemLogStore());
		const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a1', blockIds: ['B'] });
		const ctx = { log, createBlockStorage };
		const params = { invalidatedActionId: 'a1', invalidatedRev: 1, blockIds: ['B'], proof } as const;

		const first = await applyInvalidation(ctx, params);
		const second = await applyInvalidation(ctx, params);

		expect(first.applied).to.equal(true);
		expect(second.applied).to.equal(false);
		expect(second.reason).to.equal('already-applied');

		let invCount = 0;
		for await (const entry of log.select()) {
			if (entry.invalidation) invCount++;
		}
		expect(invCount).to.equal(1);
		// Exactly one tombstone revision: latest does not advance on the re-apply, block stays absent.
		expect((await createBlockStorage('B').getLatest())!.rev).to.equal(2);
		expect(await createBlockStorage('B').getBlock()).to.equal(undefined);
	});

	it('converges: two members reverting the same creation write identical tombstones', async () => {
		const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a1', blockIds: ['B'] });

		async function applyOnMember() {
			const raw = new MemoryRawStorage();
			const { createBlockStorage } = await seedBlock(raw, 'B', [
				{ actionId: 'a1', value: 'created-by-tinv', rev: 1 },
			]);
			const log = await Log.create<unknown>(new MemLogStore());
			const result = await applyInvalidation({ log, createBlockStorage }, {
				invalidatedActionId: 'a1', invalidatedRev: 1, blockIds: ['B'], proof,
			});
			return { result, latest: await createBlockStorage('B').getLatest() };
		}

		const [m1, m2] = await Promise.all([applyOnMember(), applyOnMember()]);
		expect(m1.result.rev).to.equal(m2.result.rev);
		// Identical (rev, actionId) tombstone on both members (deterministic revertActionId).
		expect(m1.latest).to.deep.equal(m2.latest);
		expect(m1.result.reverted[0]?.restoredContentHash).to.equal(DELETED_BLOCK_RESTORE);
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
		expect(m1.reverted[0]?.restoredContentHash).to.be.a('string').and.not.equal(DELETED_BLOCK_RESTORE);
	});

	// ─── The ONE per-block write latch: the invalidation-apply RMW of meta.latest must serialize against commit ───
	describe('per-block write latch (lost-update guard)', () => {
		const updateOp = (blockId: BlockId, value: string) =>
			({ updates: { [blockId]: [['value', 0, 0, value] as BlockOperation] } });

		it('contends on the per-block write latch: the compensating write blocks until the latch is free', async () => {
			const raw = new MemoryRawStorage();
			const blockId = 'lat-contend';
			const { createBlockStorage } = await seedBlock(raw, blockId, [
				{ actionId: 'a1', value: 'original', rev: 1 },
				{ actionId: 'a2', value: 'tinv', rev: 2 },
			]);
			const log = await Log.create<unknown>(new MemLogStore());
			const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a2', blockIds: [blockId] });

			// Externally hold the block's ONE write latch — exactly the key a concurrent commit holds.
			// There is no runner to inject any more: `applyInvalidation` always takes this key itself, and
			// an unlatched compensating write cannot even be expressed (every write demands the token).
			const release = await Latches.acquire(blockWriteLatchKey(blockId));
			let released = false;
			const releaseOnce = () => { if (!released) { released = true; release(); } };

			try {
				let applied = false;
				const p = applyInvalidation(
					{ log, createBlockStorage },
					{ invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: [blockId], proof, rev: 3 }
				).then(r => { applied = true; return r; });

				// Apply runs its whole prefix (dedup → cert verify → compute) freely, then parks acquiring
				// the held latch. Proving it does NOT proceed is a negative assertion a condition poll cannot
				// express, so give that prefix real event-loop time and then assert nothing landed.
				await delay(0);
				await delay(25);
				expect(applied).to.equal(false);
				expect((await createBlockStorage(blockId).getLatest())!.rev).to.equal(2);

				releaseOnce(); // release the external latch → apply may now acquire it and write
				const result = await p;
				expect(applied).to.equal(true);
				expect(result.applied).to.equal(true);
				expect((await createBlockStorage(blockId).getLatest())!.rev).to.equal(3);
			} finally {
				releaseOnce();
			}
		});

		// The old "WITHOUT the latch, a concurrent commit clobbers the invalidation" repro is gone: every
		// compensating write now demands a BlockWriteLatch token, so the unlatched write that lost update
		// documented cannot be expressed.

		it('a commit queues behind the invalidation on the one write latch and latest stays monotonic', async () => {
			const raw = new MemoryRawStorage();
			const blockId = 'lat-fix';
			const { repo, createBlockStorage } = await seedBlock(raw, blockId, [
				{ actionId: 'a1', value: 'original', rev: 1 },
				{ actionId: 'a2', value: 'tinv', rev: 2 },
				{ actionId: 'a3', value: 'r3', rev: 3 },
				{ actionId: 'a4', value: 'r4', rev: 4 },
			]);
			const log = await Log.create<unknown>(new MemLogStore());
			const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a2', blockIds: [blockId] });

			// The invalidation writes rev 6 under the block write latch it takes itself.
			const invResult = await applyInvalidation({ log, createBlockStorage }, {
				invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: [blockId], proof, rev: 6,
			});
			expect(invResult.applied).to.equal(true);
			expect((await createBlockStorage(blockId).getLatest())!.rev).to.equal(6);

			// Pend BEFORE holding the key: pend writes the pending record under the same latch.
			await repo.pend({ actionId: 'c5', transforms: updateOp(blockId, 'c5'), rev: 5 } as Parameters<StorageRepo['pend']>[0]);

			// Hold the very key the invalidation just used. A commit of the older rev 5 must now queue
			// behind it — it cannot even run its staleness check, let alone write latest.
			const release = await Latches.acquire(blockWriteLatchKey(blockId));
			let released = false;
			const releaseOnce = () => { if (!released) { released = true; release(); } };

			try {
				let commitDone = false;
				const commitP = repo.commit({ actionId: 'c5', rev: 5, blockIds: [blockId], tailId: 'log' })
					.then(r => { commitDone = true; return r; });

				// Same negative assertion as above: give the commit real event-loop time, then prove it is
				// parked and that latest is untouched at the invalidation's 6.
				await delay(0);
				await delay(25);
				expect(commitDone).to.equal(false);
				expect((await createBlockStorage(blockId).getLatest())!.rev).to.equal(6);

				releaseOnce(); // the commit acquires the latch next
				const commitResult = await commitP;

				// Serialized after the invalidation, the commit sees latest=6 ≥ its rev 5 (different action)
				// → rejected as stale, never clobbers.
				expect(commitResult.success).to.equal(false);
				// latest stayed monotonic at 6 — the invalidation's advance survived.
				expect((await createBlockStorage(blockId).getLatest())!.rev).to.equal(6);
			} finally {
				releaseOnce();
			}
		});

		// ─── The entry may only describe writes that actually landed ───

		it('reads tips under the latch: a commit that lands first shifts the slot, and the entry describes the write that landed', async () => {
			const raw = new MemoryRawStorage();
			const blockId = 'inv-race';
			const { repo, createBlockStorage } = await seedBlock(raw, blockId, [
				{ actionId: 'a1', value: 'original', rev: 1 },
				{ actionId: 'a2', value: 'tinv', rev: 2 },
			]);
			const log = await Log.create<unknown>(new MemLogStore());
			const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a2', blockIds: [blockId] });

			// Pend the competing action BEFORE holding the key: pend takes the same latch.
			await repo.pend({ actionId: 'c3', transforms: updateOp(blockId, 'concurrent'), rev: 3 } as Parameters<StorageRepo['pend']>[0]);

			const release = await Latches.acquire(blockWriteLatchKey(blockId));
			let released = false;
			const releaseOnce = () => { if (!released) { released = true; release(); } };

			let commitP: ReturnType<StorageRepo['commit']>;
			let invP: ReturnType<typeof applyInvalidation>;
			try {
				// The commit queues on the held latch first; the invalidation (no explicit slot) runs its
				// read-only prefix — dedup, certificate verification — and queues behind it.
				commitP = repo.commit({ actionId: 'c3', rev: 3, blockIds: [blockId], tailId: 'log' });
				await delay(0);
				invP = applyInvalidation({ log, createBlockStorage }, {
					invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: [blockId], proof,
				});
				await delay(25);
			} finally {
				releaseOnce();
			}
			const commitResult = await commitP;
			const result = await invP;

			// The competing commit landed rev 3 and is untouched by the invalidation.
			expect(commitResult.success).to.equal(true);

			// Because the tip is read INSIDE the latch, the slot is one past what the commit actually
			// landed (4, not the stale 3 the pre-fix code computed from a tip read outside the latch).
			// The compensating write therefore lands rather than being refused by the monotonic guard.
			expect(result.applied).to.equal(true);
			expect(result.rev).to.equal(4);

			const latest = await createBlockStorage(blockId).getLatest();
			expect(latest!.rev).to.equal(4);
			// The revision in effect belongs to the invalidation, not to the competing commit.
			expect(latest!.actionId).to.not.equal('c3');

			// The recorded reversal describes the state that is actually in effect: the tip it rolled
			// forward from is the commit's rev 3, and the hash is the hash of the stored content.
			const entryBlock = result.reverted[0]!;
			expect(entryBlock.blockId).to.equal(blockId);
			expect(entryBlock.fromRev).to.equal(3);
			const current = await createBlockStorage(blockId).getBlock();
			expect(entryBlock.restoredContentHash).to.equal(await hashBlockContent(current!.block));

			// The durable entry carries the same landed reversal.
			const inv = await log.findInvalidation('a2');
			expect(inv?.reverted).to.deep.equal([...result.reverted]);
		});

		it('refuses wholesale when an explicit slot is at or below a tip: no write, no entry, no partial revert', async () => {
			const raw = new MemoryRawStorage();
			const { createBlockStorage } = await seedWrites(raw, [
				{ actionId: 'a1', rev: 1, blockId: 'X', value: 'x1' },
				{ actionId: 'a2', rev: 2, blockId: 'X', value: 'x2' },
				{ actionId: 'a2b', rev: 2, blockId: 'Y', value: 'y2' },
				{ actionId: 'a3', rev: 3, blockId: 'Y', value: 'y3' },
			]);
			const log = await Log.create<unknown>(new MemLogStore());
			const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a2', blockIds: ['X', 'Y'] });

			// Slot 3 is past X's tip (2) but NOT past Y's (3) — so a per-block loop would have written X
			// and had Y refused, leaving a log entry that claims both.
			const result = await applyInvalidation({ log, createBlockStorage }, {
				invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['X', 'Y'], proof, rev: 3,
			});

			expect(result.applied).to.equal(false);
			expect(result.reason).to.equal('stale-revision');
			expect(result.reverted).to.deep.equal([]);

			// Nothing written on EITHER block — including the one whose write would have succeeded.
			expect(await createBlockStorage('X').getLatest()).to.deep.equal({ rev: 2, actionId: 'a2' });
			expect(await createBlockStorage('Y').getLatest()).to.deep.equal({ rev: 3, actionId: 'a3' });
			expect(((await createBlockStorage('X').getBlock())!.block as ValueBlock).value).to.equal('x2');

			// And nothing appended — the invalidation stays re-deliverable at a slot past every tip.
			expect(await log.findInvalidation('a2')).to.equal(undefined);
			const retry = await applyInvalidation({ log, createBlockStorage }, {
				invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['X', 'Y'], proof, rev: 4,
			});
			expect(retry.applied).to.equal(true);
			expect(retry.rev).to.equal(4);
			expect((await log.findInvalidation('a2'))?.reverted.length).to.equal(2);
		});

		it('acquires multi-block latches in sorted order: a commit and an invalidation over the same two blocks do not deadlock', async () => {
			const raw = new MemoryRawStorage();
			// Ids chosen so request order (['mb-z','mb-a']) differs from sorted acquisition order.
			const { repo, createBlockStorage } = await seedWrites(raw, [
				{ actionId: 'a1', rev: 1, blockId: 'mb-a', value: 'a1' },
				{ actionId: 'a1z', rev: 1, blockId: 'mb-z', value: 'z1' },
				{ actionId: 'a2', rev: 2, blockId: 'mb-a', value: 'a2' },
			]);
			const log = await Log.create<unknown>(new MemLogStore());
			const proof = await challengerWinsProof('d1', 'msg-1', { invalidatedActionId: 'a2', blockIds: ['mb-z', 'mb-a'] });

			await repo.pend({
				actionId: 'c3',
				transforms: { updates: { ...updateOp('mb-a', 'a3').updates, ...updateOp('mb-z', 'z3').updates } },
				rev: 3,
			} as Parameters<StorageRepo['pend']>[0]);

			// Both multi-latch holders take their keys in sorted id order, so whichever queues first runs
			// to completion and the other follows — no acquisition cycle, so neither can hang.
			const [commitResult, invResult] = await Promise.all([
				repo.commit({ actionId: 'c3', rev: 3, blockIds: ['mb-a', 'mb-z'], tailId: 'log' }),
				applyInvalidation({ log, createBlockStorage }, {
					invalidatedActionId: 'a2', invalidatedRev: 2, blockIds: ['mb-z', 'mb-a'], proof,
				}),
			]);

			// Whatever the interleaving, latest is monotonic on both blocks and the invalidation only
			// reports blocks whose compensating write is the revision actually in effect.
			const latestA = (await createBlockStorage('mb-a').getLatest())!;
			const latestZ = (await createBlockStorage('mb-z').getLatest())!;
			expect(latestA.rev).to.be.at.least(2);
			expect(latestZ.rev).to.be.at.least(1);

			if (invResult.applied) {
				expect(invResult.reverted.map(r => r.blockId)).to.have.members(['mb-z', 'mb-a']);
				for (const rb of invResult.reverted) {
					const latest = (await createBlockStorage(rb.blockId).getLatest())!;
					expect(latest.rev).to.equal(invResult.rev);
					const current = await createBlockStorage(rb.blockId).getBlock();
					expect(rb.restoredContentHash).to.equal(
						current ? await hashBlockContent(current.block) : DELETED_BLOCK_RESTORE);
				}
			} else {
				expect(invResult.reason).to.equal('stale-revision');
				expect(await log.findInvalidation('a2')).to.equal(undefined);
			}
			expect(commitResult.success).to.equal(true);
		});
	});
});

describe('BlockStorage.saveDeletion (tombstone write path)', () => {
	it('reads back absent while preserving historical content; monotonic + idempotent', async () => {
		const raw = new MemoryRawStorage();
		// B created @1, updated @2.
		const { createBlockStorage } = await seedBlock(raw, 'B', [
			{ actionId: 'a1', value: 'created', rev: 1 },
			{ actionId: 'a2', value: 'updated', rev: 2 },
		]);
		const storage = createBlockStorage('B');

		// Tombstone the block at rev 3 (writes demand the block's write-latch token).
		const latest = await withBlockWriteLatch('B', latch => storage.saveDeletion({ rev: 3, actionId: 'tomb' }, latch));
		expect(latest).to.deep.equal({ rev: 3, actionId: 'tomb' });

		// getBlock() (latest) and getBlock(tombstoneRev) both read as absent — no throw, no placeholder.
		expect(await storage.getBlock()).to.equal(undefined);
		expect(await storage.getBlock(3)).to.equal(undefined);

		// Historical revisions still materialize the content that existed then.
		expect(((await storage.getBlock(1))!.block as ValueBlock).value).to.equal('created');
		expect(((await storage.getBlock(2))!.block as ValueBlock).value).to.equal('updated');

		// Idempotent for a fixed (rev, actionId); monotonic — a stale lower-rev tombstone is a no-op.
		expect(await withBlockWriteLatch('B', latch => storage.saveDeletion({ rev: 3, actionId: 'tomb' }, latch))).to.deep.equal({ rev: 3, actionId: 'tomb' });
		expect(await withBlockWriteLatch('B', latch => storage.saveDeletion({ rev: 2, actionId: 'stale' }, latch))).to.deep.equal({ rev: 3, actionId: 'tomb' });
		expect((await storage.getLatest())!.rev).to.equal(3);
	});
});
