# Quick Reference Card - Optimystic Testing

## One-Line Commands

```bash
# Build and run quick test
yarn workspace @optimystic/db-p2p build && yarn workspace @optimystic/test-peer build && yarn workspace @optimystic/test-peer test:quick

# Run quick test only
yarn workspace @optimystic/test-peer test:quick

# Run with debug output
DEBUG=optimystic:*,db-p2p:* yarn workspace @optimystic/test-peer test:quick

# Run test suite
yarn workspace @optimystic/test-peer test:node
```

## VS Code Debug Shortcuts

| Configuration | Purpose | Shortcut |
|--------------|---------|----------|
| Debug Quick Test (3-node mesh) | Step-by-step debugging | F5 |
| Debug Test Peer Tests | Test suite debugging | F5 |
| Optimystic: Mesh + Debug Peer | Interactive debugging | F5 |

## Common Breakpoint Locations

```
packages/test-peer/src/cli.ts
  Line ~365: createDiary()
  Line ~380: addEntry()

packages/db-core/src/collections/diary.ts
  append() method
  select() method

packages/db-core/src/transactor/network-transactor.ts
  pend() method
  commit() method

packages/db-p2p/src/storage/storage-repo.ts
  pend() method
  commit() method
```

## Test Files

| File | Purpose | Run Command |
|------|---------|-------------|
| `test/quick-test.ts` | Standalone debug script | `test:quick` |
| `test/distributed-diary.spec.ts` | Automated test suite | `test:node` |

## Ports Used

| Test | Port Range |
|------|-----------|
| Quick Test | 9100-9102 |
| Test Suite | 9000-9002 |
| Mesh Script | 8011+ (configurable) |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Port conflict | Change `BASE_PORT` in test file |
| Tests timeout | Increase `delay()` values |
| Entries not distributed | Check NetworkTransactor is used |
| Build fails | Clean and rebuild all packages |

## Test Verification

Look for this output:
```
📚 Node 1 (port 9100):
   1. Entry from Node 1
   2. Entry from Node 2
   3. Entry from Node 3
   ✅ All entries present
```

## Debug Environment Variables

```bash
# All logs
DEBUG=optimystic:*,db-p2p:*

# Specific subsystems
DEBUG=db-p2p:repo-service,db-p2p:cluster-service

# With libp2p
DEBUG=optimystic:*,libp2p:connection-manager
```

## Build Order

```bash
1. yarn workspace @optimystic/db-core build
2. yarn workspace @optimystic/db-p2p build
3. yarn workspace @optimystic/test-peer build
```

## Quick Edit-Test Loop

```bash
# Make code changes, then:
yarn workspace @optimystic/db-p2p build && \
yarn workspace @optimystic/test-peer build && \
yarn workspace @optimystic/test-peer test:quick
```

## Files Reference

```
📁 Test Implementation
  packages/test-peer/test/quick-test.ts
  packages/test-peer/test/distributed-diary.spec.ts

📁 Configuration
  packages/test-peer/package.json
  .vscode/launch.json

📁 Documentation
  TESTING-GUIDE.md (comprehensive)
  packages/test-peer/test/README.md (test-specific)
  TEST-SETUP-SUMMARY.md (summary)
```

## Success Indicators

✅ Nodes start and connect
✅ Diary created on Node 1
✅ Entries added from each node
✅ All entries visible on all nodes
✅ Storage consistent across nodes
✅ Tests complete without errors




