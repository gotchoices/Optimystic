description: Two follow-ups a person has to do outside this repository now that the broken broadcast service was removed — reply to the bug reporter on GitHub, and make sure the removal shows up in the next release notes.
files:
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/package.json
  - docs/releasing.md
----

# Two human follow-ups after the `pubsub` service removal

The code change is done and reviewed. What remains is communication outside this repository, which
an agent should not do on someone's behalf.

## Background in one paragraph

Every Optimystic peer used to register a message-broadcast service (`pubsub`, backed by the
`@chainsafe/libp2p-gossipsub` library). That library's newest published release is built for an
older major version of the networking library this project uses, so the service could never
actually deliver a message — it looked healthy and silently dropped everything. Nothing in this
project used it, so it was removed rather than repaired. There is no fixed version to upgrade to.

## Arm 1 — reply on the public bug report

A user (`aarashrestha`) reported this as issue #9 on `gotchoices/Optimystic`. Nobody has replied.
The reply should confirm the diagnosis, say that the newest published version of the broadcast
library (14.1.2) is still built against the older interface so there is nothing to upgrade to, and
say that the service has been removed rather than left in place silently failing.

## Arm 2 — make the removal visible in release notes

`@optimystic/db-p2p` is published to a package registry (currently version 0.24.2). A consumer that
read `node.services.pubsub` used to get an object that silently dropped every message; it now gets
`undefined`. That is strictly more diagnosable, but it is still a change in the shape of the
published service map and someone upgrading deserves to see it called out.

Release notes are generated from commit history (`docs/releasing.md` step 4 runs
`gh release create v{version} --generate-notes`), and the commits for this work carry the standard
ticket-stage subject lines with no breaking-change marker — the agent runner writes those messages,
so this could not be added from inside the ticket pipeline. Whoever cuts the next release should add
a line naming the removed `services.pubsub` key, either by amending history before tagging or by
editing the generated notes.

Worth knowing: this is a runtime-shape change only. The service map was never exposed through a
published TypeScript type that named `pubsub`, so no consumer gets a compile error — which is
exactly why the release note matters.
