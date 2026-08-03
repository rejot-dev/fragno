import { schema } from "@fragno-dev/db/schema";

export const piSchema = schema("pi-harness", (s) =>
  s.noOp("store Pi session metadata in workflow instance params"),
);
