/**
 * Optimystic Plugin for Quereus
 *
 * This plugin provides a virtual table module for Quereus that allows
 * querying Optimystic distributed tree collections using SQL.
 *
 * Usage:
 *   CREATE TABLE users USING optimystic(
 *     'tree://myapp/users',
 *     transactor='network',
 *     keyNetwork='libp2p'
 *   );
 */

// Re-export the plugin register function
export { default as register } from './plugin.js';

// Export utility functions for custom implementations
export { registerKeyNetwork, registerTransactor } from './optimystic-adapter/key-network.js';

// Export virtual table classes
export { OptimysticModule, OptimysticVirtualTable } from './optimystic-module.js';

// Export types for TypeScript users
export type {
	OptimysticOptions as OptimysticTreeOptions,
	ParsedOptimysticOptions as ParsedOptimysticTreeOptions,
	LibP2PNodeOptions,
	ColumnDefinition,
	RowData,
	TransactionState,
} from './types.js';

// Export transaction engine and validator
export {
	QuereusEngine,
	QUEREUS_ENGINE_ID,
	createQuereusStatement,
	createQuereusStatements,
	createQuereusValidator,
} from './transaction/index.js';

export type { QuereusStatement, QuereusValidatorOptions } from './transaction/index.js';
