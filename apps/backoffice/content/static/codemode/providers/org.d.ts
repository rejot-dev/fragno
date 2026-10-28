// Current organization: name, members, invitations. Read to rename it, list members, or invite someone.
type OrgCodemodeProvider = {
  /**
   * Read the current organization, your roles in it, and whether you act here as a member or through the organization managing it. List every organization you belong to with account.orgs.list.
   * Requires `org.read`.
   */
  get(): Promise<OrgGetOutput>;
  /**
   * Rename the current organization. Requires the owner or admin role.
   * Requires `org.manage`.
   */
  update(input: OrgUpdateInput): Promise<OrgUpdateOutput>;
  /**
   * List members of the current organization with their roles, using cursor pagination.
   * Requires `org.read`.
   */
  membersList(input: OrgMembersListInput): Promise<OrgMembersListOutput>;
  /**
   * List pending, unexpired invitations to the current organization with their shareable links, using cursor pagination.
   * Requires `org.read`.
   */
  invitationsList(input: OrgInvitationsListInput): Promise<OrgInvitationsListOutput>;
  /**
   * Invite an email address to the current organization and return a shareable link. Invitations are not emailed. Requires the owner or admin role; only owners may invite owners.
   * Requires `org.manage`.
   */
  invitationsCreate(input: OrgInvitationsCreateInput): Promise<OrgInvitationsCreateOutput>;
};
declare const org: OrgCodemodeProvider;

type OrganizationAccessRecord = {
  organization: OrganizationRecord;
  roles: string[];
  /** The organization managing this one, or null when none does. */
  managingOrganization: {
    organizationId: string;
    name: string;
    slug: string;
  } | null;
  /** Whether you act here as a member, or as a member of the managing organization. A member of both acts as a member. */
  through: "membership" | "managing-organization";
};
type OrganizationRecord = {
  organizationId: string;
  name: string;
  slug: string;
  jurisdiction: "eu" | "us" | null;
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
type OrgGetOutput = OrganizationAccessRecord;
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
