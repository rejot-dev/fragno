/*
 * The prompt — Cadence's primary input surface.
 *
 * It has two modes: `compose` (plain language) and `dev` (a real bash terminal
 * against the Pi filesystem, the same runtime the backoffice dashboard terminal
 * uses). This component is just the input row; the execution output it produces
 * is rendered separately by `<PromptOutput>`, the large block above it.
 *
 * Both pieces share the session in `PromptProvider`, so a page wires them up as
 * siblings:
 *
 *   <PromptProvider organizationId={...} organizationName={...} onConduct={...}>
 *     <PromptOutput />   // large output block on top
 *     ...
 *     <Prompt />         // input, pinned at the bottom
 *   </PromptProvider>
 */

import { PromptComposer } from "./composer/prompt-composer";
import { DevInput } from "./dev/dev-input";
import { usePrompt } from "./prompt-context";

export function Prompt() {
  const { mode } = usePrompt();
  return mode === "dev" ? <DevInput /> : <PromptComposer />;
}
