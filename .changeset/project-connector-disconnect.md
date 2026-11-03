---
"@fragno-dev/project-connector-fragment": patch
---

feat: add `DELETE /connections/by-name`, which deletes a named connection's accounts and requests,
then the accounts at the gateway through a retried durable hook; the `disconnect` client mutator;
and the `onConnectionDeleted` durable hook. Schema version 8 adds the `deletedAccount` table, and a
refresh never binds an account a disconnect deleted.
