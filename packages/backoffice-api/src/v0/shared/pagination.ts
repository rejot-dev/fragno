import { z } from "zod";

/** Directory cursors are bound to one listing and page size; resume with the same page size. */
export const directoryPageInputSchema = z
  .strictObject({
    pageSize: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).nullable().default(null),
  })
  .meta({ id: "DirectoryPageInput" });
export type DirectoryPageInput = z.output<typeof directoryPageInputSchema>;
