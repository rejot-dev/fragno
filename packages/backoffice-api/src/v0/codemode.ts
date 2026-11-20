import { z } from "zod";

export const backofficeCodemodeInputSchema = z.lazy(() =>
  z.strictObject({
    code: z.string().min(1),
    dependencies: z.record(z.string().min(1), z.string().min(1)).optional(),
    // Long-running Pi turns can exceed two minutes while their workflow continues streaming.
    timeout: z.number().int().positive().max(300_000).optional(),
  }),
);

export type BackofficeCodemodeInput = z.infer<typeof backofficeCodemodeInputSchema>;
