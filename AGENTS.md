* Don't create useless summary documents, or make giant summaries to the user.  Keep the existing project documents up to date.
* Comments should only be non-obvious, and should be timeless (no "added this", etc.)
* Prefix with `_` for unused arguments.
* Enclose `case` blocks in braces if any consts/variables introduced.
* Prefix intentional calls to unused promises (micro-tasks) with `void`.
* ES Modules
* This project uses @.editorconfig.  Summary: Tab indentation,  Single quotes for strings.  Complete configuration in [.editorconfig](mdc:.editorconfig).
* "satisfies" better than casting when possible
* Don't use "any" lazily; only for dynamic typing.  Don't "monkey patch" attributes into objects; use proper types and interfaces.
* Inline imports() only for dynamic loading
* Avoid "swallowing" exceptions; exceptions should be exceptional - use results for expected conditions.
* Prefer expressive over imperative.
* Small, single-purpose functions/methods.  Decompose into separate functions over documented sub-sections - function names document the semantics.

This is an important system; write production-grade, maintainble, and expressive code that we don't have to revisit later.  Read docs/internals.md to quickly come up to speed on contributing - also maintain this document.
