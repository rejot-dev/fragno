import { z } from "zod";

import { toExternalId } from "../organization/utils";

export const sessionSeedSchema = z
  .object({
    activeOrganizationId: z.string().trim().min(1).optional(),
  })
  .strict();

export type SessionSeedInput = z.input<typeof sessionSeedSchema>;
export type SessionSeed = z.output<typeof sessionSeedSchema>;
export type ResolvedSessionSeed = {
  status: "accepted" | "ignored" | "repaired";
  requestedActiveOrganizationId: string | null;
  activeOrganizationId: string | null;
};

export function normalizeSessionSeed(session?: SessionSeedInput | null): SessionSeed | null {
  const parsed = sessionSeedSchema.safeParse(session ?? {});
  if (!parsed.success) {
    return null;
  }

  return parsed.data.activeOrganizationId ? parsed.data : null;
}

export function parseSessionSeed(value: unknown): SessionSeed | null {
  const parsed = sessionSeedSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return parsed.data.activeOrganizationId ? parsed.data : null;
}

export function resolveSessionSeedFromMembers<
  TMember extends {
    createdAt: Date;
    organization: {
      id: unknown;
      deletedAt: Date | null;
    } | null;
  },
>(members: TMember[], session?: SessionSeedInput | null): ResolvedSessionSeed {
  const normalizedSession = normalizeSessionSeed(session);
  const requestedActiveOrganizationId = normalizedSession?.activeOrganizationId ?? null;

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

export function parseSessionSeedFromQuery(value: string | null): SessionSeed | null | "invalid" {
  if (value === null) {
    return null;
  }
  if (value === "") {
    return "invalid";
  }

  try {
    const parsed = parseSessionSeed(JSON.parse(value));
    return parsed ?? "invalid";
  } catch {
    return "invalid";
  }
}

export function serializeSessionSeedForQuery(
  session?: SessionSeedInput | null,
): string | undefined {
  const normalized = normalizeSessionSeed(session);
  return normalized ? JSON.stringify(normalized) : undefined;
}
