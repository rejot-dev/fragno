# @fragno-dev/core

## 0.1.9

### Patch Changes

- e848208: feat: restrict Unit of Work in service contexts
- 7276378: feat: add providesPrivateService method to Fragment definition

  This allows the Fragment author to define private services that are only accessible within the
  Fragment's own code.

- 5ea24d2: refactor: improve Fragment builder and instatiator
- f22c503: fix: make unit of work available in middleware

## 0.1.8

### Patch Changes

- acb0877: feat: add instantiateFragment helper function

## 0.1.7

### Patch Changes

- 09a1e13: Optional query parameters can now be used with reactive state

## 0.1.6

### Patch Changes

- be1a630: **BREAKING**: `callRoute` now returns type-safe `FragnoResponse<T>` instead of raw
  `Response`

  The `callRoute` method on fragment instances now returns a parsed `FragnoResponse<T>`
  discriminated union instead of a raw `Response`. This provides type-safe access to response data
  without manual JSON parsing.

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

- b2a88aa: Add custom fetcher configuration support for ClientBuilder

  Fragment authors can now provide default fetch configuration when creating clients, and users can
  override or extend these settings. Supports both RequestInit options (credentials, headers, etc.)
  and custom fetch functions.

- a9f8159: feat: introduce `callRoute` API method on instantiated Fragments

  test: the `createFragmentForTest` signature has also changed to accept routes as the second
  parameter, and the test fragment's `callRoute` now uses the same signature as the main API.

- 9d4cd3a: fix: improve typing on callRoute body parameter

## 0.1.5

### Patch Changes

- b6dd67a: Core: changed rawBody in RequestInputContext to be a string
- ec1aed0: Added helper for tanstack-start handlers

## 0.1.4

### Patch Changes

- ca57fac: feat: allow async middleware

## 0.1.3

### Patch Changes

- bef9f6c: feat(testing): add `createFragmentForTest` test helper to easily test API routes defined
  in Fragments
- 711226d: feat(testing): add `createDatabaseFragmentForTest` in new test package that automatically
  sets up a Fragment's database and makes it ready for testing

## 0.1.2

### Patch Changes

- c70de59: Support modifying request body, headers, and parameters in middlewar

## 0.1.1

### Patch Changes

- 4c1c806: Support tree shaking Fragno database dependencies from frontend bundle

## 0.1.0

### Minor Changes

- 74a615c: Added support for creating Fragments with data layer using @fragno-dev/db

## 0.0.7

### Patch Changes

- 1fa71f3: fixed issue where error() in route handlers always result in unknown api error
  client-side
- c1483c6: Support for SolidJS and SolidStart

## 0.0.6

### Patch Changes

- c3ff022: No longer require end-users to install/import @fragno-dev/core when integrating Fragments
  into their application.

## 0.0.5

### Patch Changes

- b9450b1: Run release process after CI

## 0.0.4

### Patch Changes

- 1dae6f9: Update publishing process

## 0.0.3

### Patch Changes

- 604caff: Update publishing process

## 0.0.2

### Patch Changes

- 2052919: Initial Changeset
