export function sortOrganizationsByPreference<
  TOrganization extends { organization: { id: string } },
>(organizations: TOrganization[], preferredOrganizationId: string | null) {
  if (!preferredOrganizationId) {
    return organizations;
  }

  return [
    ...organizations.filter((entry) => entry.organization.id === preferredOrganizationId),
    ...organizations.filter((entry) => entry.organization.id !== preferredOrganizationId),
  ];
}
