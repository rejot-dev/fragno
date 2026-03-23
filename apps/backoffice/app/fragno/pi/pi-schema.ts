import { Type } from "typebox";

import { withSinclairSchema } from "./typebox-compat";

export const bashParametersSchema = withSinclairSchema(
  Type.Object({
    script: Type.String({
      minLength: 1,
      description: "Shell script or command to execute in the sandboxed environment.",
    }),
    cwd: Type.Optional(
      Type.String({ description: "Optional working directory within the virtual filesystem." }),
    ),
  }),
);
