/**
 * Integration: real libp2p Ed25519 keys through the client-transaction-signature seams.
 *
 * The db-core half (implement-client-tx-signature-core) defined the signer/verifier PORTS but left them
 * un-backed. This exercises the p2p backing this ticket supplies — the exact closures the Quereus plugin
 * wires:
 *   - signer:   async payload => bytesToB64url(await signPeer(nodeKey, payload))
 *   - verifier: (peerId, payload, sig) => { try { return verifyPeerSig(peerId, payload, b64urlToBytes(sig)); } catch { return false; } }
 * driven through db-core's TransactionSession (sign) and TransactionValidator (verify) with a genuine
 * generateKeyPair('Ed25519') identity, so the crypto actually round-trips end to end.
 *
 * Both closures, plus the validator/transaction builders, live in `test/support/client-tx-signature.ts`
 * — shared with `mesh-client-signature-enforcement.spec.ts`, which runs the same seam through a live
 * cluster PEND. This file stays the SINGLE-PROCESS tier: validator constructed directly, no mesh.
 */

import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import {
	ActionsEngine,
	createActionsStatements,
	clientSignaturePayload,
	bytesToB64url,
	b64urlToBytes,
	TransactionValidator,
	TransactionSession,
	TransactionCoordinator,
	Tree,
	type Transaction,
} from '@optimystic/db-core';
import { TestTransactor } from '@optimystic/db-core/test';
import { signPeer } from '../src/cohort-topic/peer-sig.js';
import {
	SCHEMA_HASH,
	makeSigner,
	makeValidator,
	verifier,
	emptyOpsHash,
	buildSignedTx,
	buildUnsignedTx,
} from './support/client-tx-signature.js';

describe('Client transaction signatures — real Ed25519 keys (p2p backing)', () => {
	let keyA: PrivateKey;
	let keyB: PrivateKey;
	let peerA: string;

	beforeEach(async () => {
		keyA = await generateKeyPair('Ed25519');
		keyB = await generateKeyPair('Ed25519');
		peerA = peerIdFromPrivateKey(keyA).toString();
	});

	it('a signature made by signPeer verifies via verifyPeerSig over the same payload (happy path)', async () => {
		const tx = await buildSignedTx(peerA, keyA);
		const result = await makeValidator(verifier).validate(tx, await emptyOpsHash());
		expect(result.valid, result.reason).to.be.true;
	});

	it('rejects impersonation: peerId is A but the transaction was signed with B\'s key', async () => {
		// The public key derived from peerA cannot verify a signature made by keyB.
		const tx = await buildSignedTx(peerA, keyB, {
			statements: createActionsStatements([
				{ collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
			]),
		});
		const result = await makeValidator(verifier).validate(tx, await emptyOpsHash());
		expect(result.valid).to.be.false;
		expect(result.reason).to.equal('Invalid client signature');
	});

	it('rejects a tampered statement: signature is valid for A but statements are mutated after signing', async () => {
		// Distinct from impersonation (wrong key): here the key/peer-id match, but a relayer alters the
		// signed CONTENT. The payload binds `statements`, so the original signature no longer verifies.
		const tx = await buildSignedTx(peerA, keyA, {
			statements: createActionsStatements([
				{ collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
			]),
		});
		// Tamper AFTER signing, keeping the same (now-stale) signature.
		tx.statements = createActionsStatements([
			{ collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Mallory' }]] }] },
		]);
		const result = await makeValidator(verifier).validate(tx, await emptyOpsHash());
		expect(result.valid).to.be.false;
		expect(result.reason).to.equal('Invalid client signature');
	});

	it('rejects a malformed (non-Ed25519 peer-id) stamp with enforcement on, without throwing', async () => {
		// Sign with a real key but stamp a peer-id string that is not a valid libp2p identity.
		// peerIdFromString throws inside verifyPeerSig; the closure catches → false → clean reject.
		const tx = await buildUnsignedTx('not-a-real-peer-id');
		tx.signature = await makeSigner(keyA)(clientSignaturePayload(tx.stamp.id, [], []));
		const validator = makeValidator(verifier);
		let result: Awaited<ReturnType<TransactionValidator['validate']>> | undefined;
		let threw = false;
		try {
			result = await validator.validate(tx, await emptyOpsHash());
		} catch {
			threw = true;
		}
		expect(threw, 'verifier must be total — never throws').to.be.false;
		expect(result!.valid).to.be.false;
		expect(result!.reason).to.equal('Invalid client signature');
	});

	it('rejects a non-base64url signature with enforcement on, without throwing', async () => {
		// A garbage signature string that b64urlToBytes cannot decode — the closure's try/catch keeps it total.
		const tx = await buildUnsignedTx(peerA);
		tx.signature = '!!!not base64url!!!';
		const result = await makeValidator(verifier).validate(tx, await emptyOpsHash());
		expect(result.valid).to.be.false;
		expect(result.reason).to.equal('Invalid client signature');
	});

	it('with enforcement OFF, both a signed and an unsigned transaction pass the signature step', async () => {
		const validator = makeValidator(undefined);

		const signed = await buildSignedTx(peerA, keyA);
		expect((await validator.validate(signed, await emptyOpsHash())).valid, 'signed accepted').to.be.true;

		const unsigned = await buildUnsignedTx(peerA);
		expect((await validator.validate(unsigned, await emptyOpsHash())).valid, 'unsigned accepted').to.be.true;
	});

	it('with enforcement ON, an unsigned transaction is rejected as missing a signature', async () => {
		const tx = await buildUnsignedTx(peerA);
		const result = await makeValidator(verifier).validate(tx, await emptyOpsHash());
		expect(result.valid).to.be.false;
		expect(result.reason).to.equal('Missing client signature');
	});

	it('base64url round-trips: the encoded signature decodes back to the raw signPeer bytes', async () => {
		const payload = clientSignaturePayload('stamp:x', ['stmt'], []);
		const rawSig = await signPeer(keyA, payload);
		const encoded = bytesToB64url(rawSig);
		expect(Array.from(b64urlToBytes(encoded))).to.deep.equal(Array.from(rawSig));
		// And that encoding verifies through the plugin's verifier closure.
		expect(verifier(peerA, payload, encoded)).to.be.true;
	});

	it('the signature survives a JSON serialize/deserialize round-trip and still verifies (recovery hook)', async () => {
		const tx = await buildSignedTx(peerA, keyA, {
			statements: createActionsStatements([
				{ collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] },
			]),
			reads: [{ blockId: 'block-1', revision: 3 }],
		});
		const roundTripped = JSON.parse(JSON.stringify(tx)) as Transaction;
		expect(roundTripped.signature).to.equal(tx.signature);
		const payload = clientSignaturePayload(roundTripped.stamp.id, roundTripped.statements, roundTripped.reads);
		expect(verifier(roundTripped.stamp.peerId, payload, roundTripped.signature!)).to.be.true;
	});

	it('a stamp forged onto a different peer id is caught before the signature step', async () => {
		// `computeStampId` binds every stamp field, so swapping the identity after stamping breaks the
		// id first. Pinned because the signature cases above are only meaningful while this ordering
		// holds: a spec that mutates a stamp gets `Tampered transaction stamp`, not a signature verdict.
		const tx = await buildSignedTx(peerA, keyA);
		tx.stamp = { ...tx.stamp, peerId: peerIdFromPrivateKey(keyB).toString() };
		const result = await makeValidator(verifier).validate(tx, await emptyOpsHash());
		expect(result.valid).to.be.false;
		expect(result.reason).to.equal('Tampered transaction stamp');
	});

	it('a TransactionSession created with the real signer stamps a committed transaction that verifies', async () => {
		// Exercises the exact TransactionSession.create(..., signer) seam txn-bridge uses, with a real key.
		const transactor = new TestTransactor();
		type UserEntry = { key: number; name: string };
		const usersTree = await Tree.createOrOpen<number, UserEntry>(transactor, 'users', e => e.key);
		const usersCollection = (usersTree as unknown as { collection: unknown }).collection;
		const collections = new Map();
		collections.set('users', usersCollection);
		const coordinator = new TransactionCoordinator(transactor, collections);

		const committed: Transaction[] = [];
		const realCommit = coordinator.commit.bind(coordinator);
		coordinator.commit = async (tx: Transaction) => { committed.push(tx); return realCommit(tx); };

		const session = await TransactionSession.create(
			coordinator, new ActionsEngine(), peerA, SCHEMA_HASH, undefined, makeSigner(keyA)
		);
		await session.execute(
			'stmt',
			[{ collectionId: 'users', actions: [{ type: 'replace', data: [[1, { key: 1, name: 'Alice' }]] }] }]
		);
		const result = await session.commit();
		expect(result.success, result.error).to.be.true;

		expect(committed).to.have.lengthOf(1);
		const tx = committed[0]!;
		expect(tx.signature, 'signer stamped a signature').to.be.a('string');
		const payload = clientSignaturePayload(tx.stamp.id, tx.statements, tx.reads);
		expect(verifier(tx.stamp.peerId, payload, tx.signature!), 'committed signature verifies').to.be.true;
	});
});
