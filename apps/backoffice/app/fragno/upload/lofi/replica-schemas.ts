import { uploadSchema } from "@fragno-dev/upload/schema";

/** The Upload outbox carries only the `file` table, the metadata the file views list. */
export const UPLOAD_REPLICA_SCHEMAS = [{ schema: uploadSchema }];
