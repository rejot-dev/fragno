# Config, Dependencies, and Services - distilled

Source: Fragno Docs — Config, Dependencies, and Services

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/features/dependencies-and-services" -H "accept: text/markdown"`

## Core concepts

- Config is the public contract with the fragment user (API keys, options, callbacks).
- Dependencies are server-only objects created with `withDependencies(...)`; they are not bundled
  for the client.
- Services are server-only reusable logic; fragments can provide or require services for
  composition.

## Common patterns

- Build dependencies from config (for example, API clients).
- Use `defineRoutes(definition)` so route handlers get typed access to `config`, `deps`, and
  `services`.
- Create the server instance with
  `instantiate(...).withConfig(...).withRoutes(...).withOptions(...).build()`.

## Service composition

- Base services: `providesBaseService(...)` expose methods directly on `instance.services`.
- Named services: `providesService("name", ...)` group methods under `instance.services.name`.
- Private services: `providesPrivateService("name", ...)` for internal use only.
- Require services from other fragments with `usesService(...)`, optionally marked as optional.

## Database context

- When using the database layer, `db` is available in `withDependencies(...)` and service factories.
- Use the DB context for typed operations without exposing DB internals to the user.
