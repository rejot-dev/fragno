---
"@fragno-dev/core": patch
"@fragno-dev/test": patch
---

**BREAKING**: `callRoute` now returns type-safe `FragnoResponse<T>` instead of raw `Response`

The `callRoute` method on fragment instances now returns a parsed `FragnoResponse<T>` discriminated
union instead of a raw `Response`. This provides type-safe access to response data without manual
JSON parsing.

**Migration:**

Preferably use the new type-safe response:

```diff
- const response = await fragment.callRoute("GET", "/users");
- const data = await response.json();
+ const response = await fragment.callRoute("GET", "/users");
+ if (response.type === "json") {
+   const data = response.data; // fully typed!
+ }
```

- or -

Switch to `callRouteRaw` if you need the raw response:

```diff
- const response = await fragment.callRoute("GET", "/users");
+ const response = await fragment.callRouteRaw("GET", "/users");
```
