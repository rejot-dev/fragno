import { z } from "zod";

/**
 * Agent names identify an agent's definition and its one ongoing conversation within a scope.
 * Shared because automation routes address agents too, and `pi` already depends on `automation`.
 */
export const piAgentNameSchema = z.lazy(() =>
  z
    .string()
    .regex(
      /^[a-z][a-z0-9-]{0,62}$/,
      "Agent names start with a lowercase letter and contain only lowercase letters, digits, and hyphens.",
    ),
);
