import { createFormsFragment } from "@fragno-dev/forms";
import { adapter } from "./adapter";

export const formsFragment = createFormsFragment(
  {
    onFormCreated: (form) => {
      console.log("Form created:", form.id);
    },
    onResponseSubmitted: (response) => {
      console.log("Response submitted:", response.id);
    },
  },
  {
    databaseAdapter: adapter,
  },
);
