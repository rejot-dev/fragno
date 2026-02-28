# @fragno-dev/unplugin-fragno

## 0.0.9

### Patch Changes

- 4d141f8: fix: remove development exports from published packages
- ae54a60: fix: add browser-safe db entry and rewrite sync command imports for browser builds
- 9c3c647: fix: keep sync handlers and service bodies in browser builds
- 8a73813: fix: strip provideHooks during client transforms
- a75b0c2: fix: preserve db/schema definitions in browser transforms

## 0.0.8

### Patch Changes

- 15e3263: feat(db): require schema names and support namespace-aware SQL naming

## 0.0.7

### Patch Changes

- 2112922: fix: client bundle generation issues

## 0.0.6

### Patch Changes

- aabd6d2: fix: client bundle generation issues

## 0.0.5

### Patch Changes

- d78940e: fix: make sure @fragno-dev/db is properly tree shaken from browser bundles
- 5ea24d2: refactor: improve Fragment builder and instatiator

## 0.0.4

### Patch Changes

- 5e8c3c0: Client builds now replace `defineFragmentWithDatabase` with `defineFragment` and remove
  `.withDatabase()` calls, reducing bundle size by eliminating server-only database code.

## 0.0.3

### Patch Changes

- c6bc4c7: fix: issue in some cases where database schema wasn't properly erased in the client
  bundle

## 0.0.2

### Patch Changes

- 4c1c806: Support tree shaking Fragno database dependencies from frontend bundle
