import { createFormsClient } from "@fragno-dev/forms/react";

export type FormsClient = ReturnType<typeof createFormsClient>;

export const formsClient: FormsClient = createFormsClient();
