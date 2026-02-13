export type Role = "user" | "admin";

export interface UserSummary {
  id: string;
  email: string;
  role: Role;
  bannedAt: Date | null;
}
