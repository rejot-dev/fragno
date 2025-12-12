import { createFileRoute } from "@tanstack/react-router";
import { formsFragment } from "@/lib/forms";

export const Route = createFileRoute("/api/forms/$")({
  server: {
    handlers: formsFragment.handlersFor("tanstack-start"),
  },
});
