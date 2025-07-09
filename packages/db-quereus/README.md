# @optimystic/db-quereus

A Quereus virtual table plugin that provides SQL access to Optimystic tree collections.

## Overview

This plugin allows you to query and manipulate Optimystic distributed tree collections using standard SQL syntax through Quereus. It bridges the gap between SQL databases and Optimystic's distributed data structures.

## Installation

```bash
npm install @optimystic/db-quereus
```

## Quick Start

```typescript
import { Database } from 'quereus';
import { dynamicLoadModule } from 'quereus/plugin-loader';

const db = new Database();

// Load and register the plugin
await dynamicLoadModule('@optimystic/db-quereus', db, {
  default_transactor: 'network',
  default_key_network: 'libp2p',
  enable_cache: true
});

// Create a virtual table backed by an Optimystic tree collection
await db.exec(`
  CREATE TABLE users USING optimystic(
    'tree://myapp/users',
    transactor='network',
    keyNetwork='libp2p'
  )
`);

// Query the distributed data
const users = await db.all('SELECT * FROM users WHERE id = ?', ['user123']);
```

## Configuration Options

The plugin supports various configuration options passed as arguments to the `USING` clause:

### Basic Options

- **collectionUri** (required): URI identifying the tree collection (e.g., `'tree://myapp/users'`)
- **transactor**: Type of transactor to use (`'network'`, `'test'`, or custom)
- **keyNetwork**: Type of key network (`'libp2p'`, `'test'`, or custom)

### Network Options

- **port**: Port for libp2p node (default: random)
- **networkName**: Network identifier (default: `'optimystic'`)
- **cache**: Enable local caching (default: `true`)
- **encoding**: Row encoding format (`'json'` or `'msgpack'`, default: `'json'`)

### Example with Options

```sql
CREATE TABLE products USING optimystic(
  'tree://store/products',
  transactor='network',
  keyNetwork='libp2p',
  port=8080,
  networkName='mystore',
  cache=true,
  encoding='json'
);
```

## SQL Operations

### SELECT Queries

```sql
-- Point lookups (optimized)
SELECT * FROM users WHERE id = 'user123';

-- Range scans
SELECT * FROM users WHERE id BETWEEN 'user100' AND 'user200';

-- Full table scans
SELECT * FROM users ORDER BY id;
```

### INSERT Operations

```sql
INSERT INTO users (id, data) 
VALUES ('user456', '{"name": "Alice", "email": "alice@example.com"}');
```

### UPDATE Operations

```sql
UPDATE users 
SET data = '{"name": "Alice Smith", "email": "alice.smith@example.com"}'
WHERE id = 'user456';
```

### DELETE Operations

```sql
DELETE FROM users WHERE id = 'user456';
```

## Data Model

The plugin provides a simple key-value interface to Optimystic tree collections:

- **Primary Key**: The `id` column serves as the tree key (TEXT type)
- **Data**: The `data` column stores the value (TEXT type, can be JSON)
- **Schema**: Fixed schema with `id` and `data` columns

### Example Schema

```sql
-- The schema is automatically defined as:
CREATE TABLE optimystic_tree (
  id TEXT PRIMARY KEY,
  data TEXT
) WITHOUT ROWID;
```

### Storing Complex Data

```sql
-- Store JSON data in the data column
INSERT INTO users VALUES ('user123', '{"name": "Alice", "email": "alice@example.com"}');

-- Query JSON data using Quereus JSON functions
SELECT id, json_extract(data, '$.name') as name 
FROM users 
WHERE json_extract(data, '$.email') LIKE '%@example.com';
```

## Transactions

The plugin supports Quereus transactions, which map to Optimystic's sync mechanism:

```typescript
await db.exec('BEGIN');
await db.exec("INSERT INTO users VALUES ('u1', '{\"name\": \"John\", \"email\": \"john@example.com\"}')");
await db.exec("INSERT INTO users VALUES ('u2', '{\"name\": \"Jane\", \"email\": \"jane@example.com\"}')");
await db.exec('COMMIT'); // Syncs changes to the distributed network
```

- **BEGIN**: Creates a new Optimystic transactor
- **COMMIT**: Syncs all collections used in the transaction
- **ROLLBACK**: Discards local changes and clears collection cache

## Custom Networks and Transactors

You can register custom implementations for advanced use cases:

```typescript
import { registerKeyNetwork, registerTransactor } from '@optimystic/db-quereus';

// Register a custom key network
registerKeyNetwork('mynetwork', MyCustomKeyNetwork);

// Register a custom transactor
registerTransactor('mytransactor', MyCustomTransactor);

// Use in SQL
await db.exec(`
  CREATE TABLE data USING optimystic(
    'tree://app/data',
    transactor='mytransactor',
    keyNetwork='mynetwork'
  )
`);
```

## Performance Considerations

### Query Optimization

- **Point Lookups**: Queries with `WHERE id = ?` are highly optimized
- **Range Scans**: Queries with `WHERE id BETWEEN ? AND ?` use efficient tree iteration
- **Full Scans**: Queries without key constraints iterate the entire collection

### Caching

- Collections are cached within transactions and between queries
- Set `cache=false` to disable caching if memory is a concern
- Cache is automatically cleared on rollback

### Network Efficiency

- Use transactions to batch multiple operations
- Consider using `'test'` transactor for local development
- Configure appropriate libp2p options for your network topology

## Error Handling

The plugin maps Optimystic errors to appropriate SQL error codes:

- **Collection not found**: `SQLITE_CONSTRAINT_PRIMARYKEY`
- **Network timeouts**: `SQLITE_BUSY`
- **Decoding failures**: `SQLITE_CORRUPT`
- **Configuration errors**: `SQLITE_ERROR`

## Limitations

- Primary key must be TEXT type (tree keys are strings)
- No secondary indexes (use appropriate WHERE clauses for performance)
- Cross-collection transactions not yet supported
- Savepoints not implemented

## Development

### Building

```bash
npm run build
```

### Type Checking

```bash
npm run typecheck
```

## License

MIT

## Contributing

Contributions are welcome! Please see the main Optimystic repository for contribution guidelines. 
