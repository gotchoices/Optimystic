/**
 * Quereus Plugin Entry Point for Crypto Functions
 *
 * This module provides the plugin registration following Quereus 0.4.5 format.
 * All metadata is in package.json - no manifest export needed.
 */

import type { Database, FunctionFlags, SqlValue } from '@quereus/quereus';
import { digest, sign, verify, hashMod, randomBytes } from './crypto.js';

/**
 * Plugin registration function
 * This is called by Quereus when the plugin is loaded
 */
export default function register(_db: Database, _config: Record<string, SqlValue> = {}) {
	// Register crypto functions with Quereus
	const functions = [
		{
			schema: {
				name: 'digest',
				numArgs: -1, // Variable arguments: data, algorithm?, inputEncoding?, outputEncoding?
				flags: 1 as FunctionFlags, // UTF8
				returnType: { typeClass: 'scalar' as const, sqlType: 'TEXT' },
				implementation: (...args: SqlValue[]) => {
					const [data, algorithm = 'sha256', inputEncoding = 'base64url', outputEncoding = 'base64url'] = args;
					return digest(data as string, algorithm as any, inputEncoding as any, outputEncoding as any);
				},
			},
		},
		{
			schema: {
				name: 'sign',
				numArgs: -1, // Variable arguments: data, privateKey, curve?, inputEncoding?, keyEncoding?, outputEncoding?
				flags: 1 as FunctionFlags,
				returnType: { typeClass: 'scalar' as const, sqlType: 'TEXT' },
				implementation: (...args: SqlValue[]) => {
					const [data, privateKey, curve = 'secp256k1', inputEncoding = 'base64url', keyEncoding = 'base64url', outputEncoding = 'base64url'] = args;
					return sign(data as string, privateKey as string, curve as any, inputEncoding as any, keyEncoding as any, outputEncoding as any);
				},
			},
		},
		{
			schema: {
				name: 'verify',
				numArgs: -1, // Variable arguments: data, signature, publicKey, curve?, inputEncoding?, sigEncoding?, keyEncoding?
				flags: 1 as FunctionFlags,
				returnType: { typeClass: 'scalar' as const, sqlType: 'INTEGER' },
				implementation: (...args: SqlValue[]) => {
					const [data, signature, publicKey, curve = 'secp256k1', inputEncoding = 'base64url', sigEncoding = 'base64url', keyEncoding = 'base64url'] = args;
					const result = verify(data as string, signature as string, publicKey as string, curve as any, inputEncoding as any, sigEncoding as any, keyEncoding as any);
					return result ? 1 : 0;
				},
			},
		},
		{
			schema: {
				name: 'hash_mod',
				numArgs: -1, // Variable arguments: data, bits, algorithm?, inputEncoding?
				flags: 1 as FunctionFlags,
				returnType: { typeClass: 'scalar' as const, sqlType: 'INTEGER' },
				implementation: (...args: SqlValue[]) => {
					const [data, bits, algorithm = 'sha256', inputEncoding = 'base64url'] = args;
					return hashMod(data as string, bits as number, algorithm as any, inputEncoding as any);
				},
			},
		},
		{
			schema: {
				name: 'random_bytes',
				numArgs: -1, // Variable arguments: bits?, encoding?
				flags: 1 as FunctionFlags,
				returnType: { typeClass: 'scalar' as const, sqlType: 'TEXT' },
				implementation: (...args: SqlValue[]) => {
					const [bits = 256, encoding = 'base64url'] = args;
					return randomBytes(bits as number, encoding as any);
				},
			},
		},
	];

	return {
		functions,
		vtables: [],
		collations: [],
	};
}

