// Browser-safe copy of @cloudflare/shell state type constants.
// Keep content/static/codemode/state.d.ts in sync with @cloudflare/shell's STATE_TYPES.
// The package root import currently pulls Node-only modules into browser bundles.
import stateTypes from "../../../content/static/codemode/state.d.ts?raw";

export const STATE_TYPES = stateTypes;
