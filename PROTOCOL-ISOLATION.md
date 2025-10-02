# Optimystic Protocol Isolation Strategy

## Problem Statement
Optimystic networks need complete isolation from each other and from generic libp2p networks. Nodes from different Optimystic networks (e.g., `production`, `test`, `alice-app`) should never accidentally communicate, even if they connect at the libp2p transport layer.

## Solution: Network-Scoped Protocol Prefixes

All protocol identifiers now incorporate the `networkName` parameter to ensure protocol-level isolation.

### Protocol Structure
```
/optimystic/{networkName}/{service}/{version}/{method}
```

### Examples

#### FRET Protocols
```
/optimystic/production/fret/1.0.0/neighbors
/optimystic/production/fret/1.0.0/neighbors/announce
/optimystic/production/fret/1.0.0/maybeAct
/optimystic/production/fret/1.0.0/leave
/optimystic/production/fret/1.0.0/ping
```

#### Database Protocols
```
/optimystic/production/cluster/1.0.0
/optimystic/production/repo/1.0.0
```

#### Identify Service
```
/optimystic/production (protocolPrefix for identify)
```

## Implementation

### 1. FRET Package (`@optimystic/fret`)

**Protocol factory** (`packages/fret/src/rpc/protocols.ts`):
```typescript
export function makeProtocols(networkName = 'default') {
	const prefix = `/optimystic/${networkName}/fret/1.0.0`;
	return {
		PROTOCOL_NEIGHBORS: `${prefix}/neighbors`,
		PROTOCOL_NEIGHBORS_ANNOUNCE: `${prefix}/neighbors/announce`,
		PROTOCOL_MAYBE_ACT: `${prefix}/maybeAct`,
		PROTOCOL_LEAVE: `${prefix}/leave`,
		PROTOCOL_PING: `${prefix}/ping`,
	};
}
```

**Service configuration**:
- Added `networkName?: string` to `FretConfig`
- Each `FretService` instance creates network-scoped protocols via `makeProtocols()`
- All RPC functions accept optional `protocol` parameter (defaults to static constants for backward compat)

### 2. Database Packages (`@optimystic/db-p2p`)

**Node creation** (`packages/db-p2p/src/libp2p-node.ts`):
```typescript
services: {
	identify: identify({
		protocolPrefix: `/optimystic/${options.networkName}`
	}),
	cluster: clusterService({
		protocolPrefix: `/optimystic/${options.networkName}`
	}),
	repo: repoService({
		protocolPrefix: `/optimystic/${options.networkName}`
	}),
	fret: fretService({ 
		networkName: options.networkName,
		// ... other config
	})
}
```

## Benefits

### 1. **Complete Network Isolation**
Nodes with different `networkName` values:
- Cannot exchange protocol messages (handlers won't match)
- Can coexist on same physical network
- Fail fast with "protocol not supported" errors

### 2. **Flexible Deployment**
- Run multiple isolated networks per machine (test + prod)
- Per-application networks without cross-talk
- Safe multi-tenancy on shared infrastructure

### 3. **Clear Branding**
- `/optimystic/` prefix identifies all Optimystic traffic
- Distinct from generic libp2p protocols
- Version strings future-proof protocol evolution

### 4. **Debugging & Monitoring**
- Easy protocol filtering in network traces
- Clear identification of network boundaries in logs
- Protocol mismatch errors reveal configuration issues early

## Validation

### Test Coverage (`packages/fret/test/network.isolation.spec.ts`)

**Test 1: Cross-Network Isolation**
- Create two nodes with different `networkName` values
- Connect at transport layer
- Start FRET services
- **Assert**: No neighbor snapshots exchanged (protocol mismatch prevents discovery)

**Test 2: Same-Network Discovery**
- Create two nodes with same `networkName`
- Connect and bootstrap
- Start FRET services
- **Assert**: Nodes discover each other via FRET protocols

Both tests pass, confirming protocol-based isolation works correctly.

## Migration Notes

### Backward Compatibility
- Static protocol constants default to `/optimystic/default/...`
- Existing code without `networkName` continues to work
- Tests use `'default'` network unless explicitly overridden

### Breaking Changes
None - all changes are additive. Default behavior maintains compatibility.

## Future Considerations

### 1. Protocol Versioning
Current structure supports version evolution:
```
/optimystic/{networkName}/fret/2.0.0/neighbors  (future)
```

### 2. Cross-Network Bridges (Optional)
If future use cases require controlled cross-network communication, implement explicit bridge services with:
- Network-pair-specific protocols
- Authentication and authorization
- Rate limiting and validation

### 3. Network Discovery
Consider adding network-level metadata exchange:
- Network capabilities advertisement
- Version compatibility checks
- Migration support for protocol upgrades

## Related Files

### Modified Files
- `packages/fret/src/rpc/protocols.ts` - Protocol factory and constants
- `packages/fret/src/rpc/neighbors.ts` - Protocol parameter support
- `packages/fret/src/rpc/maybe-act.ts` - Protocol parameter support
- `packages/fret/src/rpc/leave.ts` - Protocol parameter support
- `packages/fret/src/rpc/ping.ts` - Protocol parameter support
- `packages/fret/src/service/fret-service.ts` - Network-scoped protocol usage
- `packages/fret/src/index.ts` - FretConfig with networkName
- `packages/db-p2p/src/libp2p-node.ts` - Network-scoped service initialization

### New Files
- `packages/fret/test/network.isolation.spec.ts` - Protocol isolation tests

## Test Coverage

### Property Tests
