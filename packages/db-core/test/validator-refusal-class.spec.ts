import { expect } from 'chai';
import {
	ActionsEngine,
	ACTIONS_ENGINE_ID,
	clientSignaturePayload,
	createTransactionId,
	createTransactionStamp,
	hashOperations,
	OPS_HASH_PREFIX,
	TransactionValidator,
	type ClientSignatureVerifier,
	type EngineRegistration,
	type ITransactionEngine,
	type ReadDependency,
	type Transaction,
	type ValidityRejection
} from '../src/index.js';

/**
 * Every `TransactionValidator` refusal, and the class it carries. A refusal that judges the transaction
 * itself wrong carries `validity`; one that is stale, expired, or that this node could not judge carries
 * none. A writer's outcome classification and the dispute trigger both act on that class, so the
 * mapping is the contract — and absent must stay the answer wherever the refusal could clear on retry.
 */
describe('TransactionValidator refusal class', () => {
	const peer = 'client-peer';
	const schema = 'schema-1';
	const fakeSign = (signer: string, payload: Uint8Array): string => `fakesig:${signer}:${new TextDecoder().decode(payload)}`;
	const fakeVerify: ClientSignatureVerifier = (peerId, payload, signature) => signature === fakeSign(peerId, payload);
	const failingEngine: ITransactionEngine = { id: 'failing@1.0.0', execute: async () => ({ success: false, error: 'boom' }) };

	/** Re-executes over an empty validation world, so an honest empty transaction hashes to ops([]). */
	const validator = (): TransactionValidator => {
		const engines = new Map<string, EngineRegistration>([
			[ACTIONS_ENGINE_ID, { engine: new ActionsEngine(), getSchemaHash: async () => schema }],
			[failingEngine.id, { engine: failingEngine, getSchemaHash: async () => schema }]
		]);
		return new TransactionValidator(
			engines,
			() => ({ applyActions: async () => {}, getTransforms: () => new Map(), dispose: () => {} }),
			async () => ({ latest: { rev: 2, actionId: 'current' } }),
			fakeVerify
		);
	};

	type TxShape = { engineId?: string; schemaHash?: string; ageMs?: number; ttlMs?: number; reads?: ReadDependency[] };
	const signedTx = async ({ engineId = ACTIONS_ENGINE_ID, schemaHash = schema, ageMs = 0, ttlMs, reads = [] }: TxShape = {}): Promise<Transaction> => {
		const stamp = await createTransactionStamp(peer, Date.now() - ageMs, schemaHash, engineId, ttlMs);
		const tx: Transaction = { stamp, statements: [], reads, id: await createTransactionId(stamp.id, [], reads) };
		tx.signature = fakeSign(peer, clientSignaturePayload(stamp.id, [], reads));
		return tx;
	};

	type Row = { refusal: string; tx: () => Promise<Transaction>; hash?: string; validity: ValidityRejection | undefined };

	it('marks exactly the refusals that judge the transaction itself wrong', async () => {
		const honestHash = await hashOperations([]);
		const rows: Row[] = [
			{ refusal: 'Tampered transaction stamp', validity: {}, tx: async () => {
				const tx = await signedTx();
				(tx.stamp as { timestamp: number }).timestamp += 1;
				return tx;
			} },
			{ refusal: 'Transaction expired', validity: undefined, tx: () => signedTx({ ageMs: 10_000, ttlMs: 1 }) },
			{ refusal: 'Missing client signature', validity: {}, tx: async () => {
				const tx = await signedTx();
				delete tx.signature;
				return tx;
			} },
			{ refusal: 'Invalid client signature', validity: {}, tx: async () => {
				const tx = await signedTx();
				tx.signature = fakeSign('someone-else', clientSignaturePayload(tx.stamp.id, [], []));
				return tx;
			} },
			{ refusal: 'Unknown engine', validity: undefined, tx: () => signedTx({ engineId: 'nope@1.0.0' }) },
			{ refusal: 'Schema mismatch', validity: undefined, tx: () => signedTx({ schemaHash: 'other-schema' }) },
			{ refusal: 'Stale read', validity: undefined, tx: () => signedTx({ reads: [{ blockId: 'b', revision: 1 }] }) },
			{ refusal: 'Re-execution failed', validity: {}, tx: () => signedTx({ engineId: failingEngine.id }) },
			{ refusal: 'Unsupported operations-hash format version', validity: undefined, tx: () => signedTx(), hash: 'ops.v2:whatever' },
			{ refusal: 'Operations hash mismatch', validity: { computedHash: honestHash }, tx: () => signedTx(), hash: `${OPS_HASH_PREFIX}deadbeef` }
		];

		for (const { refusal, tx, hash, validity } of rows) {
			const result = await validator().validate(await tx(), hash ?? honestHash);
			expect(result.valid, refusal).to.equal(false);
			expect(result.reason, refusal).to.satisfy((reason: string) => reason.startsWith(refusal));
			expect(result.validity, refusal).to.deep.equal(validity);
		}

		const approved = await validator().validate(await signedTx(), honestHash);
		expect(approved.valid, 'the honest transaction').to.equal(true);
		expect(approved.validity, 'an approval is never marked').to.equal(undefined);
	});
});
