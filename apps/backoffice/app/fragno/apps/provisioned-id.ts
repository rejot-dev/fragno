import { createHash } from "node:crypto";

/**
 * The Backoffice ID of what an app provisioned for one of its own identifiers. Deriving it makes
 * provisioning idempotent without storing the identifier: a repeated call finds what the first one
 * made, and a concurrent one collides on the primary key.
 */
export function provisionedResourceId(input: {
  appId: string;
  kind: "organization" | "project";
  externalId: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.appId}:${input.kind}:${input.externalId}`)
    .digest("hex");
  return `app-${digest.slice(0, 32)}`;
}
