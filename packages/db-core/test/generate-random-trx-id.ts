import { randomBytes } from '@libp2p/crypto';
import { toString as uint8ArrayToString } from 'uint8arrays';
import type { ActionId } from '../src/index.js';

// Helper function to generate base64url encoded ActionIds
export function generateRandomActionId(): ActionId {
	const bytes = randomBytes(8);
	return uint8ArrayToString(bytes, 'base64url');
}
