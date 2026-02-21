----
description: Implement responsibility-driven redirects with responsibilityK=1
dependencies: responsibilityK, repo client
----

With responsibilityK=1, ensure non-coordinators immediately return redirect hints. Repo client should do single-hop follow, cache hint, then operate directly until cache expiry.
