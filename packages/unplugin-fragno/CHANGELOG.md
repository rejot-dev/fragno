# @fragno-dev/unplugin-fragno

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
