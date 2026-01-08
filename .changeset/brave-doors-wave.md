---
"@fragno-dev/core": patch
---

feat(vue): add `createStore` support to Vue client, matching React client functionality. The
`useFragno` hook now handles `FragnoStoreData` objects created via `client.createStore()` and
transforms them into Vue composables that return reactive store values.
