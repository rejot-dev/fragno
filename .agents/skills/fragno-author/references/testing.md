# Testing - distilled

Source: Fragno Docs — Testing

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/testing" -H "accept: text/markdown"`

## Core utilities

- Use `createFragmentForTest` and `withTestUtils` from `@fragno-dev/core/test`.
- Extend the definition with `withTestUtils()` to expose test helpers and deps.

## callRoute()

- `callRoute(method, path, params)` runs a route without a server.
- Returns a discriminated union: `json`, `jsonStream`, `empty`, or `error`.

## Response handling

- `json`: status, headers, and typed data.
- `jsonStream`: async iterator of items.
- `empty`: status only.
- `error`: status and `{ message, code }`.

## Database fragments

- For database-backed fragments, use the database test harness.
