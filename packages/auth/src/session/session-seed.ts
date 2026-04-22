import { z } from "zod";

import { toExternalId } from "../organization/utils";

export const credentialSeedSchema = z
  .object({
    activeOrganizationId: z.string().trim().min(1).optional(),
  })
  .strict();

export type CredentialSeedInput = z.input<typeof credentialSeedSchema>;
export type CredentialSeed = z.output<typeof credentialSeedSchema>;
export type ResolvedCredentialSeed = {
  status: "accepted" | "ignored" | "repaired";
  requestedActiveOrganizationId: string | null;
  activeOrganizationId: string | null;
};

export function normalizeCredentialSeed(auth?: CredentialSeedInput | null): CredentialSeed | null {
  const parsed = credentialSeedSchema.safeParse(auth ?? {});
  if (!parsed.success) {
    return null;
  }

  return parsed.data.activeOrganizationId ? parsed.data : null;
}

export function parseCredentialSeed(value: unknown): CredentialSeed | null {
  const parsed = credentialSeedSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return parsed.data.activeOrganizationId ? parsed.data : null;
}

export function resolveCredentialSeedFromMembers<
  TMember extends {
    createdAt: Date;
    organization: {
      id: unknown;
      deletedAt: Date | null;
    } | null;
  },
>(members: TMember[], auth?: CredentialSeedInput | null): ResolvedCredentialSeed {
  const normalizedCredential = normalizeCredentialSeed(auth);
  const requestedActiveOrganizationId = normalizedCredential?.activeOrganizationId ?? null;

  if (!requestedActiveOrganizationId) {
    return {
      status: "ignored",
      requestedActiveOrganizationId: null,
      activeOrganizationId: null,
    };
  }

  const validMembers = members
    .filter((member) => member.organization && !member.organization.deletedAt)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  const requestedMember =
    validMembers.find(
      (member) => toExternalId(member.organization!.id) === requestedActiveOrganizationId,
    ) ?? null;
  const repairedMember = requestedMember ?? validMembers[0] ?? null;

  return {
    status: requestedMember ? "accepted" : repairedMember ? "repaired" : "ignored",
    requestedActiveOrganizationId,
    activeOrganizationId: repairedMember ? toExternalId(repairedMember.organization!.id) : null,
  };
}

export function parseCredentialSeedFromQuery(
  value: string | null,
): CredentialSeed | null | "invalid" {
  if (value === null) {
    return null;
  }
  if (value === "") {
    return "invalid";
  }

  try {
    const parsed = parseCredentialSeed(JSON.parse(value));
    return parsed ?? "invalid";
  } catch {
    return "invalid";
  }
}

export function serializeCredentialSeedForQuery(
  auth?: CredentialSeedInput | null,
): string | undefined {
  const normalized = normalizeCredentialSeed(auth);
  return normalized ? JSON.stringify(normalized) : undefined;
}
