# Database Testing - distilled

Source: Fragno Docs — Database Testing

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/database-integration/testing" -H "accept: text/markdown"`

## Test harness

- Use `buildDatabaseFragmentsTest` from `@fragno-dev/test`.
- Configure a test adapter, register fragments, and run migrations automatically.

## Typical flow

- Build the test harness with `.withTestAdapter(...)` and `.withFragment(...)`.
- Use `fragments.<name>.services` or `fragments.<name>.callRoute(...)` to test.
- Call `test.cleanup()` in `afterAll` to close connections and clean up files.
