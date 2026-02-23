----
description: Hello world demo app (messages) exercising the full stack
dependencies: db-core (Tree, Diary, Collection)
----

## Summary

Created `packages/demo` — a simple "messages" app that exercises Tree and Diary collections across the Optimystic stack. Serves as both a smoke test and a reference implementation.

## What was built

### `MessageApp` class (`src/message-app.ts`)
- Wraps a `Tree<string, Message>` for CRUD on messages (keyed by ID)
- Wraps a `Diary<Activity>` for an append-only activity log
- API: `create()`, `addMessage()`, `getMessage()`, `updateMessage()`, `deleteMessage()`, `listMessages()`, `getActivity()`

### Package structure
- `packages/demo/` — new private workspace package
- Dependencies: `@optimystic/db-core` (workspace)
- Follows existing conventions: mocha+chai tests, ts-node ESM, same tsconfig pattern

### Supporting changes
- **db-core**: Added `./test` subpath export to `package.json` exports map, exposing `TestTransactor` for use by other workspace packages
- **root package.json**: Added `clean:demo`, `build:demo`, `test:demo` scripts and wired into aggregate `clean`, `build`, `test` scripts

## Testing

12 tests covering:
- App creation
- Add, retrieve, update, delete messages
- Error cases (non-existent messages)
- Listing multiple messages
- Activity log recording all operations
- Multiple app instances sharing a transactor
- Empty state handling

All tests pass: `yarn test:demo` (12 passing)

## Validation

- `yarn build:demo` compiles without errors
- `yarn test:demo` — 12 passing
- `yarn test:db-core` — 206 passing (no regressions)
- `yarn workspace @optimystic/demo start` — runs the demo script successfully, demonstrating full CRUD + activity log

## Usage

```bash
# Run the demo
yarn workspace @optimystic/demo start

# Run tests
yarn test:demo
```

## Key files
- `packages/demo/src/message-app.ts` — core app class
- `packages/demo/src/run.ts` — CLI demo script
- `packages/demo/test/message-app.spec.ts` — tests
- `packages/db-core/package.json` — added `./test` export
