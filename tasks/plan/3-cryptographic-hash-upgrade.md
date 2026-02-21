# Cryptographic Hash Upgrade

## Summary

The current `hashString` utility uses djb2, a non-cryptographic hash function. While the immediate bug (incorrect `& acc` instead of proper 32-bit truncation) has been fixed, the underlying security concern remains: djb2 is not collision-resistant and should not be used for security-critical identifiers.

## Current State

- **Fixed**: `packages/db-core/src/utility/hash-string.ts` - Shared djb2 implementation
- **Uses hashString**: 
  - `transaction.ts` - Transaction stamp IDs and transaction IDs
  - `coordinator.ts` - Operations hash for validation
  - `validator.ts` - Operations hash for validation (must match coordinator)

## Recommendation

Replace djb2 with SHA-256 for all security-critical hashing:

1. **Transaction IDs** - Should use cryptographic hash to prevent ID collisions/spoofing
2. **Operations hash** - Used for validation; collision could allow transaction substitution

## Available Resources

The codebase already has SHA-256 available:
- `multiformats/hashes/sha2` - Used in `block-id-to-bytes.ts`
- `@noble/hashes` - Available in db-p2p

## Implementation Notes

- SHA-256 is async (`sha256.digest()` returns Promise)
- Consider creating `hashStringAsync` utility alongside sync version
- Transaction ID generation would need to become async
- Ensure coordinator and validator use identical hashing

## Priority

Medium - The djb2 hash is now correctly implemented, but upgrading to cryptographic hash would improve security posture for production use.

## Related Tasks

- HUNT-2.1.1, HUNT-2.1.2 (completed - bug fix)
- SEC-9.2.1 (signature verification stub)

