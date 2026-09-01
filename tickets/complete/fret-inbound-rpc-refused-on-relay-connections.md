RESOLVED 2026-08-31 - the decision was made and the dependency shipped. FRET filed the fix as
implement/1-bug-inbound-rpc-refused-on-relay-connections (commit dd63b42 there), landed it in
62fe1f3, and published it as v1.0.0-beta.4 (65379e9). Optimystic's packages/db-p2p and
packages/substrate-simulator now depend on ^1.0.0-beta.4, and the local portal resolves to the same
tree, so local dev and published consumers agree for the first time.

Verified: FRET's registerRpcHandler now builds its node.handle options through a private
handleOptions() that bakes in runOnLimitedConnection: true as a constant and omits absent stream
caps instead of passing undefined (which had been overwriting libp2p's 32/64 defaults for outside
callers of the exported seam). Both arms mutation-tested in that repo.

Consequence for release notes: relay reachability is now genuinely end to end - Optimystic answers
over limited connections on all 13 of its registrations, and FRET answers on all five of its
routing protocols, so a relay-only peer can both be reached and be found. That claim was NOT safe to
make before beta.4 shipped.

Filed to complete/ rather than left in the human inbox; nothing here is still awaiting a decision.

----

description: The routing library this project depends on still refuses incoming calls from peers that can only be reached through a relay, so those peers stay half-cut-off even now that Optimystic's own protocols answer them. The one-line fix lives in a different repository, so a human has to decide whether and how to make it.
files: ../Fret/packages/fret/src/rpc/protocols.ts, packages/db-p2p/src/network/register-protocol-handler.ts, package.json
repro: verified
----

# Why this is a human's call, not a ticket the pipeline can work

The code that needs to change is **not in this repository**. It is in `p2p-fret`, a sibling checkout
wired in through a Yarn `portal:` resolution:

```
package.json:16    "p2p-fret": "portal:../Fret/packages/fret"
```

Published consumers of `@optimystic/db-p2p` do not get that portal — they get `p2p-fret ^1.0.0-beta.2`
from npm. So the fix needs a change, a commit, and a release in the other repo before it reaches
anyone outside a local dev tree. That sequencing, and whether it happens at all, is a decision for
whoever owns both repos.

# What is actually wrong

Some peers — phones, browsers, laptops behind a home router — cannot accept incoming network
connections. They are reached indirectly, through a **relay**: a publicly-reachable machine that
passes traffic through on their behalf. libp2p calls such a connection *limited*, and it will not
carry a protocol conversation over one unless **both** sides have explicitly said they accept
relayed traffic for that protocol.

Optimystic's side of this was fixed by the ticket that produced this one: every protocol Optimystic
serves now opts in, on both the calling and the answering side. FRET's side was not. FRET says yes
when it *calls* a relay-only peer, and no when it *answers* one:

| | site | opts in? |
| --- | --- | --- |
| calling out | `../Fret/packages/fret/src/rpc/protocols.ts:719` (`openRpcStream`) | **yes** — `runOnLimitedConnection: true`, with a comment saying it is required for the relayed path |
| answering | `../Fret/packages/fret/src/rpc/protocols.ts:161` (`registerRpcHandler`) | **no** — the options object passes only the two stream caps |

That one registration helper is the single site every FRET protocol registers through, so all five
are affected at once: `neighbors`, `neighbors/announce`, `maybeAct`, `leave`, and `ping`. Those are
FRET's ring-maintenance and routing calls — which is how Optimystic finds which peers hold a given
piece of data. So a relay-only peer can still answer Optimystic's own protocols and remain
effectively unroutable, because nothing can complete the FRET call that would have located it.

**How this was confirmed.** Read directly in both source files at the sites above, and the libp2p
behaviour it depends on was read in libp2p's own source
(`packages/db-p2p/node_modules/libp2p/dist/src/connection.js:170` — the answering side reads back the
options the handler was registered with and refuses if the opt-in is absent). Not reproduced against
a live third-party relay; see *What would confirm it end to end* below.

**Why nobody noticed.** Two reasons compound. First, the refusal happens *after* the protocol has
already been agreed, so the caller's request appears to succeed and is then dropped with no reply —
it looks exactly like a peer that had nothing to say. Second, the relays this repository ships turn
the caps off (`packages/reference-peer/src/cli.ts:389` passes
`{ reservations: { applyDefaultLimit: false } }`), and a relay with no caps produces connections
libp2p does not treat as limited — so the opt-in never gets consulted in this repo's own test and
demo topologies. The defect only appears against a stock or third-party relay.

# The shape of the fix

One options key at one site — `../Fret/packages/fret/src/rpc/protocols.ts:161`, the single
`node.handle(...)` call inside `registerRpcHandler`, which every FRET protocol already routes
through. FRET is already in the good structural shape this fix wants; it simply omits the key.

There is a **second, smaller thing wrong at the same site**, worth doing in the same change. The
options object is written out with both stream caps always present, so when a caller does not set
them it hands libp2p an explicit "no value" rather than leaving them out. libp2p's registrar stores
whatever it is given, spread over its own defaults — so the stored settings end up recording "no
value" where the defaults should have been. It happens to be harmless today because the code that
later reads them treats "no value" as "use the default" anyway, but it is one refactor away from
silently discarding libp2p's defaults. Omit each key when the caller did not supply it, rather than
including it empty. `packages/db-p2p/src/network/register-protocol-handler.ts` in this repo does
exactly that and explains why in a comment, if a worked example is useful.

# What would confirm it end to end

Nothing in either repo's test suite exercises a **capped** relay against FRET, because both use
relays with the caps lifted. To see it: stand up a relay with default settings (or drop the
`{ reservations: { applyDefaultLimit: false } }` override at `packages/reference-peer/src/cli.ts:389`),
put a peer behind it, and watch a FRET routing call to that peer go unanswered — then apply the
one-key change and watch it answer.

# The decision being asked for

1. Should the change land in `../Fret` at all, or is Optimystic expected to stop depending on FRET
   for routing calls to relay-only peers?
2. If it lands: does it need a `p2p-fret` release and a version bump here, or is the portal
   resolution the only consumer that matters right now?
3. Should FRET also grow the structural guard this repo has (a test that fails the build the moment
   a second file registers a handler outside the shared helper)? FRET already has the single-helper
   shape; it has no test pinning it there.
