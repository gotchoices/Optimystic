/**
 * The client-transaction-signature recipe, shared by every db-p2p spec that needs a real Ed25519
 * identity driving db-core's signer/verifier PORTS.
 *
 * These are the exact closures the Quereus plugin's collection-factory and `quereus-validator` bind
 * in production — reproduced here from `db-p2p` primitives only, so a spec can exercise enforcement
 * without pulling in Quereus (and without the chicken-and-egg of building a `Database` before a
 * mesh). Two consumers today: `test/client-tx-signature.spec.ts` (the seam, single process) and
 * `test/mesh-client-signature-enforcement.spec.ts` (the same seam through a live cluster PEND).
 */

import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import {
	ActionsEngine,
	ACTIONS_ENGINE_ID,
	createTransactionStamp,
	createTransactionId,
	clientSignaturePayload,
	hashOperations,
	bytesToB64url,
	b64urlToBytes,
	TransactionValidator,
	type Transaction,
	type ReadDependency,
	type TransactionSigner,
	type ClientSignatureVerifier,
	type EngineRegistration,
	type ValidationCoordinatorFactory,
} from '@optimystic/db-core';
import { signPeer, verifyPeerSig } from '../../src/cohort-topic/peer-sig.js';

/**
 * The schema hash every stamp and every validator built here agrees on. A stamp carrying a different
 * one fails the validator's step 2 (`Schema mismatch`) long before anything about signatures is
 * decided, so both halves must read the same constant.
 */
export const SCHEMA_HASH = 'schema-hash-123';

/** The exact signer closure the collection-factory binds to a node key. */
export function makeSigner(key: PrivateKey): TransactionSigner {
	return async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(key, payload));
}

/**
 * The exact verifier closure `quereus-validator` wires when `requireClientSignature` is on. Total by
 * construction: `verifyPeerSig` returns false (never throws) on a non-Ed25519 or malformed peer-id,
 * and the try/catch additionally covers the base64url decode.
 */
export const verifier: ClientSignatureVerifier = (peerId, payload, signature) => {
	try {
		return verifyPeerSig(peerId, payload, b64urlToBytes(signature));
	} catch {
		return false;
	}
};

/**
 * The operations hash of a transaction that carries NO statements.
 *
 * A statement-free transaction re-executes to no actions, so the validator's step 8 computes
 * `hashOperations([])` regardless of what transforms the pend request actually carries — which makes
 * every validator step except the signature check pass trivially. That isolation is the whole point;
 * it evaporates the moment a case adds statements.
 */
export const emptyOpsHash = async (): Promise<string> => await hashOperations([]);

/**
 * A `TransactionValidator` over a single {@link ActionsEngine} with a fixed schema hash and empty
 * validation transforms. Pass {@link verifier} to arm signature enforcement; pass nothing for the
 * migration posture, where signed and unsigned both pass the signature step.
 */
export function makeValidator(verify?: ClientSignatureVerifier): TransactionValidator {
	const engines = new Map<string, EngineRegistration>();
	engines.set(ACTIONS_ENGINE_ID, {
		engine: new ActionsEngine(),
		getSchemaHash: async () => SCHEMA_HASH,
	});
	const createValidationCoordinator: ValidationCoordinatorFactory = () => ({
		applyActions: async () => { },
		getTransforms: () => new Map(),
		dispose: () => { },
	});
	return new TransactionValidator(engines, createValidationCoordinator, undefined, verify);
}

export interface BuildTxOptions {
	statements?: string[];
	reads?: ReadDependency[];
}

/**
 * A well-formed, UNSIGNED transaction stamped for `stampPeerId`. Built through
 * `createTransactionStamp`/`createTransactionId` so the validator's tamper and expiry checks — both
 * of which run BEFORE the signature step — pass, and a rejection can only be about the signature.
 */
export async function buildUnsignedTx(
	stampPeerId: string,
	opts: BuildTxOptions = {}
): Promise<Transaction> {
	const statements = opts.statements ?? [];
	const reads = opts.reads ?? [];
	const stamp = await createTransactionStamp(stampPeerId, Date.now(), SCHEMA_HASH, ACTIONS_ENGINE_ID);
	return {
		stamp,
		statements,
		reads,
		id: await createTransactionId(stamp.id, statements, reads),
	};
}

/**
 * Build a transaction stamped for `stampPeerId` and signed with `signKey`. Pass a different key than
 * the stamp identity's to forge an impersonation.
 */
export async function buildSignedTx(
	stampPeerId: string,
	signKey: PrivateKey,
	opts: BuildTxOptions = {}
): Promise<Transaction> {
	const tx = await buildUnsignedTx(stampPeerId, opts);
	const payload = clientSignaturePayload(tx.stamp.id, tx.statements, tx.reads);
	tx.signature = await makeSigner(signKey)(payload);
	return tx;
}

/** A fresh Ed25519 identity: the private key plus the peer-id string a stamp would carry. */
export async function generateClientIdentity(): Promise<{ key: PrivateKey; peerId: string }> {
	const key = await generateKeyPair('Ed25519');
	return { key, peerId: peerIdFromPrivateKey(key).toString() };
}
