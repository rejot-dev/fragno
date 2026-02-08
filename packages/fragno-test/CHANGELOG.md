# @fragno-dev/test

## 2.0.0

### Patch Changes

- 3e07799: fix: allow durable hook processing to bypass wrapper adapters and widen drain helpers
- 15e3263: feat(db): require schema names and support namespace-aware SQL naming
- a79e90d: feat: add trace recording support to model checker runs
- 5cef16e: feat(db,test): add SQL outbox support and adapter testing configuration.
- Updated dependencies [f569301]
- Updated dependencies [dbbbf60]
- Updated dependencies [3e07799]
- Updated dependencies [20a98f8]
- Updated dependencies [1902f30]
- Updated dependencies [15e3263]
- Updated dependencies [208cb8e]
- Updated dependencies [33f671b]
- Updated dependencies [fc803fc]
- Updated dependencies [0628c1f]
- Updated dependencies [7e1eb47]
- Updated dependencies [301e2f8]
- Updated dependencies [5f6f90e]
- Updated dependencies [1dc4e7f]
- Updated dependencies [2eafef4]
- Updated dependencies [3c9fbac]
- Updated dependencies [a5ead11]
- Updated dependencies [7d7b2b9]
- Updated dependencies [c4d4cc6]
- Updated dependencies [d4baad3]
- Updated dependencies [548bf37]
- Updated dependencies [a79e90d]
- Updated dependencies [3041732]
- Updated dependencies [7e179d1]
- Updated dependencies [0013fa6]
- Updated dependencies [7c60341]
- Updated dependencies [afb06a4]
- Updated dependencies [53e5f97]
- Updated dependencies [8e9b6cd]
- Updated dependencies [c5fd7b3]
- Updated dependencies [69b9a79]
- Updated dependencies [5cef16e]
  - @fragno-dev/core@0.2.0
  - @fragno-dev/db@0.3.0

## 1.0.2

### Patch Changes

- Updated dependencies [aca5990]
- Updated dependencies [f150db9]
- Updated dependencies [0b373fc]
- Updated dependencies [fe27e33]
- Updated dependencies [9753f15]
  - @fragno-dev/db@0.2.2

## 1.0.1

### Patch Changes

- Updated dependencies [aecfa70]
- Updated dependencies [3faac77]
- Updated dependencies [01a9c6d]
- Updated dependencies [5028ad3]
- Updated dependencies [20d824a]
  - @fragno-dev/db@0.2.1

## 1.0.0

### Patch Changes

- f9ae2d3: fix: database namespace generation
- Updated dependencies [8429960]
- Updated dependencies [4d897c9]
- Updated dependencies [a46b59c]
- Updated dependencies [bc072dd]
- Updated dependencies [e46d2a7]
- Updated dependencies [fcce048]
- Updated dependencies [147bdd6]
- Updated dependencies [f9ae2d3]
- Updated dependencies [f3b7084]
- Updated dependencies [c3870ec]
- Updated dependencies [75e298f]
  - @fragno-dev/db@0.2.0
  - @fragno-dev/core@0.1.11

## 0.1.14

### Patch Changes

- Updated dependencies [aabd6d2]
  - @fragno-dev/core@0.1.10
  - @fragno-dev/db@0.1.15

## 0.1.13

### Patch Changes

- e848208: feat: restrict Unit of Work in service contexts
- 0f4c9fe: fix: move core/db dependencies to peerDependencies
- 7276378: feat: add providesPrivateService method to Fragment definition

  This allows the Fragment author to define private services that are only accessible within the
  Fragment's own code.

- 5ea24d2: refactor: improve Fragment builder and instatiator
- Updated dependencies [d6a7ff5]
- Updated dependencies [e848208]
- Updated dependencies [e9b2e7d]
- Updated dependencies [5e185bc]
- Updated dependencies [ec622bc]
- Updated dependencies [219ce35]
- Updated dependencies [b34917f]
- Updated dependencies [7276378]
- Updated dependencies [462004f]
- Updated dependencies [5ea24d2]
- Updated dependencies [f22c503]
- Updated dependencies [3474006]
  - @fragno-dev/db@0.1.15
  - @fragno-dev/core@0.1.9

## 0.1.12

### Patch Changes

- Updated dependencies [acb0877]
  - @fragno-dev/core@0.1.8
  - @fragno-dev/db@0.1.14

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
