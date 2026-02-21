----
description: Resolve case for concurrent collection creation
dependencies: collection creation logic
----

There is an unresolved case when multiple peers attempt to create the same collection concurrently. This needs investigation to determine the failure mode and a fix to ensure deterministic resolution.
