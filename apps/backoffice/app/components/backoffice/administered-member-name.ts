import type { AdministeredMember } from "@/fragno/auth/contracts";

/** The member's name when they set one, otherwise the address they sign in with. */
export function administeredMemberName(member: AdministeredMember): string {
  return member.name.trim() || member.email;
}
