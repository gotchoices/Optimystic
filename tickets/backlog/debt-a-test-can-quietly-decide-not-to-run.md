description: A test is allowed to look at the network it just built and decide, at that moment, that conditions are not right and quietly excuse itself — and a test that excused itself looks exactly like a test that passed. Add an automatic check that stops anyone from writing that kind of test again.
files: packages/db-p2p/test/dial-options-single-site.spec.ts (the guard pattern to copy), packages/db-p2p/test/testing-entry-runtime-deps.spec.ts (the same pattern, older), packages/db-p2p/test (the 13 skip sites the guard would walk)
difficulty: medium
tradeoffs: One instance in this package's history is thin evidence for a permanent guard, and a rule this blunt could one day get in the way of a test that legitimately needs to check something about the machine it is running on rather than an environment variable.
----

# A test should not be able to excuse itself based on what it observes

## The problem this prevents

Mocha lets a test call `this.skip()` at any point, including halfway through, after it has already built things and looked at them. When it does, the run reports the test as *pending*, and a summary line reading `31 passing, 1 pending` is the same line you get when a test is pending for a perfectly ordinary reason. Nobody reads past it. So a test that quietly stopped running can sit in a green suite indefinitely while the behaviour it was written to protect rots.

That is not hypothetical here. `packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts` — the only test covering a write whose second acknowledgement has to travel through an intermediary node — built its three nodes, looked at how the network had arranged itself, and excused itself when the arrangement was unfavourable. Measured at **3 self-excusals in 45 consecutive runs** on an unchanged codebase. It was fixed by `debt-relay-cohort-spec-skips-itself-on-unlucky-layout`: the unfavourable arrangement was made impossible by construction, and the remaining check now fails loudly instead of excusing itself.

## The distinction that matters

There is a legitimate reason to skip and an illegitimate one, and they are mechanically distinguishable.

**Legitimate — the decision is made from configuration, before anything is built.** "This suite only runs when someone sets `OPTIMYSTIC_INTEGRATION=1`, because it opens real sockets." The condition reads an environment variable and nothing else. It is the same answer on every run of a given command, so a reader who knows which command they ran knows exactly which tests ran. All thirteen remaining skips in `packages/db-p2p/test` are of this kind, and they must stay allowed. The in-flight `dcutr-holepunch-nat-attribution-harness` ticket also depends on this kind continuing to work.

**Illegitimate — the decision is made from something the test observed after starting.** "I built the network, I looked at it, I did not like what I saw, I am leaving." The condition depends on run-time state, so the same command gives different coverage on different runs, and nothing in the output says which one you got.

## What resolving this should establish

A check that runs as part of the normal test suite and fails when a test file contains a skip whose condition depends on anything other than configuration read before the test body does its work. It should name the offending file and line, and say what the author should do instead: make the unfavourable condition impossible, or let the check fail loudly with a message naming what never became true.

This package already does exactly this kind of structural checking twice — `dial-options-single-site.spec.ts` and `testing-entry-runtime-deps.spec.ts` both walk the source files and assert a rule about their shape, and both exist because the failure mode they guard is silent. This would be the third, guarding the same silent-failure shape one level up, in the tests themselves.

## Things to get right

- **The thirteen existing skips must all still pass.** They are the specification of "legitimate" — if the check rejects any of them, the rule is drawn wrong.
- **Scope.** The tests under `packages/db-p2p/test` are the evidence base. Whether to extend the walk to `quereus-plugin-optimystic` and the other packages is worth deciding when the rule is written, not assumed here.
- **A statically-disabled test (`it.skip(...)` written into the source) is a different thing** and is not what this is about. Those are visible in the source, greppable, and this repository already has a convention of tagging them with the ticket that will re-enable them. Leave them alone.
- **The escape hatch.** If a genuinely legitimate case turns up that the rule rejects, the right response is an explicit, commented, reviewed exception in the check — not weakening the rule. The whole value here is that the failure mode is silence, so the check should err loud.
