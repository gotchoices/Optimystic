description: The peer program's command-line options can't be covered by automated tests, so a flag that is accepted on the command line but silently never reaches the running node can only be caught by a human trying it by hand.
files: packages/reference-peer/src/cli.ts, packages/reference-peer/test/
difficulty: medium
tradeoffs: The CLI entry point works today and its options change rarely, so a maintainer may reasonably judge that hand-running the binary is cheap enough and not worth restructuring the program's startup for.

# Reference-peer CLI options have no automated coverage

## The gap

`packages/reference-peer/src/cli.ts` declares roughly twenty command-line options in one shared
helper, `withCommonPeerOptions` (around line 770). Each option's parsed value has to be threaded by
hand through two more places to have any effect:

1. the `options` parameter type of `PeerSession.startNetwork` (around line 198), and
2. the corresponding field on the `createLibp2pNode({...})` call (around line 380).

Nothing checks that those three lists agree. A flag can be declared, documented in the README, shown
in `--help`, and accepted on the command line while being silently dropped on the floor — the user
sees no error, just a node that ignores what they asked for.

This is not hypothetical: the ticket that added `--announce-addr` / `--append-announce-addr` had to
be verified by launching the built binary by hand and reading its startup output, because there was
no other way to tell whether the flags worked.

## Why it can't be tested today

`cli.ts` calls `program.parse()` unconditionally at the bottom of the module, and mutates
`process.argv` just above it. Importing the module from a test therefore parses *the test runner's*
own arguments and tries to start a node. `withCommonPeerOptions` is also not exported. So there is
no way to get at the option definitions without running the whole program.

The two existing spec files in `packages/reference-peer/test/` cover diary and storage behavior;
neither touches the command line.

## What is wanted

The valuable form of this is a *general* check covering every option at once, not a test per flag —
one test that walks the shared option set and asserts each declared option is actually accepted and
forwarded, so the next flag anyone adds is covered for free. That implies two enabling changes:

- Make the option definitions reachable without running the program (export the shared helper).
- Make importing the module free of side effects, so only running it as a program parses argv and
  starts a node. The published `bin` entry (`dist/src/cli.js`) must keep working when executed
  directly — worth an explicit check, since guarding "am I the entry point?" is easy to get subtly
  wrong on Windows path/URL forms.

Whether the forwarding half can be asserted without standing up a real libp2p node is the open
design question — one option is to let the node-construction call be observed by the test rather
than replaced.
