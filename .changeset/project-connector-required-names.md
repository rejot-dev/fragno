---
"@fragno-dev/project-connector-fragment": minor
---

Make `connectionName` non-null on stored connection requests and connected accounts, and in the
request and account response contracts. Every start has required a name, so no stored row is
expected to be null.

This is a pre-1.0 breaking change: schema version 6 fails to migrate a database that holds a request
or account without a connection name.
