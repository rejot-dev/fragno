import { z } from "zod";

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logoUrl: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

export const memberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  roles: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const invitationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  email: z.string(),
  roles: z.array(z.string()),
  status: z.enum(["pending", "accepted", "rejected", "canceled", "expired"]),
  token: z.string(),
  inviterId: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
  respondedAt: z.string().nullable(),
});

export const invitationSummarySchema = invitationSchema.omit({ token: true });
