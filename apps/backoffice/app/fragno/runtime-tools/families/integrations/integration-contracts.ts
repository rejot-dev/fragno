import {
  integrationSetupCheckSchema,
  integrationSetupSubmissionSchema,
} from "@fragno-dev/backoffice-api/v0/integrations";
import { z } from "zod";

const integrationSetupOperationSchema = z.discriminatedUnion("kind", [
  integrationSetupCheckSchema,
  integrationSetupSubmissionSchema,
]);

/** Setup operations distinguish checking from submission without treating JSON null as missing input. */
export type IntegrationSetupOperation = z.output<typeof integrationSetupOperationSchema>;
