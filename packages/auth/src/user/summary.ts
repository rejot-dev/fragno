import type { Role, UserSummary } from "../types";

type UserSummaryInput = {
  id: unknown;
  email: string;
  role: string;
  bannedAt?: Date | null;
};

export const mapUserSummary = (user: UserSummaryInput): UserSummary => ({
  id: String(user.id),
  email: user.email,
  role: user.role as Role,
  bannedAt: user.bannedAt ?? null,
});
