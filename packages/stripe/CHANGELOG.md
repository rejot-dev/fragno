# @fragno-dev/stripe

## 0.1.2

### Patch Changes

- 2112922: fix: client bundle generation issues

## 0.1.1

### Patch Changes

- Updated dependencies [aabd6d2]
  - @fragno-dev/core@0.1.10
  - @fragno-dev/db@0.1.15

## 0.1.0

### Minor Changes

- 477878a: Added useBillingPortal hook
- e70fce5: The API no longer assumes one subscription per customer

### Patch Changes

- a2f5eb6: Calling /upgrade on a subscription set to cancel at the end of the billing period will
  un-cancel that subscription
- 155b16c: added promotion code to /subscription/upgrade
- 25fa7b7: do not add async_hooks in client bundle
- 5ea24d2: refactor: improve Fragment builder and instatiator
- 09fbae3: Taking creation date from stripe for subscriptions
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

## 0.0.2

### Patch Changes

- 74ed8bb: Introducing Stripe fragment for managing subscriptions
