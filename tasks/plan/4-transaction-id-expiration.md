----
description: Encode expiration into transaction IDs to create an outer time limit
dependencies: transaction protocol, NetworkTransactor
----

Transactions currently have no outer time bound. Enforce an expiration into the transaction. This prevents transactions from hanging indefinitely in edge cases.
