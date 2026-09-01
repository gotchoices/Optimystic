description: The main transactions document is half a maintained reference and half a frozen proposal from when the feature was first designed, with nothing telling the two apart — so a reader can follow example code that stopped matching the real implementation long ago.
files:
  - docs/transactions.md (2496 lines; maintained prose lines 1-737, frozen design-time material "Key Components" 738 through "Success Criteria" ~1949)
difficulty: medium
tradeoffs: A maintainer may prefer to leave it alone — nobody has been misled loudly enough to notice, the frozen half still records genuinely useful design intent, and adding a banner is cheap only if it is honest about which half is which.
----

# What is wrong

`docs/transactions.md` is the document people are pointed at for how
multi-collection transactions work. Its opening sections are actively
maintained: recent tickets have added and corrected subsections there, and the
project's documentation-citation check passes over it.

From the "Key Components" heading onward, though, the document changes
character without saying so. It presents long TypeScript listings introduced as
"the core transaction structures", plus a phase-by-phase implementation
checklist and a success-criteria list. That material was written while the
feature was being designed, and nothing has kept it current since. It reads
exactly like reference documentation.

Concrete drift, sampled while reviewing an unrelated change:

- The listing for the coordinator's rollback shows a body that simply clears
  every collection's tracker, with a "TODO: in the future we may want to track
  which collections were affected" comment. The real implementation stopped
  doing that several fixes ago; rollback now restores per-collection snapshots
  covering both the staged changes and the queued actions, and getting that
  right was itself the subject of multiple bug tickets.
- The stamp-identifier helper is shown as a plain synchronous function; the
  real one is asynchronous because it hashes.

The failure mode is not that the document is incomplete — it is that a reader
cannot tell which half they are in. Someone reading the maintained part, then
scrolling into the frozen part, has no signal that the ground shifted under
them.

# Why this is filed as one item and not a list of corrections

Correcting the individual listings would fix today's drift and guarantee
tomorrow's: nothing in the workflow keeps design-time example code in step with
the implementation, and nobody should want it to — the implementation has real
source files and real tests for that job.

The durable fix is to make the two halves distinguishable, so future drift
cannot masquerade as reference. Roughly, in increasing order of effort:

- mark the design-time sections as historical, in place, at each heading;
- move them into a separate document (a design record) that the reference links
  to, leaving the reference to describe only what the code does now;
- or delete the listings that source files already cover, keeping only the
  design *reasoning* that the code cannot express.

Which of those to take is the decision this ticket asks for. Whoever picks it up
should also confirm the split point — the sampling above found drift in the
"Key Components" section, but the boundary was not audited section by section,
and some of the later material may still be accurate.

# Not in scope

The maintained prose at the top of the document. It is correct as of this
filing, including the recently added subsection describing how the coordinator
refuses a second open transaction.
