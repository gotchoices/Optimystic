/**
 * Transaction support for Quereus-Optimystic integration.
 *
 * This module provides the QuereusEngine for executing SQL transactions
 * through the Optimystic distributed transaction system.
 */

export {
	QuereusEngine,
	QUEREUS_ENGINE_ID,
	createQuereusStatement,
	createQuereusStatements
} from './quereus-engine.js';

export type { QuereusStatement } from './quereus-engine.js';

export { createQuereusValidator } from './quereus-validator.js';
export type { QuereusValidatorOptions } from './quereus-validator.js';

