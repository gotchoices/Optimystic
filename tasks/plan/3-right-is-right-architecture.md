----
description: New architecture where a "correct" minority can still win
----

This needs lots of details worked out, and possibly multiple rounds of planning/design, but the gist is:
* If a minority of nodes are out-voted when it comes to the correctness of a transaction, they can present proof to a wider audience to: a) cause a re-vote; and b) cast suspicion on the wrong majority.
* If the minority is wrong, they *they* are the ones who are ostracized, not the majority.
* If this is a result of a problemmatic engine, the node learns this and can report being "unhealthy"
* If validity is in dispute, the client should know that final resolution may not be had, since the transaction in question might be invalidated.
