import { backofficeRuntimeScopeFromResolvedScope } from "@/backoffice-runtime/resolved-scope";
import { requireScopeSelection } from "@/layouts/backoffice-shell-request.server";

import type { Route } from "./+types/terminal-command";
import { runBackofficeTerminalAction } from "./terminal.server";

export async function action({ request, context }: Route.ActionArgs) {
  return runBackofficeTerminalAction({
    request,
    context,
    scope: backofficeRuntimeScopeFromResolvedScope(requireScopeSelection(context)),
  });
}
