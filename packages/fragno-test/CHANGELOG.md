# @fragno-dev/test

## 0.1.11

### Patch Changes

- Updated dependencies [09a1e13]
  - @fragno-dev/core@0.1.7
  - @fragno-dev/db@0.1.13

## 0.1.10

### Patch Changes

- Updated dependencies [b54ff8b]
  - @fragno-dev/db@0.1.13

## 0.1.9

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

- e99ef47: feat: expose `db` object to run queries directly in tests
- Updated dependencies [be1a630]
- Updated dependencies [b2a88aa]
- Updated dependencies [2900bfa]
- Updated dependencies [059a249]
- Updated dependencies [f3f7bc2]
- Updated dependencies [a9f8159]
- Updated dependencies [9d4cd3a]
- Updated dependencies [fdb5aaf]
  - @fragno-dev/core@0.1.6
  - @fragno-dev/db@0.1.12

## 0.1.8

### Patch Changes

- Updated dependencies [b6dd67a]
- Updated dependencies [ec1aed0]
- Updated dependencies [9a58d8c]
  - @fragno-dev/core@0.1.5
  - @fragno-dev/db@0.1.11

## 0.1.7

### Patch Changes

- Updated dependencies [ca57fac]
  - @fragno-dev/core@0.1.4
  - @fragno-dev/db@0.1.10

## 0.1.6

### Patch Changes

- Updated dependencies [ad3e63b]
  - @fragno-dev/db@0.1.10

## 0.1.5

### Patch Changes

- 7445a73: feat: Added support for testing using different adapters
- Updated dependencies [8fcceb6]
  - @fragno-dev/db@0.1.9

## 0.1.4

### Patch Changes

- Updated dependencies [f3cdb1d]
  - @fragno-dev/db@0.1.8

## 0.1.3

### Patch Changes

- Updated dependencies [e36dbcd]
- Updated dependencies [ab6c4bf]
- Updated dependencies [d1feecd]
  - @fragno-dev/db@0.1.7

## 0.1.2

### Patch Changes

- 6fd2528: feat(testing): add resetDatabase method to test Fragment instance
- Updated dependencies [70bdcb2]
  - @fragno-dev/db@0.1.6

## 0.1.1

### Patch Changes

- 711226d: feat(testing): add `createDatabaseFragmentForTest` in new test package that automatically
  sets up a Fragment's database and makes it ready for testing
- Updated dependencies [8b2859c]
- Updated dependencies [bef9f6c]
- Updated dependencies [711226d]
  - @fragno-dev/db@0.1.5
  - @fragno-dev/core@0.1.3
