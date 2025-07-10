# @optimystic/db-quereus

A Quereus virtual table plugin that provides SQL access to Optimystic tree collections.

## Overview

This plugin allows you to query and manipulate Optimystic distributed tree collections using standard SQL syntax through Quereus. It bridges the gap between SQL databases and Optimystic's distributed data structures.

The plugin also provides a comprehensive suite of **27 configurable cryptographic functions** for hash computation, ECC signing, signature verification, and key management. All algorithms are selectable and optimized for blockchain, Web3, and secure application development.

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

// Use crypto functions with algorithm selection
const sha256Hash = await db.get("SELECT DigestSHA256('hello', 'world') as hash");
const blake3Hash = await db.get("SELECT DigestBLAKE3Hex('fast', 'hash') as hash");

// Generate keys and sign with specific curves
const keyGen = await db.get("SELECT GeneratePrivateKeySecp256k1() as key, GetPublicKeySecp256k1(GeneratePrivateKeySecp256k1()) as pubkey");
const btcSignature = await db.get("SELECT SignSecp256k1Hex(?, ?) as sig", [sha256Hash.hash, keyGen.key]);
const isValid = await db.get("SELECT SignatureValidSecp256k1(?, ?, ?) as valid", [sha256Hash.hash, btcSignature.sig, keyGen.pubkey]);
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

## Cryptographic Functions

The plugin provides a comprehensive set of portable cryptographic functions that work across all JavaScript environments, including React Native. All functions are built on audited @noble/* libraries for maximum security and compatibility.

### Hash Functions

#### Basic Digest Functions
```sql
-- SHA-256 (default)
SELECT Digest('hello', 'world') as hash;
SELECT DigestSHA256('hello', 'world') as sha256_hash;

-- SHA-512
SELECT DigestSHA512('sensitive', 'data') as sha512_hash;

-- BLAKE3 (fastest)
SELECT DigestBLAKE3('high', 'performance', 'data') as blake3_hash;
```

#### Hex Output Variants
```sql
-- Get hex strings instead of binary
SELECT DigestHex('hello', 'world') as hex_hash;
SELECT DigestSHA256Hex('data') as sha256_hex;
SELECT DigestSHA512Hex('data') as sha512_hex;
SELECT DigestBLAKE3Hex('data') as blake3_hex;
```

### Digital Signatures

#### Algorithm-Specific Signing
```sql
-- secp256k1 (Bitcoin/Ethereum)
SELECT SignSecp256k1(digest, private_key) as btc_signature;
SELECT SignSecp256k1Hex(digest, private_key) as btc_sig_hex;

-- P-256 (NIST/Government)
SELECT SignP256(digest, private_key) as nist_signature;
SELECT SignP256Hex(digest, private_key) as nist_sig_hex;

-- Ed25519 (Modern/Fast)
SELECT SignEd25519(digest, private_key) as ed25519_signature;
SELECT SignEd25519Hex(digest, private_key) as ed25519_sig_hex;
```

#### Signature Verification
```sql
-- Algorithm-specific verification
SELECT SignatureValidSecp256k1(digest, sig, pubkey) as btc_valid;
SELECT SignatureValidP256(digest, sig, pubkey) as nist_valid;
SELECT SignatureValidEd25519(digest, sig, pubkey) as ed25519_valid;
```

### Key Management

#### Private Key Generation
```sql
-- Generate random private keys
SELECT GeneratePrivateKey() as random_key;  -- secp256k1 default
SELECT GeneratePrivateKeySecp256k1() as btc_key;
SELECT GeneratePrivateKeyP256() as nist_key;
SELECT GeneratePrivateKeyEd25519() as ed25519_key;
```

#### Public Key Derivation
```sql
-- Derive public keys from private keys
SELECT GetPublicKey(private_key) as public_key;  -- secp256k1 default
SELECT GetPublicKeySecp256k1(private_key) as btc_pubkey;
SELECT GetPublicKeyP256(private_key) as nist_pubkey;
SELECT GetPublicKeyEd25519(private_key) as ed25519_pubkey;
```

### Complete Example: Digital Identity

```sql
-- 1. Generate a key pair
WITH new_identity AS (
  SELECT 
    GeneratePrivateKeySecp256k1() as private_key,
    GetPublicKeySecp256k1(GeneratePrivateKeySecp256k1()) as public_key
),

-- 2. Create and sign a message
signed_message AS (
  SELECT 
    private_key,
    public_key,
    DigestSHA256('Hello, Web3 World!', public_key) as message_hash,
    SignSecp256k1Hex(
      DigestSHA256('Hello, Web3 World!', public_key), 
      private_key
    ) as signature
  FROM new_identity
)

-- 3. Verify the signature
SELECT 
  public_key,
  signature,
  SignatureValidSecp256k1(message_hash, signature, public_key) as is_authentic,
  CASE 
    WHEN SignatureValidSecp256k1(message_hash, signature, public_key) 
    THEN 'VERIFIED ✓' 
    ELSE 'INVALID ✗' 
  END as status
FROM signed_message;
```

### Algorithm Comparison

| Algorithm | Use Case | Speed | Security | Key Size | Signature Size |
|-----------|----------|-------|----------|----------|----------------|
| **secp256k1** | Bitcoin, Ethereum, Crypto | Medium | High | 32 bytes | 64 bytes |
| **P-256** | Government, Enterprise | Medium | High | 32 bytes | 64 bytes |
| **Ed25519** | Modern apps, Performance | Fast | High | 32 bytes | 64 bytes |
| **SHA-256** | General hashing | Fast | High | - | 32 bytes |
| **SHA-512** | High security | Medium | Very High | - | 64 bytes |
| **BLAKE3** | High performance | Very Fast | High | - | 32 bytes |

### JavaScript Usage

All functions are also available in JavaScript with full TypeScript support:

```typescript
import { 
  Digest, DigestSHA512, DigestHex,
  Sign, SignSecp256k1, SignEd25519,
  SignatureValid, GeneratePrivateKey, GetPublicKey
} from '@optimystic/db-quereus';

// Generate keypair
const privateKey = Sign.generatePrivateKey('secp256k1');
const publicKey = Sign.getPublicKey(privateKey);

// Hash with different algorithms
const sha256Hash = Digest('hello', 'world');
const sha512Hash = DigestSHA512('sensitive', 'data');
const hexHash = DigestHex('readable', 'output');

// Sign with specific curves
const btcSignature = SignSecp256k1(sha256Hash, privateKey);
const edSignature = SignEd25519(sha256Hash, privateKey);

// Verify signatures
const isBtcValid = SignatureValid.secp256k1(sha256Hash, btcSignature, publicKey);
const isEdValid = SignatureValid.ed25519(sha256Hash, edSignature, publicKey);

// Advanced options
const hedgedSignature = Sign(sha256Hash, privateKey, {
  extraEntropy: true,  // Protection against fault attacks
  curve: 'p256',
  format: 'hex'
});
```

### React Native Compatibility

All cryptographic functions are fully compatible with React Native:

- ✅ **No native modules required**
- ✅ **Works on iOS and Android**
- ✅ **Expo compatible**
- ✅ **Uses standard Web APIs**
- ✅ **Secure random number generation**

```typescript
// React Native example
import { Digest, Sign, GeneratePrivateKey } from '@optimystic/db-quereus';

const createWallet = () => {
  const privateKey = GeneratePrivateKey();
  const publicKey = Sign.getPublicKey(privateKey);
  const address = Digest.hex(publicKey).slice(-40); // Last 20 bytes as hex
  
  return { privateKey, publicKey, address };
};
```

### Function Availability Summary

The plugin provides **27 cryptographic functions** for SQL usage:

#### Hash Functions (8 functions)
- `Digest()`, `DigestSHA256()`, `DigestSHA512()`, `DigestBLAKE3()`
- `DigestHex()`, `DigestSHA256Hex()`, `DigestSHA512Hex()`, `DigestBLAKE3Hex()`

#### Signing Functions (7 functions)  
- `Sign()`, `SignSecp256k1()`, `SignP256()`, `SignEd25519()`
- `SignSecp256k1Hex()`, `SignP256Hex()`, `SignEd25519Hex()`

#### Verification Functions (4 functions)
- `SignatureValid()`, `SignatureValidSecp256k1()`, `SignatureValidP256()`, `SignatureValidEd25519()`

#### Key Management Functions (8 functions)
- `GeneratePrivateKey()`, `GeneratePrivateKeySecp256k1()`, `GeneratePrivateKeyP256()`, `GeneratePrivateKeyEd25519()`
- `GetPublicKey()`, `GetPublicKeySecp256k1()`, `GetPublicKeyP256()`, `GetPublicKeyEd25519()`

All functions work identically in SQL queries and JavaScript/TypeScript code, with full React Native support.

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
