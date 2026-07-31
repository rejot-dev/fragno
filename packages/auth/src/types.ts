export type Role = "user" | "admin";

export type AuthServiceMutationOptions = {
  emitHooks?: boolean;
};

export interface UserSummary {
  id: string;
  email: string;
  role: Role;
  bannedAt: Date | null;
}
