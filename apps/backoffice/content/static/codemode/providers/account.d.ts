// account tools
type AccountCodemodeProvider = {
  /** Read your own Backoffice account profile. */
  me(): Promise<AccountMeOutput>;
  /** Change the display name on your own Backoffice account. */
  profileUpdate(input: AccountProfileUpdateInput): Promise<AccountProfileUpdateOutput>;
  /** List the organizations you belong to and your roles in each. */
  orgsList(): Promise<AccountOrgsListOutput>;
  /** List pending, unexpired organization invitations addressed to your email. */
  invitationsList(): Promise<AccountInvitationsListOutput>;
  /** Accept a pending organization invitation addressed to your email. */
  invitationsAccept(input: AccountInvitationsAcceptInput): Promise<AccountInvitationsAcceptOutput>;
  /** List OAuth applications you have authorized and their granted scopes, using cursor pagination. Never exposes tokens. */
  applicationsList(input: AccountApplicationsListInput): Promise<AccountApplicationsListOutput>;
};
declare const account: AccountCodemodeProvider;

type AccountProfile = {
  userId: string;
  name: string;
  email: string;
  emailVerified: boolean;
  systemRole: "user" | "admin";
};
type OrganizationMembershipRecord = {
  organization: OrganizationRecord;
  roles: string[];
};
type OrganizationRecord = {
  organizationId: string;
  name: string;
  slug: string;
  /** ISO 8601 datetime string. */
  createdAt: string;
};
type AccountInvitationRecord = {
  invitationId: string;
  organization: OrganizationRecord;
  roles: string[];
  /** ISO 8601 datetime string. */
  expiresAt: string;
};
type DirectoryPageInput = {
  pageSize?: number;
  cursor?: string | null;
};
type AccountMeOutput = AccountProfile;
type AccountProfileUpdateInput = {
  name: string;
};
type AccountProfileUpdateOutput = AccountProfile;
type AccountOrgsListOutput = {
  organizations: OrganizationMembershipRecord[];
};
type AccountInvitationsListOutput = {
  invitations: AccountInvitationRecord[];
};
type AccountInvitationsAcceptInput = {
  invitationId: string;
};
type AccountInvitationsAcceptOutput = OrganizationMembershipRecord;
type AccountApplicationsListInput = DirectoryPageInput;
type AccountApplicationsListOutput = {
  consents: {
    id: string;
    clientId: string;
    clientName: string;
    scopes: string[];
    resources: string[];
    requestedUserInfoClaims: string[];
    createdAt: string;
    updatedAt: string;
  }[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
