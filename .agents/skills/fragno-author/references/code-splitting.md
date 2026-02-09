# Code Splitting - distilled

Source: Fragno Docs — Code Splitting

Full docs:
`curl -L "https://fragno.dev/docs/fragno/for-library-authors/features/code-splitting" -H "accept: text/markdown"`

## Why it exists

- Fragments include server and client code; they must be split at build time.
- Use `@fragno-dev/unplugin-fragno` (required for fragment authors, not end users).

## What the plugin does

- Strips `withDependencies`, `providesService`, and `defineRoute` handlers from the client bundle.
- Tree-shakes unused imports after transformation.
- Server builds currently get no special transformation.

## Install

- `npm install --save-dev @fragno-dev/unplugin-fragno`

## Bundler entry points

- Import from the bundler-specific entry:
  - `/esbuild`, `/rollup`, `/webpack`, `/rspack`, `/farm`, `/vite`, `/nuxt`, `/astro`.

## Multi-target build

- Produce a browser build with entries for each framework client.
- Produce a node/server build for the server entry.
- Ensure `@fragno-dev/core` is bundled in the browser build when using tsdown (do not externalize
  it).

## Package exports

- The main `.` export is server-only.
- Add per-framework `./react`, `./vue`, `./svelte`, `./solid`, `./vanilla` exports with `browser` +
  `types`.
- Keep framework libraries in `peerDependencies` so they are not bundled.
