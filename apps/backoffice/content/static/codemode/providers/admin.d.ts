// admin tools
type AdminCodemodeProvider = {
  /** Create an organization and assign its owner. */
  organisationCreate(input: AdminOrganisationCreateInput): Promise<AdminOrganisationCreateOutput>;
  /** Add a user to an organization with explicit roles. */
  organisationMembersAdd(
    input: AdminOrganisationMembersAddInput,
  ): Promise<AdminOrganisationMembersAddOutput>;
  /** Remove a user from an organization. */
  organisationMembersRemove(
    input: AdminOrganisationMembersRemoveInput,
  ): Promise<AdminOrganisationMembersRemoveOutput>;
};
declare const admin: AdminCodemodeProvider;

type AdminOrganisationCreateInput = {
  name: string;
  slug: string;
  ownerEmail: string;
};
type AdminOrganisationCreateOutput = {
  organizationId: string;
  name: string;
  slug: string;
  ownerUserId: string;
};
type AdminOrganisationMembersAddInput = {
  organizationSlug: string;
  userEmail: string;
  roles: string[];
};
type AdminOrganisationMembersAddOutput = {
  organizationId: string;
  userId: string;
  roles: string[];
};
type AdminOrganisationMembersRemoveInput = {
  organizationSlug: string;
  userEmail: string;
};
type AdminOrganisationMembersRemoveOutput = {
  organizationId: string;
  userId: string;
  roles: string[];
};
