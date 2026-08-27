import { createFormsClient } from "@fragno-dev/forms/react";

export type FormsClient = ReturnType<typeof createFormsClient>;

/** Browser client for the system-scoped Forms fragment API. */
export const formsClient: FormsClient = createFormsClient({ mountRoute: "/api/forms" });
