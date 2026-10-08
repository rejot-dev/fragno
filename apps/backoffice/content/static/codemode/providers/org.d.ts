// org tools
type OrgCodemodeProvider = {
  /** Read the current organization and your roles in it. */
  get(): Promise<OrgGetOutput>;
  /** Rename the current organization. Requires the owner or admin role. */
  update(input: OrgUpdateInput): Promise<OrgUpdateOutput>;
  /** List members of the current organization with their roles, using cursor pagination. */
  membersList(input: OrgMembersListInput): Promise<OrgMembersListOutput>;
  /** List pending, unexpired invitations to the current organization with their shareable links, using cursor pagination. */
  invitationsList(input: OrgInvitationsListInput): Promise<OrgInvitationsListOutput>;
  /** Invite an email address to the current organization and return a shareable link. Invitations are not emailed. Requires the owner or admin role; only owners may invite owners. */
  invitationsCreate(input: OrgInvitationsCreateInput): Promise<OrgInvitationsCreateOutput>;
};
declare const org: OrgCodemodeProvider;

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
type DirectoryPageInput = {
  pageSize?: number;
  cursor?: string | null;
};
type OrganizationMemberPage = {
  members: OrganizationMemberRecord[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type OrganizationMemberRecord = {
  userId: string;
  name: string;
  email: string;
  roles: string[];
  /** ISO 8601 datetime string. */
  joinedAt: string;
};
type OrganizationInvitationLinkPage = {
  invitations: OrganizationInvitationLink[];
  nextCursor: string | null;
  hasNextPage: boolean;
};
type OrganizationInvitationLink = {
  invitationId: string;
  organizationId: string;
  email: string;
  roles: string[];
  /** ISO 8601 datetime string. */
  expiresAt: string;
  /** ISO 8601 datetime string. */
  createdAt: string;
  url: string;
};
type OrgGetOutput = OrganizationMembershipRecord;
type OrgUpdateInput = {
  name: string;
};
type OrgUpdateOutput = OrganizationRecord;
type OrgMembersListInput = DirectoryPageInput;
type OrgMembersListOutput = OrganizationMemberPage;
type OrgInvitationsListInput = DirectoryPageInput;
type OrgInvitationsListOutput = OrganizationInvitationLinkPage;
type OrgInvitationsCreateInput = {
  email: string;
  roles: ("owner" | "admin" | "member")[];
};
type OrgInvitationsCreateOutput = OrganizationInvitationLink;
