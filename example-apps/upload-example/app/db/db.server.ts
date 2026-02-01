import { PGlite } from "@electric-sql/pglite";
export const pgFile = process.env["UPLOAD_EXAMPLE_DB"] ?? ("./upload-example.pglite" as const);

let clientInstance: PGlite | undefined;

export function getPgliteClient(): PGlite {
  if (!clientInstance) {
    clientInstance = new PGlite(pgFile);
  }
  return clientInstance;
}
