/**
 * Taken from: pcattori/vite-env-only
 * Original source: https://github.com/pcattori/vite-env-only/blob/45a39e7fb52e9fae4300e95aa51ed0880374f507/src/transform.ts
 * License: MIT
 * Date obtained: September 4 2025
 * Copyright (c) 2024 Pedro Cattori
 */

import { name as pkgName } from "../package.json";

const maybe = <T>(_: T): T | undefined => {
  throw Error(
    [
      `${pkgName}: unreplaced macro`,
      "",
      `Did you forget to add the '${pkgName}' plugin to your Vite config?`,
      "👉 https://github.com/pcattori/vite-env-only#install",
    ].join("\n"),
  );
};

/**
 * On the server, replaced with the value passed in.
 * On the client, replaced with `undefined`.
 */
export const serverOnly$ = maybe;

/**
 * On the client, replaced with the value passed in.
 * On the server, replaced with `undefined`.
 */
export const clientOnly$ = maybe;
