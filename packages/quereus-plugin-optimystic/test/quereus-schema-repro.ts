/**
 * Quereus schema() function - indexes not included
 * 
 * Run with: npx tsx test/quereus-schema-repro.ts
 * 
 * ISSUE: The schema() table-valued function does not include indexes.
 * Indexes are correctly tracked in schemaManager (table.indexes) but
 * not exposed via the schema() function.
 * 
 * Expected: schema() should return rows with type='index' for each index.
 * Actual: schema() only returns 'table' and 'function' types.
 */

import { Database } from '@quereus/quereus';

async function main() {
	const db = new Database();

	// Create a table and an index
	await db.exec(`
		CREATE TABLE products (
			id INTEGER PRIMARY KEY,
			name TEXT,
			category TEXT
		)
	`);
	await db.exec('CREATE INDEX idx_category ON products(category)');

	console.log('Created table "products" with index "idx_category"');

	// Verify index exists in schemaManager
	const table = db.schemaManager.getTable('main', 'products');
	console.log('\nIndex exists in schemaManager:', table?.indexes?.map(i => i.name));

	// Query schema() for indexes
	console.log('\nQuerying schema() for indexes:');
	const indexes = [];
	for await (const row of db.eval("SELECT * FROM schema() WHERE type='index'")) {
		indexes.push(row);
	}
	console.log('Found', indexes.length, 'indexes in schema()');

	// Show all distinct types
	console.log('\nAll types in schema():');
	for await (const row of db.eval('SELECT DISTINCT type FROM schema()')) {
		console.log(' -', row.type);
	}
}

main().catch(console.error);

