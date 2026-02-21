----
description: Encode expiration into transaction IDs to create an outer time limit
dependencies: transaction protocol, NetworkTransactor
----

Transactions currently have no outer time bound. Encode an expiration into the transaction ID to create an outer limit, or at least propagate an expiration parameter across the transaction lifecycle. This prevents transactions from hanging indefinitely in edge cases.
