# @optimystic/demo

Hello-world demo app exercising the full Optimystic stack. A small "messages"
application that adds, lists, updates, and deletes records through Optimystic
collections, then prints an activity log — a runnable smoke test of the
end-to-end read/write/commit path.

This package is private (not published); it exists as a worked example and a
sanity check that the core stack operates.

## What it demonstrates

- Building a small app (`MessageApp`) on top of `@optimystic/db-core`
  collections.
- Add / list / update / delete against a transactor, plus an activity log.
- Running the whole flow in-process against `TestTransactor` (from
  `@optimystic/db-core/test`) — no network or persistent storage required.

## Run

```bash
yarn start
```

`start` runs `src/run.ts`, which drives `MessageApp` end-to-end and logs each
step to the console (see `src/run.ts` and `src/message-app.ts`).
